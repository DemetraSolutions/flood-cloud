import { randomBytes } from 'node:crypto';
import type { Db, MongoClient } from 'mongodb';
import type { AppEnv } from '../../src/config.ts';
import { createMongoClient } from '../../src/db/client.ts';
import type { ClusterRegistry } from '../../src/db/clusters.ts';
import { closeClusters, connectClusters, createClusterClients } from '../../src/db/clusters.ts';
import { createDatabases } from '../../src/db/databases.ts';
import { loadDatabaseConfig } from '../../src/config.ts';
import type { Databases } from '../../src/db/databases.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { validEnv } from './app.ts';

/** Name of the only variable that tells the suite where MongoDB is. */
export const TEST_URI_VARIABLE = 'FLOOD_CLOUD_TEST_MONGO_URI';

/** Every test database name starts with this prefix. */
export const TEST_DB_PREFIX = 'flood_cloud_test_';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_DATABASE_NAME = /^flood_cloud_test_[0-9a-f]{6,12}(_(development|production)_(common|flite_common|queue|[0-9a-f]{24}))?$/;

/**
 * Refuses any URI that is not a plain local MongoDB: no SRV, no credentials, loopback hosts only,
 * and `directConnection=true` so the driver never follows a replica set to another host.
 *
 * @param uri Connection string to check.
 * @throws {Error} If the URI could reach a real cluster (the message never repeats the URI).
 */
export function assertSafeTestUri(uri: string): void {
  if (uri.startsWith('mongodb+srv://') || !uri.startsWith('mongodb://')) {
    throw new Error('Test MongoDB URI must start with mongodb:// (SRV is refused)');
  }
  const authority = uri.slice('mongodb://'.length).split(/[/?]/, 1)[0] ?? '';
  if (authority.includes('@')) {
    throw new Error('Test MongoDB URI must not contain credentials');
  }
  for (const entry of authority.split(',')) {
    const host = entry.startsWith('[') ? entry.slice(0, entry.indexOf(']') + 1) : entry.split(':', 1)[0] ?? '';
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error('Test MongoDB URI must point to localhost, 127.0.0.1 or [::1]');
    }
  }
  const queryStart = uri.indexOf('?');
  const params = new URLSearchParams(queryStart === -1 ? '' : uri.slice(queryStart + 1));
  if (params.get('directConnection') !== 'true') {
    throw new Error('Test MongoDB URI must set directConnection=true (no topology discovery to other hosts)');
  }
}

/**
 * Refuses any database name that is not a throw-away test database.
 * Accepts `flood_cloud_test_<6 to 12 hex>` and the same followed by `_<env>_(common|flite_common|queue|<groupId>)`.
 *
 * @param name Database name to check.
 * @throws {Error} If the name could belong to a real environment.
 */
export function assertSafeTestDatabaseName(name: string): void {
  if (!SAFE_DATABASE_NAME.test(name)) {
    throw new Error(`Refusing database "${name}": not a flood_cloud_test_ throw-away database`);
  }
}

/**
 * Reads and checks the test MongoDB URI.
 *
 * @param env Environment to read (`process.env` by default).
 * @returns The validated local URI.
 * @throws {Error} If the variable is missing or the URI is unsafe.
 */
export function testMongoUri(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const uri = env[TEST_URI_VARIABLE];
  if (uri === undefined || uri === '') {
    throw new Error(
      `${TEST_URI_VARIABLE} is not set: integration tests need the local MongoDB ` +
        '(docker compose -f backend/compose.yaml up -d --wait, then copy backend/.env.test.example to backend/.env.test)',
    );
  }
  assertSafeTestUri(uri);
  return uri;
}

/** Creates a client through the production factory, pointed at the test MongoDB. */
export function createTestClient(): MongoClient {
  return createMongoClient({
    mongodbUri: new Secret(testMongoUri()),
    mongodbServerSelectionTimeoutMs: 5000,
    mongodbMaxPoolSize: 5,
  });
}

/** Id of the only cluster of the single-cluster test registries. */
export const TEST_CLUSTER = 'cluster0';

/**
 * A one-cluster registry (`cluster0`, common and default) over an existing client; the analytics client is the same unless given.
 *
 * @param client Client used for reads and writes.
 * @param analytics Client used for analytics reads (`client` by default).
 */
export function singleCluster(client: MongoClient, analytics: MongoClient = client): ClusterRegistry {
  return { clusters: new Map([[TEST_CLUSTER, { main: client, analytics }]]), commonCluster: TEST_CLUSTER, defaultGroupCluster: TEST_CLUSTER };
}

/** Disposable database for a test file. */
export interface TestDatabase {
  readonly client: MongoClient;
  readonly db: Db;
  readonly name: string;
  /** Drops the database and closes the client. */
  drop(): Promise<void>;
}

