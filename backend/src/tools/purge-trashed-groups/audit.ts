import type { Document, ObjectId } from 'mongodb';
import type { ClusterId } from '../../config.ts';
import { UnknownClusterError } from '../../db/databases.ts';
import type { Databases } from '../../db/databases.ts';
import type { GroupDatabasePurger } from '../../db/group-database-purger.ts';
import { createApiKeysRepository } from '../../modules/api-keys/api-keys.repository.ts';
import { emptyCounts } from './counts.ts';
import type { GroupCounts } from './counts.ts';
import { groupIdFilter, groupUsersFilter, isExternalHost } from './filters.ts';
import type { SelectedGroup } from './select.ts';

const DAY_MS = 86_400_000;

/** What the audit decided about a group. */
export type GroupStatus =
  /** Can be purged by a run with the same options. */
  | 'purgeable'
  /** Its last activity is newer than the idle limit: held back unless `--include-active` is given. */
  | 'recentlyActive'
  /** Its database holds documents but no activity date could be found (no `sales`/`documents` ids, no login): it is not known to be idle, so it is held back unless `--include-active` is given. */
  | 'unknownActivity'
  /** Its `databaseHost` names a dedicated host this tool cannot reach: never purged. */
  | 'externalHost'
  /** Its `dataCluster` is not configured: its data cannot be reached, never purged. */
  | 'unusableCluster';

/** What the audit found for one group. */
export interface GroupAudit {
  readonly group: SelectedGroup;
  readonly status: GroupStatus;
  /** What a run would delete (the group database is counted only for the groups whose data can be reached). */
  readonly counts: GroupCounts;
  /** Users of the group that a run keeps: the `PSA` and the `D` with its `groupId`, and any user without a valid group role. */
  readonly usersKept: number;
  /** Group users whose `status` is `true` and that are not in the trash. */
  readonly activeUsers: number;
  /** The most recent of the newest `sales` and `documents` of the group database and the newest login of its group users, `null` when none is known. */
  readonly lastActivity: Date | null;
  /** The group has no collection in its database (it is purged all the same, and listed). */
  readonly withoutDatabase: boolean;
}

/** The options that decide whether a group is held back. */
export interface HoldOptions {
  /** A group whose last activity is newer than this many days is held back. */
  readonly minIdleDays: number;
  /** Do not hold back the recently active groups. */
  readonly includeActive: boolean;
  /** The time of the run. */
  readonly now: Date;
}

/**
 * Resolves the cluster of a group.
 *
 * @param databases Database accessor.
 * @param group The group.
 * @returns The cluster, or `null` when its `dataCluster` is not usable.
 */
export function clusterOf(databases: Databases, group: Pick<SelectedGroup, 'id' | 'dataCluster'>): ClusterId | null {
  try {
    return databases.resolveGroupCluster({ _id: group.id, dataCluster: group.dataCluster });
  } catch (error) {
    if (error instanceof UnknownClusterError) {
      return null;
    }
    throw error;
  }
}

/**
 * The newest login of the group users and how many of them are active. Logins are the `date` of the `tokens` of the legacy document and the `lastLoginAt` of the
 * credentials; anything that is not a date (missing, junk) is ignored.
 */
async function userActivity(databases: Databases, groupId: ObjectId): Promise<{ last: Date | null; active: number }> {
  const [row] = await databases
    .common()
    .collection('users')
    .aggregate<Document>([
      { $match: groupUsersFilter(groupId) },
      { $lookup: { from: 'userCredentials', localField: '_id', foreignField: '_id', as: 'credentials' } },
      {
        $project: {
          active: { $cond: [{ $and: [{ $eq: ['$status', true] }, { $ne: ['$trash', true] }] }, 1, 0] },
          dates: { $filter: { input: { $concatArrays: [{ $cond: [{ $isArray: '$tokens' }, '$tokens.date', []] }, '$credentials.lastLoginAt'] }, as: 'date', cond: { $eq: [{ $type: '$$date' }, 'date'] } } },
        },
      },
      { $group: { _id: null, active: { $sum: '$active' }, last: { $max: { $max: '$dates' } } } },
    ])
    .toArray();
  return { last: row?.['last'] instanceof Date ? row['last'] : null, active: (row?.['active'] as number | undefined) ?? 0 };
}

/**
 * Audits a group without writing anything: counts what a run would delete, finds its last activity and decides whether it is purgeable.
 *
 * @param databases Database accessor.
 * @param purger Read access to the group databases.
 * @param group The group.
 * @param hold The options that decide whether it is held back.
 */
export async function auditGroup(databases: Databases, purger: GroupDatabasePurger, group: SelectedGroup, hold: HoldOptions): Promise<GroupAudit> {
  const common = databases.common();
  const cluster = clusterOf(databases, group);
  const reachable = cluster !== null && !isExternalHost(group.databaseHost);
  const described = reachable ? await purger.describe(group.id, cluster) : { collections: 0, documents: 0, newestActivity: null };
  const keys = await createApiKeysRepository(databases).countOfGroup(group.id);
  const counts: GroupCounts = {
    ...emptyCounts(),
    collections: described.collections,
    documents: described.documents,
    users: await common.collection('users').countDocuments(groupUsersFilter(group.id)),
    companies: await common.collection('companies').countDocuments(groupIdFilter(group.id)),
    places: await common.collection('places').countDocuments(groupIdFilter(group.id)),
    apiKeys: keys.keys,
    apiUsage: keys.usageRows,
    storeKeys: await common.collection('storeKeys').countDocuments(groupIdFilter(group.id)),
    activationCodes: await common.collection('storeActivationCodes').countDocuments(groupIdFilter(group.id)),
    reserveWithGoogle: await common.collection('reserve_with_google').countDocuments(groupIdFilter(group.id)),
  };
  const everyUser = await common.collection('users').countDocuments(groupIdFilter(group.id));
  const users = await userActivity(databases, group.id);
  const lastActivity = [described.newestActivity, users.last].reduce<Date | null>((newest, at) => (at !== null && (newest === null || at > newest) ? at : newest), null);
  let status: GroupStatus = 'purgeable';
  if (isExternalHost(group.databaseHost)) {
    status = 'externalHost';
  } else if (cluster === null) {
    status = 'unusableCluster';
  } else if (!hold.includeActive && lastActivity !== null && lastActivity.getTime() > hold.now.getTime() - hold.minIdleDays * DAY_MS) {
    status = 'recentlyActive';
  } else if (!hold.includeActive && lastActivity === null && described.documents > 0) {
    status = 'unknownActivity';
  }
  return { group, status, counts, usersKept: everyUser - counts.users, activeUsers: users.active, lastActivity, withoutDatabase: status === 'purgeable' && counts.collections === 0 };
}
