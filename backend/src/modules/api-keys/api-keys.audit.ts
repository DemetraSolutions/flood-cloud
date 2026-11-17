import type { ActivityActor, ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { ApiKey } from './api-keys.types.ts';

/** Characters of the prefix that are the `fc_pk_` marker, which the activity log would redact: only what follows is recorded. */
const KEY_PREFIX_LENGTH_SHOWN = 'fc_pk_'.length;

/**
 * Writes the security event of a public API key: created, changed (with the names of the fields it changed) or revoked. The key is recorded by its id, its name and the six characters after `fc_pk_` (`keyHint`), never the key.
 *
 * @param activityLog The log.
 * @param event The action, the key as it is after the action, who did it, the request and, for an update, the names of the changed fields.
 */
export async function auditApiKey(
  activityLog: ActivityLog,
  event: {
    readonly action: 'apiKey.created' | 'apiKey.updated' | 'apiKey.revoked';
    readonly key: Pick<ApiKey, 'id' | 'groupId' | 'name' | 'prefix'>;
    readonly actor: ActivityActor;
    readonly client: ClientContext;
    readonly fields?: readonly string[];
  },
): Promise<void> {
  const { client } = event;
  await activityLog.record({
    category: 'security',
    action: event.action,
    outcome: 'success',
    actor: event.actor,
    groupId: event.key.groupId,
    resource: { type: 'apiKey', id: event.key.id.toHexString() },
    requestId: client.requestId,
    ...(client.ip === null ? {} : { ip: client.ip }),
    metadata: { name: event.key.name, keyHint: event.key.prefix.slice(KEY_PREFIX_LENGTH_SHOWN), ...(event.fields === undefined ? {} : { fields: event.fields.join(',') }) },
  });
}
