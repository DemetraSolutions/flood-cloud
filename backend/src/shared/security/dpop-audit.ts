import type { ObjectId } from 'mongodb';
import type { ActivityActor, ActivityLog } from '../activity-log/activity-log.ts';
import type { ClientContext } from '../http/client-context.ts';
import type { Logger } from '../logging/logger.ts';
import type { DpopRejection } from './dpop.ts';
import type { RateLimiter } from './rate-limit/rate-limiter.ts';

/** The bucket of the counter that caps, per user, the `auth.dpopRejected` events. */
export const DPOP_REJECTED_BUCKET = 'dpop-rejected:user';

/** Most `auth.dpopRejected` events written for one user in an hour: the refusal stays, the event is not written beyond it. `keyMismatch` is never capped. */
export const DPOP_REJECTED_EVENTS_PER_HOUR = 10;

/** An hour, in seconds. */
const HOUR_SECONDS = 3600;

/** Why a proof was refused, as recorded in the event: a {@link DpopRejection} or a valid proof signed by a key other than the one the session is bound to. */
export type DpopEventReason = DpopRejection | 'keyMismatch';

/** Where the proof was refused: the login, the refresh, or a `user` route of `/v1`. */
export type DpopEventSource = 'login' | 'refresh' | 'api';

/** What {@link DpopRejectedAudit} records. */
export interface DpopRejectedEvent {
  /** The user the session belongs to: the key of the hourly cap. */
  readonly userId: ObjectId;
  /** The actor of the event: the same user, with the role when it is a real one. */
  readonly actor: ActivityActor;
  /** Group of the user, when he has one. */
  readonly groupId?: ObjectId;
  /** The session whose token was presented. */
  readonly sessionId: ObjectId;
  readonly reason: DpopEventReason;
  readonly source: DpopEventSource;
  /** The request: id and address for the event. */
  readonly context: ClientContext;
}

/**
 * Records the security event `auth.dpopRejected` (outcome `denied`, metadata `reason` and `source` only: never the proof, a token or a key).
 * At most {@link DPOP_REJECTED_EVENTS_PER_HOUR} an hour per user, counted atomically in {@link DPOP_REJECTED_BUCKET}, except `keyMismatch`, which is always written
 * (a token used with a foreign key is a theft, and the family is revoked with it). When the counter fails the error is logged and the event is written anyway.
 */
export type DpopRejectedAudit = (event: DpopRejectedEvent) => Promise<void>;

/** Collaborators of {@link createDpopRejectedAudit}. */
export interface DpopRejectedAuditDeps {
  readonly activityLog: ActivityLog;
  readonly rateLimiter: Pick<RateLimiter, 'consume'>;
  readonly logger: Logger;
}

/**
 * Builds the recorder of the `auth.dpopRejected` events.
 *
 * @param deps Activity log, counter and logger.
 * @returns The recorder.
 */
export function createDpopRejectedAudit(deps: DpopRejectedAuditDeps): DpopRejectedAudit {
  const allowed = async (userId: ObjectId): Promise<boolean> => {
    try {
      return (await deps.rateLimiter.consume(DPOP_REJECTED_BUCKET, userId.toHexString(), DPOP_REJECTED_EVENTS_PER_HOUR, HOUR_SECONDS)).allowed;
    } catch (error) {
      deps.logger.error('dpop rejection counter failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      return true;
    }
  };
  return async (event) => {
    if (event.reason !== 'keyMismatch' && !(await allowed(event.userId))) {
      return;
    }
    await deps.activityLog.record({
      category: 'security',
      action: 'auth.dpopRejected',
      outcome: 'denied',
      actor: event.actor,
      ...(event.groupId === undefined ? {} : { groupId: event.groupId }),
      resource: { type: 'session', id: event.sessionId.toHexString() },
      requestId: event.context.requestId,
      ...(event.context.ip === null ? {} : { ip: event.context.ip }),
      metadata: { reason: event.reason, source: event.source },
    });
  };
}
