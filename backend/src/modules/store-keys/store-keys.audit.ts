import type { ObjectId } from 'mongodb';
import type { ActivityActor, ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { RevokeReason, StoreKey } from './store-keys.types.ts';

/** What the audit of the store keys records about the request: the correlation id and the client address. */
const requestPart = (client: ClientContext) => ({ requestId: client.requestId, ...(client.ip === null ? {} : { ip: client.ip }) });

/**
 * Writes the security event `store.keyRevoked`: the key (by its id and its four character hint, never the secret), the place's group, why and by whom.
 *
 * @param activityLog The log.
 * @param event The key as it was, the reason, the actor and the client.
 */
export async function auditKeyRevoked(
  activityLog: ActivityLog,
  event: { readonly key: Pick<StoreKey, 'id' | 'groupId' | 'hint'>; readonly reason: RevokeReason; readonly actor: ActivityActor; readonly client: ClientContext },
): Promise<void> {
  await activityLog.record({
    category: 'security',
    action: 'store.keyRevoked',
    outcome: 'success',
    actor: event.actor,
    groupId: event.key.groupId,
    resource: { type: 'storeKey', id: event.key.id.toHexString() },
    ...requestPart(event.client),
    metadata: { reason: event.reason, keyHint: event.key.hint },
  });
}

/**
 * Writes the security event of an activation code: created or cancelled by a PSA or a dealer. The resource is the place; the code is never recorded.
 *
 * @param activityLog The log.
 * @param event The action, the actor, the place and the client.
 */
export async function auditActivationCode(
  activityLog: ActivityLog,
  event: { readonly action: 'store.activationCodeCreated' | 'store.activationCodeCancelled'; readonly actor: ActivityActor; readonly groupId: ObjectId; readonly placeId: ObjectId; readonly client: ClientContext },
): Promise<void> {
  await activityLog.record({
    category: 'security',
    action: event.action,
    outcome: 'success',
    actor: event.actor,
    groupId: event.groupId,
    resource: { type: 'place', id: event.placeId.toHexString() },
    ...requestPart(event.client),
  });
}
