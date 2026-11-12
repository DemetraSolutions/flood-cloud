import type { ObjectId } from 'mongodb';
import type { ClusterId } from '../../config.ts';
import { UnknownClusterError } from '../../db/databases.ts';
import type { Databases } from '../../db/databases.ts';

/** A group the run will look at. */
export interface PlannedGroup {
  readonly id: ObjectId;
  /** Cluster that holds its data, `null` when its `dataCluster` cannot be used. */
  readonly cluster: ClusterId | null;
}

/** The groups of the run, before any database is listed. */
export interface GroupPlan {
  /** Groups to examine, sorted by `_id`. */
  readonly groups: readonly PlannedGroup[];
  /** Hex of every group id seen in `groups` (the whole collection, even with a filter: it decides `databaseWithoutGroup`). */
  readonly knownGroupHexes: ReadonlySet<string>;
  /** Clusters the run needs, the common one first. */
  readonly clusters: readonly ClusterId[];
}

/**
 * Reads the `groups` documents (only `_id` and `dataCluster`, in `_id` order, through a cursor) and resolves the cluster
 * of each. With a `filter` only that group is read; when it has no document, every cluster is needed because its
 * database, if any, could be anywhere.
 *
 * @param databases Database accessor.
 * @param filter Group to limit the run to, or `null` for all.
 * @returns The plan.
 */
export async function planGroups(databases: Databases, filter: ObjectId | null): Promise<GroupPlan> {
  const cursor = databases
    .common()
    .collection('groups')
    .find(filter === null ? { _id: { $type: 'objectId' } } : { _id: filter }, { projection: { _id: 1, dataCluster: 1 } })
    .sort({ _id: 1 });
  const groups: PlannedGroup[] = [];
  const knownGroupHexes = new Set<string>();
  const clusters = new Set<ClusterId>([databases.commonCluster]);
  for await (const document of cursor) {
    const id = document._id as ObjectId;
    knownGroupHexes.add(id.toHexString());
    let cluster: ClusterId | null = null;
    try {
      cluster = databases.resolveGroupCluster({ _id: id, dataCluster: document['dataCluster'] });
    } catch (error) {
      if (!(error instanceof UnknownClusterError)) {
        throw error;
      }
    }
    groups.push({ id, cluster });
    if (cluster !== null) {
      clusters.add(cluster);
    }
  }
  if (filter === null || groups.length === 0) {
    for (const clusterId of databases.clusterIds) {
      clusters.add(clusterId);
    }
  }
  return { groups, knownGroupHexes, clusters: [...clusters] };
}
