import type { RequestHandler } from 'express';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { RateLimitDecision, RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import { frozenSet } from '../../shared/security/frozen.ts';
import { safeEqual } from '../../shared/security/compare.ts';
import { hashSecret, parseSecret } from '../../shared/security/secrets.ts';
import type { ApiKeysRepository } from './api-keys.repository.ts';
import type { UsageMeter } from './usage-meter.ts';

/** Bucket of the per-minute limit of a key. */
export const PUBLIC_KEY_BUCKET = 'public:key';

/** Bucket of the per-minute cap of a whole group (all its keys together). */
export const PUBLIC_GROUP_BUCKET = 'public:group';

/** Bucket of the daily cap of a whole group. */
export const PUBLIC_GROUP_QUOTA_BUCKET = 'public:group-quota';

/** Bucket of the daily quota of a key. */
export const PUBLIC_QUOTA_BUCKET = 'public:quota';

/** Length of the window of the quota: a UTC day (the windows of the limiter start at the epoch, so they start at midnight UTC). */
export const QUOTA_WINDOW_SECONDS = 86_400;

/** Minimum interval between two updates of `lastUsedAt`, in milliseconds. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** Collaborators of {@link createAuthenticateApiKey}. */
export interface AuthenticateApiKeyDeps {
  readonly repository: Pick<ApiKeysRepository, 'findByHash' | 'groupState' | 'touch'>;
  /** The counters of the per-minute limit and of the daily quota. */
  readonly rateLimiter: Pick<RateLimiter, 'consume' | 'peek'>;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  readonly meter: Pick<UsageMeter, 'record'>;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Builds the authentication of `/public/v1` (`doc/Security-Model.md` sections 6 and 7): the key is read from the header `X-Api-Key` and from nowhere else (no query parameter, no cookie, no `Authorization`).
 *
 * The key must have the exact format (else `401` and no query), its SHA-256 must be that of a stored key (looked up by the unique index and compared again in constant time), the key must be active and not expired,
 * and its group must exist, be active, not be in the trash and have the public API switched on. Every one of these failures is the same `401 UNAUTHENTICATED` with the same message, which never says which check failed. Then
 * the request is counted by the meter when it ends (finished or aborted), then four counters are applied in this order: the per-minute limit of the key (`public:key`), the per-minute cap of its group (`public:group`),
 * the daily quota of the key (`public:quota`, a UTC day; a key that has already used it up is refused before the group counters, so it never eats the capacity of the other keys) and the daily cap of the group (`public:group-quota`): `429 RATE_LIMITED` with the `RateLimit-*` headers of the limit that refused, or `429 QUOTA_EXCEEDED` with `Retry-After`
 * until midnight and no `RateLimit-*` header (those describe the minute only); the first excess of a window is recorded in the activity log with the key as actor and the frozen {@link ApiKeyPrincipal} goes in `res.locals.apiKey`, never in
 * `res.locals.auth`. `lastUsedAt` is refreshed at most once a minute, off the response path: a failure is logged and never fails the request. The failed authentications count in the per-IP limit of the route builder.
 *
 * @param deps Repository, counters, activity log, logger, meter and clock.
 * @returns The middleware the public surface mounts.
 */
export function createAuthenticateApiKey(deps: AuthenticateApiKeyDeps): RequestHandler {
  const { repository, rateLimiter, activityLog, logger, meter } = deps;
  return async (req, res, next) => {
    const secret = parseSecret(req.get('x-api-key'), 'fc_pk_');
    const hash = secret === null ? null : hashSecret(secret);
    const key = hash === null ? null : await repository.findByHash(hash);
    const now = new Date(deps.now());
    if (key === null || !safeEqual(key.hash, hash!) || key.status !== 'active' || (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime())) {
      throw new AppError('UNAUTHENTICATED');
    }
    const group = await repository.groupState(key.groupId);
    if (group === null || !group.usable) {
      throw new AppError('UNAUTHENTICATED');
    }
    // From here the request belongs to a valid key: it is counted when it ends, whatever the outcome (a `429` included), once, and as aborted when the client left before the response was complete.
    const day = now.toISOString().slice(0, 10);
    const route = `${req.method === 'HEAD' ? 'GET' : req.method} ${res.locals.routePattern!}`;
    let counted = false;
    const count = (aborted: boolean): void => {
      if (!counted) {
        counted = true;
        meter.record({ keyId: key.id, groupId: key.groupId, day, route, status: res.statusCode, aborted });
      }
    };
    res.once('finish', () => count(false));
    res.once('close', () => count(!res.writableFinished));
    const client = clientContextOf(req, res);
    const exceeded = (bucket: string): Promise<void> =>
      activityLog.record({
        category: 'security',
        action: 'rateLimit.exceeded',
        outcome: 'denied',
        actor: { kind: 'apiKey', id: key.id },
        groupId: key.groupId,
        resource: { type: 'apiKey', id: key.id.toHexString() },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
        metadata: { bucket },
      });
    const keyId = key.id.toHexString();
    const groupId = key.groupId.toHexString();
    const headersOf = (decision: RateLimitDecision): Record<string, string> => ({ 'RateLimit-Limit': String(decision.limit), 'RateLimit-Remaining': String(decision.remaining), 'RateLimit-Reset': String(decision.resetSeconds) });
    // The order is the cheapest refusal first, and the daily counters last: a request refused by a minute limit consumes no daily quota, and one refused by the daily quota of the key consumes nothing of the group.
    // A request the daily cap of the group refuses has used a unit of the daily quota of its key (the counters are separate atomic increments, never undone).
    const minute = await rateLimiter.consume(PUBLIC_KEY_BUCKET, keyId, key.rateLimitPerMinute);
    if (!minute.allowed) {
      res.set(headersOf(minute));
      if (minute.firstExcess) {
        await exceeded(PUBLIC_KEY_BUCKET);
      }
      throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(minute.resetSeconds) } });
    }
    // A key that has used up its own daily quota is refused here, before it touches the counter of the group: it would otherwise eat the per-minute capacity of the other keys of the group with requests that can never succeed.
    // Only its own counter is incremented (so the first excess of the window is still recorded).
    const exhausted = !(await rateLimiter.peek(PUBLIC_QUOTA_BUCKET, keyId, key.dailyQuota, QUOTA_WINDOW_SECONDS)).allowed;
    const early = exhausted ? await rateLimiter.consume(PUBLIC_QUOTA_BUCKET, keyId, key.dailyQuota, QUOTA_WINDOW_SECONDS) : null;
    if (early !== null) {
      if (early.firstExcess) {
        await exceeded(PUBLIC_QUOTA_BUCKET);
      }
      throw new AppError('QUOTA_EXCEEDED', { headers: { 'Retry-After': String(early.resetSeconds) } });
    }
    const groupMinute = await rateLimiter.consume(PUBLIC_GROUP_BUCKET, groupId, group.groupRateLimitPerMinute);
    if (!groupMinute.allowed) {
      res.set(headersOf(groupMinute));
      if (groupMinute.firstExcess) {
        await exceeded(PUBLIC_GROUP_BUCKET);
      }
      throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(groupMinute.resetSeconds) } });
    }
    // The per-minute `RateLimit-*` headers describe the per-minute limits only: a refusal for the daily quota carries none of them, just `Retry-After` until the end of the UTC day.
    const quota = await rateLimiter.consume(PUBLIC_QUOTA_BUCKET, keyId, key.dailyQuota, QUOTA_WINDOW_SECONDS);
    if (!quota.allowed) {
      if (quota.firstExcess) {
        await exceeded(PUBLIC_QUOTA_BUCKET);
      }
      throw new AppError('QUOTA_EXCEEDED', { headers: { 'Retry-After': String(quota.resetSeconds) } });
    }
    const groupQuota = await rateLimiter.consume(PUBLIC_GROUP_QUOTA_BUCKET, groupId, group.groupDailyQuota, QUOTA_WINDOW_SECONDS);
    if (!groupQuota.allowed) {
      if (groupQuota.firstExcess) {
        await exceeded(PUBLIC_GROUP_QUOTA_BUCKET);
      }
      throw new AppError('QUOTA_EXCEEDED', { headers: { 'Retry-After': String(groupQuota.resetSeconds) } });
    }
    // Both minute limits passed: the headers show the one with fewer requests left.
    res.set(headersOf(groupMinute.remaining < minute.remaining ? groupMinute : minute));
    if (key.lastUsedAt === null || now.getTime() - key.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
      repository.touch(key.id, now, new Date(now.getTime() - LAST_USED_RESOLUTION_MS)).catch((error: unknown) => logger.error('updating the last use of a public API key failed', { errorName: error instanceof Error ? error.name : typeof error }));
    }
    res.locals.apiKey = Object.freeze({
      kind: 'apiKey' as const,
      keyId: key.id,
      groupId: key.groupId,
      groupName: group.name,
      name: key.name,
      prefix: key.prefix,
      permissions: frozenSet(key.permissions),
      restrictions: Object.freeze({ companyIds: key.restrictions.companyIds === null ? null : Object.freeze([...key.restrictions.companyIds]), placeIds: key.restrictions.placeIds === null ? null : Object.freeze([...key.restrictions.placeIds]) }),
      rateLimitPerMinute: key.rateLimitPerMinute,
      dailyQuota: key.dailyQuota,
      groupRateLimitPerMinute: group.groupRateLimitPerMinute,
      groupDailyQuota: group.groupDailyQuota,
      expiresAt: key.expiresAt,
    });
    next();
  };
}
