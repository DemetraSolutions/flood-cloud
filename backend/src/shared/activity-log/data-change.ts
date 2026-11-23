import type { ObjectId } from 'mongodb';
import type { ActivityLog, ActivityActor, ActivityResource } from './activity-log.ts';
import { MAX_CHANGES } from './activity-log.ts';
import type { DataAction } from './catalog.ts';
import { computeChanges } from './changes.ts';

/** What {@link recordDataChange} needs to describe a write. */
export interface DataChange {
  /** Who wrote. */
  readonly actor: ActivityActor;
  /** Group of the data, taken from the verified group access (never from the client). */
  readonly groupId?: ObjectId;
  readonly resource: ActivityResource;
  /** For example `user.updated`. */
  readonly action: DataAction;
  /** The document before the write (`undefined` for a creation). */
  readonly before: Readonly<Record<string, unknown>> | undefined;
  /** The document after the write (`undefined` for a deletion). */
  readonly after: Readonly<Record<string, unknown>> | undefined;
  /** Extra sensitive fields on top of the default list. */
  readonly sensitive?: readonly string[];
  readonly requestId?: string;
  readonly ip?: string;
  /** Scalar metadata under the keys the action allows (`user.deleted` accepts `role`). */
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Records a successful write in the `data` category with the field-level changes. For the service
 * layer only: controllers never call it. At most {@link MAX_CHANGES} changes are stored; when there
 * are more, the entry says so in its metadata (`changesTruncated`, `changesTotal`).
 *
 * @param activityLog The log.
 * @param change The write.
 */
export async function recordDataChange(activityLog: ActivityLog, change: DataChange): Promise<void> {
  const all = computeChanges(change.before, change.after, change.sensitive === undefined ? {} : { sensitive: change.sensitive });
  const truncated = all.length > MAX_CHANGES;
  const metadata = { ...change.metadata, ...(truncated ? { changesTruncated: true, changesTotal: all.length } : {}) };
  await activityLog.record({
    category: 'data',
    action: change.action,
    outcome: 'success',
    actor: change.actor,
    ...(change.groupId === undefined ? {} : { groupId: change.groupId }),
    resource: change.resource,
    changes: truncated ? all.slice(0, MAX_CHANGES) : all,
    ...(change.requestId === undefined ? {} : { requestId: change.requestId }),
    ...(change.ip === undefined ? {} : { ip: change.ip }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  });
}
