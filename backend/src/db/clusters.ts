import type { MongoClient } from 'mongodb';
import type { ClusterId, DatabaseConfig } from '../config.ts';
import { createMongoClient } from './client.ts';
import type { MongoClientConfig, MongoClientOptions } from './client.ts';

/** Builds a client from a connection string and options; {@link createMongoClient} by default, replaceable in tests. */
export type ClientFactory = (config: MongoClientConfig, options?: MongoClientOptions) => MongoClient;

/**
 * The two connections of one cluster.
 *
 * - `main` serves reads and writes.
 * - `analytics` serves heavy reads only. With a dedicated `MONGODB_ANALYTICS_URI*` it is a separate client
 *   toward that node with `readPreference: 'secondary'`; without one it is a second client on the main
 *   connection string with `readPreference: 'secondaryPreferred'`. Nothing writes through it: `databases.ts`
 *   exposes it only as read-only handles.
 */
export interface ClusterClients {
  readonly main: MongoClient;
  readonly analytics: MongoClient;
}

/** All the process-wide MongoDB clients and the cluster roles. */
export interface ClusterRegistry {
  /** The clients of every configured cluster, in configuration order. */
  readonly clusters: ReadonlyMap<ClusterId, ClusterClients>;
  /** Cluster of the common database: login and common data live here only. */
  readonly commonCluster: ClusterId;
  /** Cluster of the groups whose document has no `dataCluster`. */
  readonly defaultGroupCluster: ClusterId;
}

/**
 * Creates (without connecting) the main and analytics clients of every configured cluster.
 *
 * @param config The database configuration.
 * @param factory Client factory, {@link createMongoClient} by default.
 * @returns The registry.
 * @throws {Error} If a connection string cannot be parsed or, in production, does not use strict TLS
 * (driver errors never echo credentials).
 */
export function createClusterClients(config: DatabaseConfig, factory: ClientFactory = createMongoClient): ClusterRegistry {
  const clusters = new Map<ClusterId, ClusterClients>();
  for (const [id, cluster] of config.clusters) {
    const base = {
      mongodbServerSelectionTimeoutMs: config.mongodbServerSelectionTimeoutMs,
      mongodbMaxPoolSize: config.mongodbMaxPoolSize,
      appEnv: config.appEnv,
    };
    clusters.set(id, {
      main: factory({ ...base, mongodbUri: cluster.uri }),
      analytics:
        cluster.analyticsUri === null
          ? factory({ ...base, mongodbUri: cluster.uri }, { readPreference: 'secondaryPreferred' })
          : factory({ ...base, mongodbUri: cluster.analyticsUri }, { readPreference: 'secondary' }),
    });
  }
  return { clusters, commonCluster: config.commonCluster, defaultGroupCluster: config.defaultGroupCluster };
}

/** Which client of which cluster failed to connect. */
export interface ConnectFailure {
  readonly clusterId: ClusterId;
  readonly role: 'main' | 'analytics';
  /** Error class name only: driver messages may echo hosts. */
  readonly errorName: string;
}

/**
 * Connects the main client of the common cluster (awaited, failure propagates) and starts connecting
 * every other client without blocking: their failures go to `onFailure` (id and role only, never the URI)
 * and the driver reconnects on first use.
 *
 * @param registry The clients.
 * @param onFailure Called for each background failure.
 * @returns `background`, which settles when every other connection attempt has finished (it never rejects);
 * the function itself resolves as soon as the common cluster is connected.
 * @throws {Error} If the common cluster cannot be reached.
 */
export async function connectClusters(
  registry: ClusterRegistry,
  onFailure: (failure: ConnectFailure) => void,
): Promise<{ readonly background: Promise<void> }> {
  const commonMain = (registry.clusters.get(registry.commonCluster) as ClusterClients).main;
  await commonMain.connect();
  const attempts: Array<Promise<void>> = [];
  const started = new Set<MongoClient>([commonMain]);
  for (const [clusterId, clients] of registry.clusters) {
    for (const [role, client] of [['main', clients.main], ['analytics', clients.analytics]] as const) {
      if (started.has(client)) {
        continue;
      }
      started.add(client);
      attempts.push(
        client.connect().then(
          () => undefined,
          (error: unknown) => onFailure({ clusterId, role, errorName: error instanceof Error ? error.name : typeof error }),
        ),
      );
    }
  }
  return { background: Promise.all(attempts).then(() => undefined) };
}

/**
 * Closes every client (a client shared by two roles is closed once). Each close is attempted even if another fails.
 *
 * @param registry The clients.
 * @param onError Called with the cluster id and the error of each failed close.
 * @returns `true` when all closed cleanly, `false` otherwise (failures are reported to `onError`).
 */
export async function closeClusters(registry: ClusterRegistry, onError: (clusterId: ClusterId, error: unknown) => void): Promise<boolean> {
  let clean = true;
  const closed = new Set<MongoClient>();
  for (const [clusterId, clients] of registry.clusters) {
    for (const client of [clients.main, clients.analytics]) {
      if (closed.has(client)) {
        continue;
      }
      closed.add(client);
      try {
        await client.close();
      } catch (error) {
        clean = false;
        onError(clusterId, error);
      }
    }
  }
  return clean;
}
