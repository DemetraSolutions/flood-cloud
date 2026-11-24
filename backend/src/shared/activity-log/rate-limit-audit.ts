import type { RateLimitExceededHandler } from '../security/rate-limit/rate-limit.ts';
import type { SustainedExceededHandler } from '../security/rate-limit/sustained.ts';
import { responseActorOf } from './actor.ts';
import type { ActivityLog } from './activity-log.ts';

/**
 * Builds the callback that records `rateLimit.exceeded` (security, `denied`) at the first excess of
 * a window: the rule's bucket, the caller (the principal, or anonymous), the request id and the IP.
 * The subject key (username, IP, user id) is never recorded.
 *
 * @param activityLog The log.
 * @returns The handler for `RateLimitDeps.onExceeded`.
 */
export function createRateLimitAudit(activityLog: ActivityLog): RateLimitExceededHandler {
  return async ({ rule, req, res }) => {
    await activityLog.record({
      category: 'security',
      action: 'rateLimit.exceeded',
      outcome: 'denied',
      actor: responseActorOf(res),
      // A public key is known to a group before the access to it is issued: the administrators of the group see what its keys cause.
      ...(res.locals.apiKey === undefined ? {} : { groupId: res.locals.apiKey.groupId }),
      requestId: res.locals.requestId,
      ...(req.ip === undefined ? {} : { ip: req.ip }),
      metadata: { bucket: rule.bucket },
    });
  };
}

/**
 * Builds the callback that records `rateLimit.sustainedExceeded` (security) at the first request of a user over the
 * hourly or daily limit of `/v1`: the user as the actor, the bucket, the window, the limit and the mode that applied.
 * The outcome is `denied` when the request was refused (`enforce`) and `success` when it passed (`report`). Nothing of
 * the request is recorded beyond what `rateLimit.exceeded` records (request id and IP).
 *
 * @param activityLog The log.
 * @returns The handler for `SustainedRateLimit.onExceeded`.
 */
export function createSustainedRateLimitAudit(activityLog: ActivityLog): SustainedExceededHandler {
  return async ({ rule, window, mode, req, res }) => {
    await activityLog.record({
      category: 'security',
      action: 'rateLimit.sustainedExceeded',
      outcome: mode === 'enforce' ? 'denied' : 'success',
      actor: responseActorOf(res),
      // The group of the user, when he has one, so his group administrators and dealer see the alert in the monitor.
      ...(res.locals.auth?.groupId == null ? {} : { groupId: res.locals.auth.groupId }),
      requestId: res.locals.requestId,
      ...(req.ip === undefined ? {} : { ip: req.ip }),
      metadata: { bucket: rule.bucket, window, limit: rule.limit, mode },
    });
  };
}
