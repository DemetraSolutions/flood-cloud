import { ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import type { ClusterId } from '../../config.ts';
import { COLLECTIONS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { ensureIndexes } from '../../db/indexes.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { createIssueSink } from './issues.ts';
import type { IssueSink, SyncCollection } from './issues.ts';
import { planGroups } from './plan.ts';
import { checkClusters } from './prerequisites.ts';
import type { ClusterCheck } from './prerequisites.ts';
import { emptyStats, reconcileCollection, reportOrphanPlaces } from './reconcile.ts';
import type { BlockLimits, BlockRunner, CollectionStats, CopyTarget } from './reconcile.ts';

/** Options of {@link syncCopies}. */
export interface SyncOptions {
  /** Write the missing and different copies and `syncIssues`; false for a dry run (nothing at all is written, not even the indexes). */
  readonly apply: boolean;
  /** Limit the run to one group (its extra and invalid copies included). */
  readonly groupId: ObjectId | null;
  /** Identifier shared by the `syncIssues` documents of this run. */
  readonly runId: ObjectId;
  /** Clock for `detectedAt`. */
  readonly now: () => Date;
  /** Size of the blocks of repairs. */
  readonly limits: BlockLimits;
  /** Receives the warning of `ensureIndexes` about a validator it cannot update (none of these collections has one). */
  readonly logger: Pick<Logger, 'error'>;
  /** Called when the work on a group fails: the other groups go on. Receives the group id (hex) and the error. */
  readonly onGroupError: (groupHex: string, error: unknown) => void;
}

/** Counters of one group. */
export interface GroupSummary {
  readonly companies: CollectionStats;
  readonly places: CollectionStats;
}

/** Outcome of {@link syncCopies}. */
export interface SyncResult {
  /** Version and replica set of each cluster used. */
  readonly checks: readonly ClusterCheck[];
  /** `groups` documents examined. */
  readonly groupsExamined: number;
  /** Groups whose database was compared. */
  readonly groupsCopied: number;
  /** Counters of every group that has a database or leftover copies, by group id (hex). */
  readonly summaries: ReadonlyMap<string, GroupSummary>;
  /** Discrepancies found, with their counters. */
  readonly issues: IssueSink;
  /** Groups whose work failed. */
  readonly errors: number;
}

/**
 * Counts and reports (never deletes) the copies of a group that has no database to copy from: they are `extraCopy`.
 * Copies whose `_id` is not an ObjectId are left to {@link reportInvalidCopies}.
 */
async function reportExtraCopies(copy: Collection<Document>, name: SyncCollection, groupId: ObjectId, sink: IssueSink, stats: CollectionStats): Promise<void> {
  for await (const document of copy.find({ groupId, _id: { $type: 'objectId' } }, { projection: { _id: 1 } })) {
    stats.copies += 1;
    stats.extra += 1;
    await sink.record({ kind: 'extraCopy', collection: name, groupId, documentId: document._id as ObjectId, repaired: false });
  }
}

/**
 * Reports (never modifies) the copies that are not valid: an `_id` or a `groupId` that is not an ObjectId, or a `groupId` that is an array. With a group
 * filter only the copies of that group are looked at (a copy without a usable `groupId` belongs to no group).
 */
async function reportInvalidCopies(copy: Collection<Document>, name: SyncCollection, filter: ObjectId | null, sink: IssueSink): Promise<void> {
  const notId = { $not: { $type: 'objectId' } } as const;
  // `$type` looks inside arrays: an array `groupId` must be asked for explicitly.
  const groupIdArray = { groupId: { $type: 'array' } } as const;
  const invalid: Document = filter === null ? { $or: [{ _id: notId }, { groupId: notId }, groupIdArray] } : { groupId: filter, $or: [{ _id: notId }, groupIdArray] };
  for await (const document of copy.find(invalid, { projection: { _id: 1, groupId: 1 } })) {
    await sink.record({
      kind: 'invalidCopy',
      collection: name,
      groupId: document['groupId'] instanceof ObjectId ? document['groupId'] : null,
      documentId: document._id instanceof ObjectId ? document._id : null,
      repaired: false,
    });
  }
}

/**
 * Copies the current state of `companies` and `places` of every group into the common database (`doc/Tasks.md` 5.4 and
 * 5.5: the first run is the initial load, the next ones the reconciliation). It only writes missing and different copies
 * and never deletes anything: copies without original are reported as `extraCopy`. Only replica sets are supported.
 *
 * Order of work: groups and their clusters are read; every cluster used must be MongoDB 4.4 or later and a replica set
 * (an error here stops the run before any write); the group databases are listed; with `apply` the indexes of the three
 * collections are created; then each group is compared and repaired, one at a time. A group that fails is counted and
 * reported through `onGroupError`, and the others go on. Finally the copies of groups that have no database (or no group
 * document) are counted as extra, and invalid copies are reported. A group on a cluster other than the common one is
 * copied without a transaction (D-25): there are no transactions across clusters.
 * Documents are never held in memory beyond one block.
 *
 * @param databases Database accessor (the only way to reach a database, so the environment guard applies).
 * @param options Mode, filter, limits and callbacks.
 * @returns The counters and the discrepancies found.
 * @throws {Error} If a prerequisite is not met or a read of the group list or database list fails (before any write).
 */
export async function syncCopies(databases: Databases, options: SyncOptions): Promise<SyncResult> {
  if (!(await databases.commonDatabaseExists())) {
    throw new Error('The common database does not exist on the common cluster: check DB_NAME_PREFIX');
  }
  if ((await databases.common().collection('groups').findOne({}, { projection: { _id: 1 } })) === null) {
    throw new Error('The groups collection of the common database is empty: check DB_NAME_PREFIX');
  }
  const plan = await planGroups(databases, options.groupId);
  const checks = await checkClusters(databases, plan.clusters);
  const databasesByCluster = new Map<ClusterId, Set<string>>();
  const everyDatabase = new Set<string>();
  for (const clusterId of plan.clusters) {
    const hexes = (await databases.listGroupIds(clusterId)).map((id) => id.toHexString());
    databasesByCluster.set(clusterId, new Set(hexes));
    for (const hex of hexes) {
      everyDatabase.add(hex);
    }
  }
  const common = databases.common();
  if (options.apply) {
    await ensureIndexes(databases, { common: { companies: COLLECTIONS.common.companies, places: COLLECTIONS.common.places, syncIssues: COLLECTIONS.common.syncIssues }, group: {} }, options.logger);
  }
  const sink = createIssueSink(options.apply ? common.collection('syncIssues') : null, options.runId, options.now);
  const summaries = new Map<string, GroupSummary>();
  const summaryOf = (hex: string): GroupSummary => {
    const existing = summaries.get(hex);
    if (existing !== undefined) {
      return existing;
    }
    const created = { companies: emptyStats(), places: emptyStats() };
    summaries.set(hex, created);
    return created;
  };
  let errors = 0;
  let groupsCopied = 0;
  const failed = (hex: string, error: unknown): void => {
    errors += 1;
    options.onGroupError(hex, error);
  };

  const filterHex = options.groupId?.toHexString();
  for (const hex of [...everyDatabase].sort()) {
    if (!plan.knownGroupHexes.has(hex) && (filterHex === undefined || hex === filterHex)) {
      await sink.record({ kind: 'databaseWithoutGroup', collection: null, groupId: ObjectId.createFromHexString(hex), documentId: null, repaired: false });
    }
  }

  // Groups the copies of which must stay: those with a database and those whose cluster is unknown (nothing can be said about them).
  const keep = new Set<string>();
  for (const group of plan.groups) {
    const hex = group.id.toHexString();
    if (group.cluster === null) {
      keep.add(hex);
      await sink.record({ kind: 'unknownCluster', collection: null, groupId: group.id, documentId: null, repaired: false });
      continue;
    }
    if (!(databasesByCluster.get(group.cluster) as Set<string>).has(hex)) {
      continue;
    }
    keep.add(hex);
    groupsCopied += 1;
    const summary = summaryOf(hex);
    const groupDb = databases.group(group.id, group.cluster);
    const runBlock: BlockRunner = group.cluster === databases.commonCluster ? (work) => databases.transaction((session) => work(session)) : (work) => work(undefined);
    const env = { groupId: group.id, apply: options.apply, limits: options.limits, sink, runBlock };
    const targets: ReadonlyArray<readonly [CopyTarget, CollectionStats]> = [
      [{ name: 'companies', original: groupDb.collection('companies'), copy: common.collection('companies') }, summary.companies],
      [{ name: 'places', original: groupDb.collection('places'), copy: common.collection('places') }, summary.places],
    ];
    try {
      for (const [target, stats] of targets) {
        await reconcileCollection(target, env, stats);
      }
      await reportOrphanPlaces(groupDb.collection('places'), groupDb.collection('companies'), group.id, options.limits, sink);
      await sink.flush();
    } catch (error) {
      failed(hex, error);
    }
  }

  const leftovers: ReadonlyArray<readonly [SyncCollection, Collection<Document>]> = [
    ['companies', common.collection('companies')],
    ['places', common.collection('places')],
  ];
  for (const [name, copy] of leftovers) {
    const stale = await copy
      .aggregate<{ _id: ObjectId }>(
        [{ $match: { $and: [{ groupId: options.groupId ?? { $type: 'objectId' } }, { groupId: { $not: { $type: 'array' } } }] } }, { $sort: { groupId: 1 } }, { $group: { _id: '$groupId' } }],
        { allowDiskUse: true },
      )
      .toArray();
    for (const { _id: groupId } of stale.filter(({ _id }) => !keep.has(_id.toHexString())).sort((a, b) => a._id.toHexString().localeCompare(b._id.toHexString()))) {
      const hex = groupId.toHexString();
      try {
        await reportExtraCopies(copy, name, groupId, sink, summaryOf(hex)[name]);
      } catch (error) {
        failed(hex, error);
      }
    }
  }
  for (const [name, copy] of leftovers) {
    await reportInvalidCopies(copy, name, options.groupId, sink);
  }
  await sink.flush();
  return { checks, groupsExamined: plan.groups.length, groupsCopied, summaries, issues: sink, errors };
}
