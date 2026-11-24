import type { Request, RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import type { ActivityActor, ActivityLog } from '../activity-log/activity-log.ts';
import { responseActorOf } from '../activity-log/actor.ts';
import type { Logger } from '../logging/logger.ts';
import { AppError } from '../http/errors.ts';
import type { RateLimiter } from './rate-limit/rate-limiter.ts';
import type { SecurityPolicyProvider } from './security-policy.ts';

/** Why a request of a user does not look like one made by a browser: the closed set of reasons of the signal. */
export const NON_BROWSER_REASONS = Object.freeze(['noOrigin', 'foreignOrigin', 'inconsistentFetchMetadata'] as const);

/** A reason of {@link NON_BROWSER_REASONS}. */
export type NonBrowserReason = (typeof NON_BROWSER_REASONS)[number];

/** Longest `User-Agent` kept in the event. */
export const MAX_USER_AGENT_LENGTH = 120;

/** One signal per user and reason every day (a day, in seconds). */
const DAY_SECONDS = 86_400;

/** An hour, in seconds. */
const HOUR_SECONDS = 3600;

/** The bucket of the counter that caps, per user, the events of the refreshes refused by the block. */
export const REFRESH_REFUSED_BUCKET = 'non-browser-refresh:user';

/** Most `auth.refreshFailed` events (reason `browserRequired`) written for one user in an hour: the refusal stays, the event is not written beyond it. */
export const REFRESH_REFUSED_EVENTS_PER_HOUR = 10;

/** The bucket of the counter that spaces the events out. */
export const NON_BROWSER_BUCKET = 'non-browser:user';

/** The `Sec-Fetch-Mode` values of a script of the SPA (`fetch` or `XMLHttpRequest`): cross-origin (`cors`) or same-origin. */
const SCRIPT_MODES: ReadonlySet<string> = new Set(['cors', 'same-origin']);

/** Every value `Sec-Fetch-Site` may have; anything else is not a browser. */
const FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'same-site', 'cross-site', 'none']);

/**
 * Judges a request of an authenticated user: does it look like a call of the backoffice, made by a browser? The result is a SIGNAL, never a control: every header read here can be sent by a script, so it
 * only brings out the naive use of the backoffice credentials from another program. It reads headers and the method only (nothing of the body, no other header) and never changes the outcome of a request.
 *
 * The rule, in order:
 * 1. `Origin` present: it must be one of the allowed origins, compared exactly (as the CORS middleware does), or the browser must say the request is `Sec-Fetch-Site: same-origin` (a backoffice served
 *    from the origin of the API needs no CORS). Otherwise `foreignOrigin`.
 * 2. `Origin` absent: a browser omits it only on a same-origin `GET` or `HEAD`. So: `Sec-Fetch-Site: same-origin` on `GET`/`HEAD` is fine; no `Sec-Fetch-Site` on `GET`/`HEAD` is fine only when no origin is allowed
 *    (`allowedOrigins` empty: the backoffice can only be served from the same origin, and the browser may be too old to send fetch metadata); every other case is `noOrigin` (a browser would have sent it).
 * 3. `Sec-Fetch-Site` or `Sec-Fetch-Mode` present but incoherent with a call of the SPA (`Sec-Fetch-Site` not `same-origin`, `same-site` or `cross-site`, so also `none`, a navigation; `Sec-Fetch-Mode` not `cors` or `same-origin`):
 *    `inconsistentFetchMetadata`.
 *
 * Fetch metadata missing altogether, with a valid `Origin`, is NOT a signal (browsers older than, for example, Safari 16.4 do not send it).
 *
 * @param req The request.
 * @param allowedOrigins The exact origins allowed by CORS (`CORS_ALLOWED_ORIGINS`).
 * @returns The reason, or `null` when the request looks like a browser's.
 */
