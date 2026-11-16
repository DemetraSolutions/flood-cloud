import type { RequestHandler } from 'express';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import { STORE_PROFILE } from '../../shared/security/rbac/policy.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';
import { hashSecret, parseSecret } from '../../shared/security/secrets.ts';
import { auditKeyRevoked } from './store-keys.audit.ts';
import { MAX_INSTALLATION_TEXT } from './store-keys.service.ts';
import type { StoreKeysRepository } from './store-keys.repository.ts';
import type { StoreStateReader } from './store-state.ts';

const BEARER = /^Bearer (\S+)$/i;

const HOUR_SECONDS = 3600;

/** Collaborators of {@link createAuthenticateStore}. */
export interface AuthenticateStoreDeps {
  readonly repository: StoreKeysRepository;
  readonly state: StoreStateReader;
  readonly activityLog: ActivityLog;
  /** Bounds the `store.revokedKeyPresented` events to one an hour for a key. */
  readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  readonly logger: Logger;
  /** The per-key rule of the API (`api:store`): applied here, to every request of an active key, whatever route it asks for. */
  readonly apiRule: RateLimitRule;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Builds the authentication of the requests that carry a store key (`Authorization: Bearer fc_sk_…`), the one the `/v1` dispatcher hands them to (`doc/Security-Model.md` section 5).
 *
 * The key is checked on every request: exact format (else `401 UNAUTHENTICATED` and no query), then the hash (SHA-256 of 256 bits, so there is no timing to exploit) against the unique index. A key
 * that is unknown or revoked is the same `401`; a revoked one still in use records `store.revokedKeyPresented` (an old server left on, or a stolen key), once an hour for a key. Then the stored
 * state is read again, after the per-key rate limit (`api:store`, counted here so that a refused or blocked request is counted too): a group that does not exist is `401`; a place that is in the trash or no longer exists **revokes** the key (`placeTrashed`, `placeDeleted`: this also catches what the legacy
 * did) and is `401`; a group suspended or in the trash, a place disabled, a license that is over and a company in the trash **block** with `403 STORE_DISABLED` and revoke nothing, so the store
 * resumes by itself. Otherwise the frozen {@link StorePrincipal} goes in `res.locals.store`, never in `res.locals.auth`. `lastSeenAt` (with address and user agent) is refreshed at most once a
 * minute, off the response path: a failure is logged and never fails the request.
 *
 * @param deps Repository, state reader, activity log, rate limiter, logger and clock.
 * @returns The middleware the `/v1` surface mounts for store keys.
 */
export function createAuthenticateStore(deps: AuthenticateStoreDeps): RequestHandler {
  const { repository, state, activityLog, rateLimiter, logger, apiRule } = deps;
  return async (req, res, next) => {
    const secret = parseSecret(BEARER.exec(req.get('authorization') ?? '')?.[1], 'fc_sk_');
    const key = secret === null ? null : await repository.findByHash(hashSecret(secret));
    if (key === null) {
      throw new AppError('UNAUTHENTICATED');
    }
    const client = clientContextOf(req, res);
    if (key.status !== 'active') {
      if ((await rateLimiter.consume('storeRevokedKey:key', key.id.toHexString(), 1, HOUR_SECONDS)).allowed) {
        await activityLog.record({
          category: 'security',
          action: 'store.revokedKeyPresented',
          outcome: 'denied',
          actor: { kind: 'anonymous' },
          groupId: key.groupId,
          resource: { type: 'storeKey', id: key.id.toHexString() },
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
        });
      }
      throw new AppError('UNAUTHENTICATED');
    }
    // The limit of the key comes before anything else is read and covers every request of an active key: the ones a route refuses (403) and the ones of a blocked store too.
    const decision = await rateLimiter.consume(apiRule.bucket, key.id.toHexString(), apiRule.limit, apiRule.windowSeconds);
    res.set({ 'RateLimit-Limit': String(decision.limit), 'RateLimit-Remaining': String(decision.remaining), 'RateLimit-Reset': String(decision.resetSeconds) });
    if (!decision.allowed) {
      if (decision.firstExcess) {
        await activityLog.record({
          category: 'security',
          action: 'rateLimit.exceeded',
          outcome: 'denied',
          actor: { kind: 'store', id: key.id },
          groupId: key.groupId,
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
          metadata: { bucket: apiRule.bucket },
        });
      }
      throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(decision.resetSeconds) } });
    }
    const now = new Date(deps.now());
    const assessment = await state.assess(key.groupId, key.placeId, now);
    if (assessment.kind === 'unauthenticated') {
      throw new AppError('UNAUTHENTICATED');
    }
    if (assessment.kind === 'revoke') {
      const revoked = await repository.revokeKey(key.id, { at: now, by: { kind: 'system' }, reason: assessment.reason });
      if (revoked !== null) {
        await auditKeyRevoked(activityLog, { key: revoked, reason: assessment.reason, actor: { kind: 'system' }, client });
      }
      throw new AppError('UNAUTHENTICATED');
    }
    repository
      .touch(key.id, { at: now, ip: client.ip, userAgent: client.userAgent === null ? null : client.userAgent.slice(0, MAX_INSTALLATION_TEXT) })
      .catch((error: unknown) => logger.error('updating the last use of a store key failed', { error }));
    if (assessment.kind === 'blocked') {
      throw new AppError('STORE_DISABLED');
    }
    res.locals.store = Object.freeze({
      kind: 'store' as const,
      keyId: key.id,
      groupId: key.groupId,
      companyId: assessment.companyId,
      placeId: key.placeId,
      activatedAt: key.activatedAt,
      permissions: STORE_PROFILE,
      scope: Object.freeze({ kind: 'store' as const, groupId: key.groupId, companyId: assessment.companyId, placeId: key.placeId }),
    });
    next();
  };
}
