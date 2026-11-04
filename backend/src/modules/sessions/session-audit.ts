import type { ObjectId } from 'mongodb';
import type { ActivityActor, ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';

/** What {@link auditSessionsRevoked} records. */
export interface SessionsRevoked {
  /** Who caused the revocation: the user himself, or the system when the state of the account did. */
  readonly actor: ActivityActor;
  /** Group of the user, for the activity log scope. */
  readonly groupId?: ObjectId | null;
  /** Reason code (`logout`, `logoutAll`, `passwordChanged`, `userDisabled`, `refreshReuse`…). */
  readonly reason: string;
  /** The session, when exactly one was revoked. */
  readonly sessionId?: ObjectId;
  readonly client: ClientContext;
}

/**
 * Writes the security event `session.revoked`.
 *
 * @param activityLog The log.
 * @param event What happened.
 */
export async function auditSessionsRevoked(activityLog: ActivityLog, event: SessionsRevoked): Promise<void> {
  const { requestId, ip } = event.client;
  await activityLog.record({
    category: 'security',
    action: 'session.revoked',
    outcome: 'success',
    actor: event.actor,
    ...(event.groupId == null ? {} : { groupId: event.groupId }),
    resource: { type: 'session', ...(event.sessionId === undefined ? {} : { id: event.sessionId.toHexString() }) },
    requestId,
    ...(ip === null ? {} : { ip }),
    metadata: { reason: event.reason },
  });
}