export function nonBrowserReason(req: Request, allowedOrigins: ReadonlySet<string>): NonBrowserReason | null {
  const origin = req.get('origin');
  const site = req.get('sec-fetch-site');
  const mode = req.get('sec-fetch-mode');
  const safeMethod = req.method === 'GET' || req.method === 'HEAD';
  if (origin !== undefined) {
    if (!allowedOrigins.has(origin) && site !== 'same-origin') {
      return 'foreignOrigin';
    }
  } else if (!((safeMethod && site === 'same-origin') || (safeMethod && site === undefined && allowedOrigins.size === 0))) {
    return site !== undefined && !FETCH_SITES.has(site) ? 'inconsistentFetchMetadata' : 'noOrigin';
  }
  if ((site !== undefined && (!FETCH_SITES.has(site) || site === 'none')) || (mode !== undefined && !SCRIPT_MODES.has(mode))) {
    return 'inconsistentFetchMetadata';
  }
  return null;
}

/**
 * Cleans a `User-Agent` for the event: printable ASCII only (anything else is dropped), trimmed, at most {@link MAX_USER_AGENT_LENGTH} characters.
 *
 * @param value The header, if any.
 * @returns The text, or `null` when there is nothing left.
 */
export function cleanUserAgent(value: string | undefined): string | null {
  const cleaned = (value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, MAX_USER_AGENT_LENGTH).trim();
  return cleaned === '' ? null : cleaned;
}

/** Where a request was seen: the login, the refresh, or a `user` route of `/v1`. */
export const NON_BROWSER_SOURCES = Object.freeze(['login', 'refresh', 'api'] as const);

/** A place of {@link NON_BROWSER_SOURCES}. */
export type NonBrowserSource = (typeof NON_BROWSER_SOURCES)[number];

/** The user a request belongs to, once known for certain. */
export interface NonBrowserSubject {
  readonly userId: ObjectId;
  /** The actor of the event (the user, with the role when it is a real one). */
  readonly actor: ActivityActor;
  readonly groupId?: ObjectId;
}

/** What {@link createNonBrowserGuard} needs. */
export interface NonBrowserGuardDeps {
  readonly activityLog: ActivityLog;
  readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  readonly logger: Logger;
  /** The exact origins allowed by CORS (`CORS_ALLOWED_ORIGINS`). */
  readonly allowedOrigins: readonly string[];
  /** The security policy in memory: whether a request that does not look like a browser's is only reported or also refused. */
  readonly policy: Pick<SecurityPolicyProvider, 'get'>;
}

/**
 * Whether the event of a refused refresh may be written: at most {@link REFRESH_REFUSED_EVENTS_PER_HOUR} an hour per user (whoever holds a valid refresh token can repeat the request, which is not consumed). When the counter fails
 * the error is logged and the event is written anyway.
 */
