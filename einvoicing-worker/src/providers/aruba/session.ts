/**
 * Aruba sessions: the access and refresh tokens of each hub, kept **in memory only** (never stored, never logged: they are
 * {@link Secret}s), and the sign-ins that make them.
 *
 * - A token is reused until five minutes before it expires (`expires_in` is 1800 s). Then the refresh token is used when
 *   it is still valid (60 minutes from issue), otherwise the password; a refused refresh falls back to the password.
 * - Every sign-in, refresh or not, takes its turn on the persistent per-IP limiter `ip:aruba:auth` (Aruba allows one a
 *   minute per IP, shared by every account), and the account is read again right before it (`registry.get(hub, { fresh: true })`),
 *   so a disabled or changed account is never signed in.
 * - Concurrent calls for one hub share one sign-in.
 * - Aruba refusing the password (`invalid_grant`) pauses the hub, **persistently** (limiter key `account:<hub>:auth`, so a
 *   restart does not retry at once): 5, then 30, then 120 minutes on every consecutive refusal, reset by a successful
 *   sign-in; nothing is sent to Aruba meanwhile. Fixing the account does not lift a pause already set.
 *
 * @module
 */
import type { AccountRegistry } from '../../accounts/registry.ts';
import { accountKey, ipKey } from '../../engine/pacing.ts';
import { COOLDOWN_ONLY } from '../../limits/limiters.ts';
import type { LimitRule, Limiters } from '../../limits/limiters.ts';
import type { Logger } from '../../logger.ts';
import { Secret } from '../../secret.ts';
import { exchange } from './http.ts';
import type { ArubaHttpError } from './http.ts';
import { INVALID_GRANT_STEPS_MS, MAX_EXPIRES_IN_S, MAX_SLOT_WAIT_MS, REFRESH_VALIDITY_MS, SMALL_RESPONSE_BYTES, TOKEN_MARGIN_MS, TOKEN_PATTERN } from './settings.ts';
import type { ArubaHosts } from './settings.ts';
import { takeSlot } from './slots.ts';
import { isRecord, parseJson } from './text.ts';

/** The result of asking for a token. */
export type Authorization =
  | { readonly kind: 'token'; readonly token: Secret }
  /** No token now: who must wait (`ip`: every account, `account`: this one), for how long and why. */
  | { readonly kind: 'wait'; readonly scope: 'ip' | 'account'; readonly afterMs: number; readonly code: string };

/** The sessions of the hubs. */
export interface Sessions {
  /**
   * A valid access token for a hub, signing in (or refreshing) when needed.
   *
   * @param hub The hub.
   * @param signal Aborted when the lease is lost or the worker stops.
   * @returns The token, or who must wait.
   * @throws {FencedError} When a newer lease epoch owns the sign-in limiter.
   */
  authorize(hub: string, signal: AbortSignal): Promise<Authorization>;
  /** Drops the access token of a hub (Aruba answered `401`): the next call refreshes it. */
  dropAccessToken(hub: string): void;
  /** Drops everything of a hub (tokens, pause): its account was disabled, removed or changed. */
  forget(hub: string): void;
}

/** What {@link createSessions} needs. */
export interface SessionDeps {
  readonly hosts: ArubaHosts;
  readonly fetch: typeof fetch;
  readonly registry: Pick<AccountRegistry, 'get'>;
  readonly limiters: Limiters;
  /** The sign-in rule of the provider (`limits.ip.auth`). */
  readonly rule: LimitRule;
  /** Timeout of the sign-in request. */
  readonly timeoutMs: number;
  readonly logger: Logger;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface Tokens {
  readonly access: Secret;
  /** When the access token expires. A dropped token has 0. */
  accessUntil: number;
  readonly refresh: Secret | undefined;
  readonly refreshUntil: number;
}

interface HubSession {
  tokens: Tokens | undefined;
  inflight: Promise<Authorization> | undefined;
}

const AUTH_KEY = ipKey('aruba', 'auth');
const RATE_LIMITED_WAIT_MS = 65_000;
const UNAVAILABLE_WAIT_MS = 60_000;
const UNUSABLE_ACCOUNT_WAIT_MS = 60_000;

const wait = (scope: 'ip' | 'account', afterMs: number, code: string): Authorization => ({ kind: 'wait', scope, afterMs, code });

/** Reads a sign-in answer; `undefined` when it is not what Aruba documents. */
function readTokens(text: string, now: number, previous: Tokens | undefined): Tokens | undefined {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return undefined;
  }
  const { access_token: access, expires_in: expiresIn, refresh_token: refresh } = parsed.value;
  const valid = (token: unknown): token is string => typeof token === 'string' && TOKEN_PATTERN.test(token);
  if (!valid(access) || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || (refresh !== undefined && !valid(refresh))) {
    return undefined;
  }
  // A refresh token that comes back unchanged keeps its original expiry: renewing the access token does not extend it.
  const unchanged = refresh !== undefined && previous?.refresh?.reveal() === refresh;
  return {
    access: new Secret(access),
    accessUntil: now + Math.min(expiresIn, MAX_EXPIRES_IN_S) * 1000,
    refresh: refresh === undefined ? undefined : new Secret(refresh),
    refreshUntil: unchanged ? (previous as Tokens).refreshUntil : now + REFRESH_VALIDITY_MS,
  };
}

