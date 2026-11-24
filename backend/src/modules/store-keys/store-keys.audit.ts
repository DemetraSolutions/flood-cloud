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
 * Writes the alert `store.activationCodeForActivePlace`: an activation code was made for a place that already has an active key. The resource is the place, the metadata the four character hint of
 * that key; the code and the key are never recorded.
 *
 * @param activityLog The log.
 * @param event The actor, the place, the active key as it is and the client.
 */
export async function auditCodeForActivePlace(
  activityLog: ActivityLog,
  event: { readonly actor: ActivityActor; readonly activeKey: Pick<StoreKey, 'groupId' | 'placeId' | 'hint'>; readonly client: ClientContext },
): Promise<void> {
  await activityLog.record({
    category: 'security',
    action: 'store.activationCodeForActivePlace',
    outcome: 'success',
    actor: event.actor,
    groupId: event.activeKey.groupId,
    resource: { type: 'place', id: event.activeKey.placeId.toHexString() },
    ...requestPart(event.client),
    metadata: { keyHint: event.activeKey.hint },
  });
}

/**
 * Writes the alert `store.activeKeyRevoked`: an administrator revoked the active key of a place by hand (next to `store.keyRevoked`). It closes the way round the confirmation of a new code (revoke the key, then ask for a
 * code that needs no confirmation). The resource is the place, the metadata the hint and the id of the key; never a key.
 *
 * @param activityLog The log.
 * @param event The key as it was, the actor and the client.
 */
export async function auditActiveKeyRevoked(
  activityLog: ActivityLog,
  event: { readonly key: Pick<StoreKey, 'id' | 'groupId' | 'placeId' | 'hint'>; readonly actor: ActivityActor; readonly client: ClientContext },
): Promise<void> {
  await activityLog.record({
    category: 'security',
    action: 'store.activeKeyRevoked',
    outcome: 'success',
    actor: event.actor,
    groupId: event.key.groupId,
    resource: { type: 'place', id: event.key.placeId.toHexString() },
    ...requestPart(event.client),
    metadata: { keyHint: event.key.hint, keyId: event.key.id.toHexString() },
  });
}

/**
 * Writes the alert `store.activeKeyReplaced`: an activation replaced the active key of a place. The actor is the new key (the exchange is anonymous), the resource the place, the metadata the hint and the
 * id of the key that was replaced; no key is ever recorded.
 *
 * @param activityLog The log.
 * @param event The new key, the replaced key as it was and the client.
 */
export async function auditActiveKeyReplaced(
  activityLog: ActivityLog,
  event: { readonly newKeyId: ObjectId; readonly replaced: Pick<StoreKey, 'id' | 'groupId' | 'placeId' | 'hint'>; readonly client: ClientContext },
): Promise<void> {
  await activityLog.record({
    category: 'security',
    action: 'store.activeKeyReplaced',
    outcome: 'success',
    actor: { kind: 'store', id: event.newKeyId },
    groupId: event.replaced.groupId,
    resource: { type: 'place', id: event.replaced.placeId.toHexString() },
    ...requestPart(event.client),
    metadata: { keyHint: event.replaced.hint, replacedKeyId: event.replaced.id.toHexString() },
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