async function refreshEventAllowed(deps: NonBrowserGuardDeps, subject: NonBrowserSubject): Promise<boolean> {
  try {
    return (await deps.rateLimiter.consume(REFRESH_REFUSED_BUCKET, subject.userId.toHexString(), REFRESH_REFUSED_EVENTS_PER_HOUR, HOUR_SECONDS)).allowed;
  } catch (error) {
    deps.logger.error('non-browser signal failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    return true;
  }
}

/** What the guard is told about a request besides the user. */
export interface NonBrowserGuardOptions {
  /** `true` on the routes that are never refused (the ones of `SUSTAINED_EXEMPT_ROUTES`): they are still reported. */
  readonly neverBlock?: boolean;
}

/**
 * Judges a request of a known user and, when it does not look like a browser's, records the event (once a day per user and reason) and, under the policy `block`, refuses it with `403 BROWSER_REQUIRED`. Never
 * for a PSA (who is the one that can turn the block off), never when `neverBlock`. It records what it finds in `res.locals.nonBrowserReason`. Every other failure (the counter, the log, the policy) is logged and
 * the request goes on: the guard never refuses for a fault.
 *
 * @throws {AppError} `BROWSER_REQUIRED` when the request is refused.
 */
export type NonBrowserGuard = (req: Request, res: Response, subject: NonBrowserSubject, source: NonBrowserSource, options?: NonBrowserGuardOptions) => Promise<void>;

/**
 * Builds the guard of the non-browser signal (see {@link nonBrowserReason}). The signal is FALSIFIABLE by any script that sends the same headers: it is not a barrier, it brings out the naive use of the
 * backoffice credentials from another program, and the block only stops that naive use. A normal request costs nothing (no write, no policy read); a flagged one costs one atomic counter and one read of the
 * in-memory policy, so each user and reason is recorded at most once a day (`request.nonBrowser`: the reason, where it was seen, whether it was only reported or blocked, and a cleaned `User-Agent`, nothing
 * else of the request).
 *
 * It must be called only for a user the server knows for certain (an authenticated request, or a login or refresh whose credentials were verified): a failed login names no user and never produces the event.
 *
 * @param deps Activity log, counter, logger, the allowed origins and the policy.
 * @returns The guard.
 */
export function createNonBrowserGuard(deps: NonBrowserGuardDeps): NonBrowserGuard {
  const allowed = new Set(deps.allowedOrigins);
  return async (req, res, subject, source, options = {}) => {
    const reason = nonBrowserReason(req, allowed);
    res.locals.nonBrowserReason = reason;
    if (reason === null) {
      return;
    }
    const exempt = options.neverBlock === true || (subject.actor.kind === 'user' && subject.actor.role === 'PSA');
    const blocked = !exempt && (await deps.policy.get()).nonBrowserRequests === 'block';
    if (blocked && source !== 'api' && (source === 'login' || (await refreshEventAllowed(deps, subject)))) {
      // A login or a refresh refused although the credentials were good: EVERY one is recorded, outside the daily ceiling of `request.nonBrowser`, because a password or a refresh token that a script got right must not stay almost
      // invisible (the volume is already limited by the rules of the login, which run before). `403 BROWSER_REQUIRED` at the login therefore means "the credentials are valid".
      await deps.activityLog.record({
        category: 'security',
        action: source === 'login' ? 'auth.loginFailed' : 'auth.refreshFailed',
        outcome: 'denied',
        actor: subject.actor,
        ...(subject.groupId === undefined ? {} : { groupId: subject.groupId }),
        requestId: res.locals.requestId,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
        metadata: { reason: 'browserRequired' },
      });
    }
    try {
      const decision = await deps.rateLimiter.consume(NON_BROWSER_BUCKET, `${subject.userId.toHexString()}:${reason}`, 1, DAY_SECONDS);
      if (decision.allowed) {
        await deps.activityLog.record({
          category: 'security',
          action: 'request.nonBrowser',
          outcome: blocked ? 'denied' : 'success',
          actor: subject.actor,
          ...(subject.groupId === undefined ? {} : { groupId: subject.groupId }),
          requestId: res.locals.requestId,
          ...(req.ip === undefined ? {} : { ip: req.ip }),
          metadata: { reason, source, outcome: blocked ? 'blocked' : 'reported', userAgent: cleanUserAgent(req.get('user-agent')) },
        });
      }
    } catch (error) {
      deps.logger.error('non-browser signal failed', { errorName: error instanceof Error ? error.name : 'unknown' });
    }
    if (blocked) {
      throw new AppError('BROWSER_REQUIRED');
    }
  };
}

/** Builds the middleware of one route from its exemption: `true` for a route that is never refused. */
export type NonBrowserSignal = (neverBlock: boolean) => RequestHandler;

/**
 * The middleware factory of the `user` routes of `/v1`: after authentication it runs the guard on the request of the authenticated user (source `api`), before the body and the controller. Requests without a
 * user (a store key, an anonymous route) are not evaluated; the public API never mounts it.
 *
 * @param guard The guard.
 * @returns The factory the route builder calls once per route.
 */
export function createNonBrowserSignal(guard: NonBrowserGuard): NonBrowserSignal {
  return (neverBlock) => async (req, res, next) => {
    const auth = res.locals.auth;
    if (auth !== undefined) {
      await guard(req, res, { userId: auth.userId, actor: responseActorOf(res), ...(auth.groupId === null ? {} : { groupId: auth.groupId }) }, 'api', { neverBlock });
    }
    next();
  };
}
