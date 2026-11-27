import { randomBytes } from 'node:crypto';
import type { Db, MongoClient } from 'mongodb';
import { createMongoClient } from '../../src/db/client.ts';
import { Secret } from '../../src/secret.ts';

/** Name of the only variable that tells the suite where MongoDB is. */
export const TEST_URI_VARIABLE = 'FLOOD_CLOUD_TEST_MONGO_URI';

/** Every test database name starts with this prefix. */
export const TEST_DB_PREFIX = 'flood_cloud_test_';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_DATABASE_NAME = /^flood_cloud_test_[0-9a-f]{6,12}(_(development|production)_(common|queue|[0-9a-f]{24}))?$/;

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
    const host = entry.startsWith('[') ? entry.slice(0, entry.indexOf(']') + 1) : (entry.split(':', 1)[0] ?? '');
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
 *
 * @param name Database name to check.
 * @throws {Error} If the name could belong to a real environment.
 */
export function assertSafeTestDatabaseName(name: string): void {
  if (!SAFE_DATABASE_NAME.test(name)) {
    throw new Error(`Refusing database "${name}": not a flood_cloud_test_ throw-away database`);
  }
}

/** Reads and checks the test MongoDB URI. */
export function testMongoUri(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const uri = env[TEST_URI_VARIABLE];
  if (uri === undefined || uri === '') {
    throw new Error(
      `${TEST_URI_VARIABLE} is not set: integration tests need the local MongoDB ` +
        '(docker compose -f einvoicing-worker/compose.yaml up -d --wait, then copy einvoicing-worker/.env.test.example to einvoicing-worker/.env.test)',
    );
  }
  assertSafeTestUri(uri);
  return uri;
}

/** Creates a connected client, through the production factory, pointed at the test MongoDB. */
export async function createTestClient(): Promise<MongoClient> {
  const client = createMongoClient({ mongodbUri: new Secret(testMongoUri()), appEnv: 'development' });
  await client.connect();
  return client;
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
  const client = await createTestClient();
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

/** A random `flood_cloud_test_<hex>_` database name prefix (short: names are limited to 63 characters). */
export function randomTestPrefix(): string {
  return `${TEST_DB_PREFIX}${randomBytes(3).toString('hex')}_`;
}

/**
 * Drops every database whose name starts with a test prefix (each name is checked first), then closes the client.
 *
 * @param client Connected client.
 * @param prefix A `flood_cloud_test_<hex>_` prefix.
 */
export async function dropPrefixAndClose(client: MongoClient, prefix: string): Promise<void> {
  const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
  for (const { name } of databases) {
    if (name.startsWith(prefix)) {
      assertSafeTestDatabaseName(name);
      await client.db(name).dropDatabase();
    }
  }
  await client.close();
}
