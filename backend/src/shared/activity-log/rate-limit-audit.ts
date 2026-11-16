import type { RateLimitExceededHandler } from '../security/rate-limit/rate-limit.ts';
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
      requestId: res.locals.requestId,
      ...(req.ip === undefined ? {} : { ip: req.ip }),
      metadata: { bucket: rule.bucket },
    });
  };
}