/**
 * Creates the sessions.
 *
 * @param deps Hosts, `fetch`, registry, limiters, logger and clock.
 * @returns The sessions.
 */
export function createSessions(deps: SessionDeps): Sessions {
  const { hosts, registry, limiters, rule, logger, clock } = deps;
  const sessions = new Map<string, HubSession>();

  const sessionOf = (hub: string): HubSession => {
    const existing = sessions.get(hub);
    if (existing !== undefined) {
      return existing;
    }
    const created: HubSession = { tokens: undefined, inflight: undefined };
    sessions.set(hub, created);
    return created;
  };

  /** One sign-in with the given form. `refused` means Aruba rejected the grant. */
  const signIn = async (hub: string, session: HubSession, form: Record<string, string>, signal: AbortSignal): Promise<Authorization | 'refused'> => {
    const refusal = await takeSlot(deps, AUTH_KEY, rule, MAX_SLOT_WAIT_MS, signal);
    if (refusal !== undefined) {
      // An abort (the lease is lost) is no reason to hold the IP back: only this account's call waits a moment.
      return refusal.code === 'ABORTED' ? wait('account', refusal.afterMs, 'ABORTED') : wait('ip', refusal.afterMs, 'AUTH_LIMITED');
    }
    let response;
    try {
      response = await exchange(
        { fetch: deps.fetch, signal },
        {
          method: 'POST',
          url: `${hosts.auth}/auth/signin`,
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams(form).toString(),
          timeoutMs: deps.timeoutMs,
          maxBytes: SMALL_RESPONSE_BYTES,
        },
      );
    } catch (error) {
      logger.warn('the Aruba sign-in did not complete', { hub, failure: (error as ArubaHttpError).code });
      return wait('ip', UNAVAILABLE_WAIT_MS, 'AUTH_UNAVAILABLE');
    }
    if (response.status === 400 || response.status === 401) {
      return 'refused';
    }
    if (response.status === 429) {
      await limiters.coolDown(AUTH_KEY, clock() + RATE_LIMITED_WAIT_MS);
      return wait('ip', RATE_LIMITED_WAIT_MS, 'AUTH_RATE_LIMITED');
    }
    const tokens = response.status === 200 ? readTokens(response.text, clock(), session.tokens) : undefined;
    if (tokens === undefined) {
      logger.warn('the Aruba sign-in was not understood', { hub, status: response.status });
      return wait('ip', UNAVAILABLE_WAIT_MS, 'AUTH_UNAVAILABLE');
    }
    if (sessions.get(hub) !== session) {
      return wait('account', 1_000, 'ACCOUNT_CHANGED');
    }
    session.tokens = tokens;
    await limiters.resetBackoff(accountKey(hub, 'auth'));
    return { kind: 'token', token: tokens.access };
  };

  const authenticate = async (hub: string, session: HubSession, signal: AbortSignal): Promise<Authorization> => {
    const account = await registry.get(hub, { fresh: true });
    if (account === undefined) {
      return wait('account', UNUSABLE_ACCOUNT_WAIT_MS, 'ACCOUNT_UNUSABLE');
    }
    const tokens = session.tokens;
    if (tokens?.refresh !== undefined && tokens.refreshUntil > clock()) {
      const refreshed = await signIn(hub, session, { grant_type: 'refresh_token', refresh_token: tokens.refresh.reveal() }, signal);
      if (refreshed !== 'refused') {
        return refreshed;
      }
      session.tokens = undefined;
    }
    const signedIn = await signIn(hub, session, { grant_type: 'password', username: account.username, password: account.password.reveal() }, signal);
    if (signedIn !== 'refused') {
      return signedIn;
    }
    const pauseMs = await limiters.backoff(accountKey(hub, 'auth'), INVALID_GRANT_STEPS_MS, 0, clock());
    logger.error('Aruba refused the credentials of the hub: it is paused until a person fixes the account', { hub, code: 'invalid_grant', pauseMs });
    return wait('account', pauseMs, 'AUTH_INVALID_GRANT');
  };

  return {
    async authorize(hub, signal) {
      const session = sessionOf(hub);
      const now = clock();
      const paused = limiters.gate(accountKey(hub, 'auth'), COOLDOWN_ONLY, now).at - now;
      if (paused > 0) {
        return wait('account', paused, 'AUTH_INVALID_GRANT');
      }
      if (session.tokens !== undefined && session.tokens.accessUntil - TOKEN_MARGIN_MS > now) {
        return { kind: 'token', token: session.tokens.access };
      }
      session.inflight ??= authenticate(hub, session, signal).finally(() => {
        session.inflight = undefined;
      });
      return await session.inflight;
    },
    dropAccessToken(hub) {
      const tokens = sessions.get(hub)?.tokens;
      if (tokens !== undefined) {
        tokens.accessUntil = 0;
      }
    },
    forget(hub) {
      sessions.delete(hub);
    },
  };
}
