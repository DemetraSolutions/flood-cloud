import type { Document, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { GroupDatabasePurger } from '../../db/group-database-purger.ts';
import { createApiKeysRepository } from '../../modules/api-keys/api-keys.repository.ts';
import { createSessionsRepository } from '../../modules/sessions/sessions.repository.ts';
import { createCredentialsRepository } from '../../modules/users/credentials.repository.ts';
import { buildActivityDocument } from '../../shared/activity-log/activity-log.ts';
import { clusterOf } from './audit.ts';
import { emptyCounts } from './counts.ts';
import type { GroupCounts } from './counts.ts';
import { groupIdFilter, groupUsersFilter, isExternalHost, TRASHED } from './filters.ts';
import type { SelectedGroup } from './select.ts';

/** Users deleted by one transaction. */
export const USER_BATCH = 100;

/** Days the `group.purged` event is kept (the default of `ACTIVITY_LOG_RETENTION_DAYS`: the tool reads no variable of the server). */
export const EVENT_RETENTION_DAYS = 365;

/**
 * The steps of the purge of one group, in order: the users (with their sessions and credentials) and the dependent data of the common database first, so nobody can
 * work on a group whose data is going away, then the copies of its companies and places, then the group database, and last the group document. `start` is the moment before
 * the group document is read again. The hook is called when a step has finished; the tests use it to inject failures and concurrent changes, the real run passes none.
 */
export type PurgeStep = 'start' | 'users' | 'dependent' | 'copies' | 'database';

/** Thrown when the group document stops being in the trash while it is being purged: the group is left alone from that moment. */
export class GroupRestoredError extends Error {
  /** The last step that finished before the restore was noticed. */
  readonly after: PurgeStep;

  /**
   * @param after The last step that finished.
   */
  constructor(after: PurgeStep) {
    super(`Group restored during the purge, stopped after step ${after}`);
    this.name = 'GroupRestoredError';
    this.after = after;
  }
}

/** What {@link purgeGroup} needs. */
export interface PurgeEnv {
  readonly databases: Databases;
  /** Destructive access to the group databases. */
  readonly purger: GroupDatabasePurger;
  /** Clock of the `group.purged` event. */
  readonly now: () => Date;
  /** Called when a step has finished (and with `start` before the first read); whatever it throws fails the group. */
  readonly afterStep?: (step: PurgeStep, groupHex: string) => Promise<void> | void;
}

/** The outcome of the purge of one group. */
export type GroupOutcome =
  /** Everything was deleted. `eventError` is the error class when the `group.purged` event could not be stored, `null` when it was. `resumed`: the group database was already gone. */
  | { readonly status: 'purged'; readonly counts: GroupCounts; readonly resumed: boolean; readonly eventError: string | null }
  /** The group is no longer in the trash (or no longer exists) at its turn: nothing was touched. */
  | { readonly status: 'skipped' }
  /** The group has a dedicated database host (checked again at its turn): nothing was touched. */
  | { readonly status: 'skippedExternalHost' }
  /** The group was restored while it was being purged: it was left alone from then on. `after` is the last step that finished. */
  | { readonly status: 'restored'; readonly after: PurgeStep }
  /** A step failed: the group document is still there, the run can be repeated. `errorName` is the error class only. */
  | { readonly status: 'failed'; readonly errorName: string };

/**
 * Deletes, in batches and inside one transaction each, the users of a group that have a group role, with their sessions, credentials and idempotency keys.
 * It uses the very deletions of the permanent delete of a single user (`sessions.deleteAllOfUser`, `credentials.delete`, and the user document), and never a `PSA` or a `D`.
 * The sessions and credentials of a batch are deleted only for the users the same transaction finds with the filter, and the user documents are deleted last
 * with the same filter again, so a user is never left without its dependants nor deleted without them.
 *
 * @returns How many users and idempotency keys were deleted.
 */
async function deleteGroupUsers(databases: Databases, groupId: ObjectId): Promise<{ users: number; idempotencyKeys: number }> {
  const users = databases.common().collection('users');
  const idempotency = databases.common().collection('idempotencyKeys');
  const sessions = createSessionsRepository(databases);
  const credentials = createCredentialsRepository(databases);
  const filter = groupUsersFilter(groupId);
  let deleted = { users: 0, idempotencyKeys: 0 };
  let after: ObjectId | null = null;
  for (;;) {
    const batch = await databases.transaction(async (session) => {
      const found = await users.find({ $and: [filter, ...(after === null ? [] : [{ _id: { $gt: after } }])] }, { projection: { _id: 1 }, sort: { _id: 1 }, limit: USER_BATCH, session }).toArray();
      const ids = found.map((document) => document._id as ObjectId);
      for (const id of ids) {
        await sessions.deleteAllOfUser(id, session);
        await credentials.delete(id, session);
      }
      const keys = await idempotency.deleteMany({ principal: { $in: ids.map((id) => id.toHexString()) } }, { session });
      const removed = await users.deleteMany({ $and: [filter, { _id: { $in: ids } }] }, { session });
      return { last: ids.at(-1) ?? null, users: removed.deletedCount, idempotencyKeys: keys.deletedCount };
    });
    if (batch.last === null) {
      return deleted;
    }
    deleted = { users: deleted.users + batch.users, idempotencyKeys: deleted.idempotencyKeys + batch.idempotencyKeys };
    after = batch.last;
  }
}

/**
 * Purges one group, step by step: its users, the data of the common database that depends on it, the copies of its companies and places, the group database, and last
 * its document. Before every step the group document is read again and the group is left alone (`restored`) as soon as it is not in the trash any more. Every step is
 * idempotent and no transaction spans the database drop: a failure stops the group, leaves its document (with `trash: true`) in place, and the run can simply be repeated.
 * The `group.purged` event is written after the document is deleted; its counts are those of this run only (`resumed` tells that the database was already gone).
 *
 * @param env Database accessor, purger, clock and test hook.
 * @param selected The group chosen by the selection.
 * @returns The outcome; this function never throws (a failure becomes `failed`).
 */
export async function purgeGroup(env: PurgeEnv, selected: SelectedGroup): Promise<GroupOutcome> {
  const { databases } = env;
  const groupId = selected.id;
  const hex = groupId.toHexString();
  let last: PurgeStep = 'start';
  const finished = async (step: PurgeStep): Promise<void> => {
    last = step;
    await env.afterStep?.(step, hex);
  };
  try {
    await env.afterStep?.('start', hex);
    const common = databases.common();
    const groups = common.collection('groups');
    const read = (): Promise<Document | null> => groups.findOne({ $and: [{ _id: groupId }, TRASHED] }, { projection: { _id: 1, dataCluster: 1, databaseHost: 1 } });
    const checkpoint = async (): Promise<void> => {
      if ((await read()) === null) {
        throw new GroupRestoredError(last);
      }
    };
    const fresh = await read();
    if (fresh === null) {
      return { status: 'skipped' };
    }
    if (isExternalHost(fresh['databaseHost'])) {
      return { status: 'skippedExternalHost' };
    }
    const cluster = clusterOf(databases, { id: groupId, dataCluster: fresh['dataCluster'] });
    if (cluster === null) {
      throw new Error('The cluster of the group is not configured');
    }

    const users = await deleteGroupUsers(databases, groupId);
    await finished('users');

    await checkpoint();
    const keys = await createApiKeysRepository(databases).deleteAllOfGroup(groupId);
    const storeKeys = (await common.collection('storeKeys').deleteMany(groupIdFilter(groupId))).deletedCount;
    const activationCodes = (await common.collection('storeActivationCodes').deleteMany(groupIdFilter(groupId))).deletedCount;
    const reserveWithGoogle = (await common.collection('reserve_with_google').deleteMany(groupIdFilter(groupId))).deletedCount;
    await finished('dependent');

    await checkpoint();
    const companies = (await common.collection('companies').deleteMany(groupIdFilter(groupId))).deletedCount;
    const places = (await common.collection('places').deleteMany(groupIdFilter(groupId))).deletedCount;
    await finished('copies');

    await checkpoint();
    const described = await env.purger.describe(groupId, cluster);
    const dropped = await env.purger.drop(groupId, cluster);
    await finished('database');

    // Last: its presence, still trashed, is what makes a failed run resumable. A group restored since the last check is not deleted.
    const removed = await groups.deleteOne({ $and: [{ _id: groupId }, TRASHED] });
    if (removed.deletedCount !== 1) {
      throw new GroupRestoredError(last);
    }

    const counts: GroupCounts = {
      ...emptyCounts(),
      collections: dropped,
      documents: described.documents,
      users: users.users,
      companies,
      places,
      apiKeys: keys.keys,
      apiUsage: keys.usageRows,
      storeKeys,
      activationCodes,
      reserveWithGoogle,
      idempotencyKeys: users.idempotencyKeys,
    };
    const resumed = described.collections === 0;
    return { status: 'purged', counts, resumed, eventError: await recordPurge(env, groupId, counts, resumed) };
  } catch (error) {
    return error instanceof GroupRestoredError ? { status: 'restored', after: error.after } : { status: 'failed', errorName: error instanceof Error ? error.name : 'unknown' };
  }
}

/**
 * Writes the `group.purged` event (system actor, counts only) to the activity log. It cannot make the purge fail: the group is already gone.
 *
 * @returns `null` when the event was stored, the error class otherwise.
 */
async function recordPurge(env: PurgeEnv, groupId: ObjectId, counts: GroupCounts, resumed: boolean): Promise<string | null> {
  try {
    const document = buildActivityDocument(
      { category: 'data', action: 'group.purged', outcome: 'success', actor: { kind: 'system' }, groupId, resource: { type: 'group', id: groupId.toHexString() }, metadata: { ...counts, resumed } },
      env.now(),
      EVENT_RETENTION_DAYS,
    );
    await env.databases.common().collection('activityEvents').insertOne(document);
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : 'unknown';
  }
}
