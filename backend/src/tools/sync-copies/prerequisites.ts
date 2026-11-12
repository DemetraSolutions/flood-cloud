import type { ClusterId } from '../../config.ts';
import type { Databases } from '../../db/databases.ts';

/** Oldest MongoDB server that supports the transactions across databases of a replica set used by the copy blocks. */
export const MIN_SERVER_VERSION = '4.4';

/** What was verified on a cluster. */
export interface ClusterCheck {
  readonly clusterId: ClusterId;
  /** Server version, for example `8.0.4`. */
  readonly version: string;
  /** Name of the replica set. */
  readonly replicaSet: string;
}

/**
 * Checks the facts of one cluster (`doc/Tasks.md` 5.1.1): version at least {@link MIN_SERVER_VERSION} and a replica set.
 *
 * @param clusterId Cluster checked (only used in the messages).
 * @param version Server version string.
 * @param replicaSet Replica set name, `null` for a standalone server.
 * @returns The verified facts.
 * @throws {Error} If the version is older or unreadable, or the server is not part of a replica set.
 */
export function assertSupportedServer(clusterId: ClusterId, version: string, replicaSet: string | null): ClusterCheck {
  const match = /^(\d+)\.(\d+)/.exec(version);
  const [minMajor, minMinor] = MIN_SERVER_VERSION.split('.').map(Number) as [number, number];
  if (match === null || Number(match[1]) < minMajor || (Number(match[1]) === minMajor && Number(match[2]) < minMinor)) {
    throw new Error(`Cluster ${clusterId}: MongoDB ${version} is not supported, ${MIN_SERVER_VERSION} or later is required`);
  }
  if (replicaSet === null) {
    throw new Error(`Cluster ${clusterId}: MongoDB ${version} is not a replica set, transactions are not available`);
  }
  return { clusterId, version, replicaSet };
}

/**
 * Reads and checks version and replica set of the given clusters, in order.
 *
 * @param databases Database accessor.
 * @param clusterIds Clusters used by the run.
 * @returns One check per cluster.
 * @throws {Error} At the first cluster that does not satisfy {@link assertSupportedServer}.
 */
export async function checkClusters(databases: Databases, clusterIds: readonly ClusterId[]): Promise<ClusterCheck[]> {
  const checks: ClusterCheck[] = [];
  for (const clusterId of clusterIds) {
    checks.push(assertSupportedServer(clusterId, await databases.serverVersion(clusterId), await databases.replicaSetName(clusterId)));
  }
  return checks;
}