/** Opens a connected client and a random `flood_cloud_test_<hex>` database. */
export async function openTestDatabase(): Promise<TestDatabase> {
  const client = createTestClient();
  await client.connect();
  const name = `${TEST_DB_PREFIX}${randomBytes(6).toString('hex')}`;
  assertSafeTestDatabaseName(name);
  const db = client.db(name);
  return {
    client,
    db,
    name,
    drop: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}

/** Production-style databases (common + groups) under a random test prefix. */
export interface TestDatabases {
  readonly client: MongoClient;
  readonly databases: Databases;
  /** `flood_cloud_test_<hex>_`: pass it as `DB_NAME_PREFIX`. */
  readonly prefix: string;
  readonly appEnv: AppEnv;
  /** Drops every database that starts with `prefix` and closes the client. */
  cleanup(): Promise<void>;
}

/**
 * Opens `createDatabases` over the test MongoDB with a random prefix.
 *
 * @param appEnv Environment used in the names (`development` by default).
 */
export async function openTestDatabases(appEnv: AppEnv = 'development'): Promise<TestDatabases> {
  const client = createTestClient();
  await client.connect();
  // Short on purpose: a database name is limited to 63 characters (prefix + env + 24 hex of the group).
  const prefix = `${TEST_DB_PREFIX}${randomBytes(3).toString('hex')}_`;
  return {
    client,
    databases: createDatabases(singleCluster(client), { prefix, appEnv }),
    prefix,
    appEnv,
    cleanup: async () => {
      await dropDatabasesWithPrefix(client, prefix);
      await client.close();
    },
  };
}

/**
 * Drops every database whose name starts with a test prefix (each name is checked first).
 *
 * @param client Connected client.
 * @param prefix A `flood_cloud_test_<hex>_` prefix.
 */
export async function dropDatabasesWithPrefix(client: MongoClient, prefix: string): Promise<void> {
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  for (const { name } of databases) {
    if (name.startsWith(prefix)) {
      assertSafeTestDatabaseName(name);
      await client.db(name).dropDatabase();
    }
  }
}

/**
 * A valid server environment pointing at the test MongoDB with a random database prefix.
 * Child processes and `run()` tests use it so they never touch a real cluster.
 *
 * @param overrides Variables to add or replace.
 */
export function mongoEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return validEnv({
    MONGODB_URI: testMongoUri(),
    DB_NAME_PREFIX: `${TEST_DB_PREFIX}${randomBytes(3).toString('hex')}_`,
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: '2000',
    ...overrides,
  });
}

/** Two clusters (`cluster0`, `cluster1`) over the one local MongoDB, with distinct clients so routing is observable. */
export interface TestClusters {
  readonly registry: ClusterRegistry;
  readonly databases: Databases;
  /** `flood_cloud_test_<hex>_`: the database name prefix. */
  readonly prefix: string;
  /** Names passed to `client.db()` through each client, keyed `<cluster>:<main|analytics>`. */
  readonly opened: ReadonlyMap<string, string[]>;
  /** Drops every database of the prefix and closes all clients. */
  cleanup(): Promise<void>;
}

/**
 * Opens two clusters pointing at the same local MongoDB, each with its own main and analytics client.
 * Cluster `cluster1` has a dedicated analytics URI, `cluster0` does not.
 *
 * @param env Extra variables for the cluster configuration (for example the common or default cluster).
 */
export async function openTestClusters(env: Record<string, string | undefined> = {}): Promise<TestClusters> {
  const uri = testMongoUri();
  const prefix = `${TEST_DB_PREFIX}${randomBytes(3).toString('hex')}_`;
  const config = loadDatabaseConfig({
    APP_ENV: 'development',
    DB_NAME_PREFIX: prefix,
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: '2000',
    MONGODB_CLUSTERS: 'cluster0,cluster1',
    MONGODB_URI_CLUSTER0: uri,
    MONGODB_URI_CLUSTER1: uri,
    MONGODB_ANALYTICS_URI_CLUSTER1: uri,
    ...env,
  });
  const registry = createClusterClients(config);
  const opened = new Map<string, string[]>();
  for (const [clusterId, clients] of registry.clusters) {
    for (const role of ['main', 'analytics'] as const) {
      const client = clients[role];
      const names: string[] = [];
      opened.set(`${clusterId}:${role}`, names);
      const original = client.db.bind(client);
      (client as { db: MongoClient['db'] }).db = (name?: string) => {
        names.push(String(name));
        return original(name);
      };
    }
  }
  const { background } = await connectClusters(registry, () => undefined);
  await background;
  return {
    registry,
    databases: createDatabases(registry, { prefix, appEnv: 'development' }),
    prefix,
    opened,
    cleanup: async () => {
      await dropDatabasesWithPrefix((registry.clusters.get('cluster0') as { main: MongoClient }).main, prefix);
      await closeClusters(registry, () => undefined);
    },
  };
}
