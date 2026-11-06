import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { loadDatabaseConfig } from '../../src/config.ts';
import { createMongoClient } from '../../src/db/client.ts';
import { main } from '../../src/tools/migrate-dealers/main.ts';
import { migrateDealers } from '../../src/tools/migrate-dealers/migrate.ts';
import { fixtureId, legacyGroup, legacyUser } from '../helpers/legacy-fixtures.ts';
import { mongoEnv, openTestDatabases, testMongoUri } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const CLI = fileURLToPath(new URL('../../src/tools/migrate-dealers/cli.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../../src/tools/migrate-dealers', import.meta.url));
const NOW = new Date('2026-11-06T10:00:00.000Z');

interface Run {
  code: number;
  info: string[];
  error: string[];
}

let ctx: TestDatabases;
const common = () => ctx.databases.common();
const users = () => common().collection('users');
const groups = () => common().collection('groups');
const dealers = () => common().collection('dealers');
const env = (overrides: Record<string, string | undefined> = {}) => mongoEnv({ DB_NAME_PREFIX: ctx.prefix, ...overrides }) as Record<string, string>;

async function run(argv: string[], variables: Record<string, string | undefined> = env(), loadEnvFile: () => void = () => undefined): Promise<Run> {
  const info: string[] = [];
  const error: string[] = [];
  const code = await main(argv, { env: variables, loadEnvFile, info: (line) => info.push(line), error: (line) => error.push(line), now: () => NOW });
  return { code, info, error };
}

const everything = async (): Promise<{ users: Document[]; groups: Document[] }> => ({
  users: await users().find({}).sort({ _id: 1 }).toArray(),
  groups: await groups().find({}).sort({ _id: 1 }).toArray(),
});

const dealerUser = (n: number, overrides: Document = {}): Document => legacyUser(n, { role: 'D', userName: `dealer-name-${String(n)}`, ...overrides });

/** The ids and user names of the fixtures, which must never appear in the output of the tool. */
let secrets: string[] = [];

beforeEach(async () => {
  ctx = await openTestDatabases();
  const noName = fixtureId('user', 14);
  await users().insertMany([
    legacyUser(10, { role: 'PSA' }),
    legacyUser(11, { role: 'SA' }),
    dealerUser(12),
    dealerUser(13, { trash: true, status: false }),
    dealerUser(14, { userName: undefined }),
    dealerUser(15, { userName: '  Padded Name  ' }),
    dealerUser(16, { userName: undefined, username: 'older-field-name' }),
    dealerUser(17, { userName: 'x'.repeat(300) }),
    dealerUser(18, { userName: '   ' }),
    dealerUser(19, { userName: 5 }),
  ]);
  await groups().insertMany([legacyGroup(1, { dealerId: fixtureId('user', 12) }), legacyGroup(2, { dealerId: noName })]);
  secrets = [...(await users().find({}).toArray()).flatMap((user) => [String(user['_id']), String(user['userName'])])].filter((text) => text.length > 5);
});

afterEach(async () => {
  await ctx.cleanup();
});

describe('migrate-dealers: dry run (the default)', () => {
  it('counts the dealer users and writes nothing, not even the collection', async () => {
    const before = await everything();
    const result = await run([]);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(result.info, ['Dry run on development, nothing written: dealer users 8, already registered 0, to create 8. Run again with --apply to write them']);
    assert.deepEqual(await everything(), before);
    assert.deepEqual(await common().listCollections({ name: 'dealers' }, { nameOnly: true }).toArray(), []);
  });

  it('counts the dealers that already have a document as present', async () => {
    await ctx.databases.common().createCollection('dealers');
    await dealers().insertOne({ _id: fixtureId('user', 12), businessName: 'Kept' });
    const result = await run(['--env', 'development']);
    assert.equal(result.code, 0, result.error.join());
    assert.match(result.info.join(), /dealer users 8, already registered 1, to create 7/);
    assert.equal(await dealers().countDocuments(), 1);
  });

  it('prints no user name, no id and no connection string', async () => {
    const result = await run([]);
    const output = [...result.info, ...result.error].join('\n');
    for (const secret of secrets) {
      assert.ok(!output.includes(secret), secret);
    }
    assert.ok(!output.includes(testMongoUri()));
  });
});

describe('migrate-dealers --apply', () => {
  it('gives each dealer user a document with his _id, the user name as company name and nothing else', async () => {
    const before = await everything();
    const result = await run(['--apply']);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(result.info, ['Applied on development: dealer users 8, created 8, already present 0, errors 0']);
    assert.deepEqual(await everything(), before, 'users and groups are never written');

    const stored = new Map((await dealers().find({}).toArray()).map((document) => [document._id.toHexString(), document]));
    assert.equal(stored.size, 8);
    const nameOf = (n: number) => stored.get(fixtureId('user', n).toHexString())!['businessName'];
    assert.equal(nameOf(12), 'dealer-name-12');
    assert.equal(nameOf(13), 'dealer-name-13', 'a trashed dealer user counts too');
    assert.equal(nameOf(14), `dealer-${fixtureId('user', 14).toHexString().slice(-6)}`);
    assert.equal(nameOf(15), 'Padded Name');
    assert.equal(nameOf(16), 'older-field-name');
    assert.equal(nameOf(17), 'x'.repeat(200));
    assert.equal(nameOf(18), `dealer-${fixtureId('user', 18).toHexString().slice(-6)}`);
    assert.equal(nameOf(19), `dealer-${fixtureId('user', 19).toHexString().slice(-6)}`);
    for (const document of stored.values()) {
      assert.deepEqual({ ...document, _id: undefined, businessName: undefined }, {
        _id: undefined,
        businessName: undefined,
        vatNumber: null,
        fiscalCode: null,
        address: null,
        pec: null,
        sdiCode: null,
        email: null,
        phone: null,
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: null,
        source: 'migration',
      });
    }
    assert.equal(stored.has(fixtureId('user', 10).toHexString()) || stored.has(fixtureId('user', 11).toHexString()), false);
  });

  it('creates the collection with its validator and unique VAT index, and no other collection of the registry', async () => {
    assert.equal((await run(['--apply'])).code, 0);
    const names = (await common().listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name).sort();
    assert.deepEqual(names, ['dealers', 'groups', 'users']);
    const index = (await dealers().indexes()).find((entry) => entry.name === 'vatNumber_1')!;
    assert.deepEqual([index.unique, index.partialFilterExpression], [true, { vatNumber: { $type: 'string' } }]);
    await assert.rejects(dealers().insertOne({ _id: new ObjectId(), businessName: '' }), { code: 121 });
  });

  it('is idempotent: running it again changes nothing, and it never overwrites a dealer the owner completed', async () => {
    assert.equal((await run(['--apply'])).code, 0);
    await dealers().updateOne({ _id: fixtureId('user', 12) }, { $set: { businessName: 'Completed Srl', vatNumber: '12345678901', updatedAt: new Date('2026-11-07T00:00:00Z') } });
    const before = await dealers().find({}).sort({ _id: 1 }).toArray();
    const again = await run(['--apply']);
    assert.equal(again.code, 0, again.error.join());
    assert.deepEqual(again.info, ['Applied on development: dealer users 8, created 0, already present 8, errors 0']);
    assert.deepEqual(await dealers().find({}).sort({ _id: 1 }).toArray(), before);
  });

  it('keeps going and exits 1 when some documents cannot be written', async () => {
    // Two dealer users with the same name collide on a unique index of the test: one document is written, one fails.
    await common().createCollection('dealers');
    await dealers().createIndex({ businessName: 1 }, { unique: true });
    await users().updateOne({ _id: fixtureId('user', 13) }, { $set: { userName: 'dealer-name-12' } });
    const result = await run(['--apply']);
    assert.equal(result.code, 1);
    assert.deepEqual(result.info, ['Applied on development: dealer users 8, created 7, already present 0, errors 1']);
    assert.deepEqual(result.error, ['A dealer could not be written: MongoServerError']);
    assert.equal(await dealers().countDocuments(), 7);
    const output = [...result.info, ...result.error].join('\n');
    for (const secret of secrets) {
      assert.ok(!output.includes(secret), secret);
    }
  });

  it('does not stop when the database user lacks collMod: the problem is reported and the dealers are still written', async () => {
    await common().createCollection('dealers');
    const info: string[] = [];
    const errors: string[] = [];
    const code = await main(['--apply'], {
      env: env(),
      loadEnvFile: () => undefined,
      info: (line) => info.push(line),
      error: (line) => errors.push(line),
      createClient: (config, options) => {
        const client = createMongoClient(config, options);
        const open = client.db.bind(client);
        client.db = ((name?: string) => {
          const db = open(name);
          const command = db.command.bind(db);
          db.command = ((body: Document, ...rest: unknown[]) =>
            'collMod' in body ? Promise.reject(Object.assign(new Error('not allowed'), { code: 13 })) : (command as (...args: unknown[]) => Promise<Document>)(body, ...rest)) as typeof db.command;
          return db;
        }) as typeof client.db;
        return client;
      },
    });
    assert.equal(code, 0, errors.join());
    assert.deepEqual(errors, ['validator out of date for dealers: the database user needs the collMod privilege; application-level validation still applies']);
    assert.match(info.join(), /created 8/);
  });

  it('writes only to dealers: the sources touch no other collection', async () => {
    const writes = /\.(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndReplace|findOneAndDelete|drop|createIndex|createIndexes|createCollection|renameCollection)\(/g;
    for (const file of await readdir(SRC)) {
      const text = await readFile(join(SRC, file), 'utf8');
      for (const match of text.matchAll(writes)) {
        const before = text.slice(Math.max(0, match.index - 12), match.index);
        assert.ok(before.endsWith('dealers'), `${file}: a write on something other than dealers (${before})`);
      }
      assert.ok(!text.includes("collection('groups')"), `${file} opens groups`);
    }
  });
});

describe('migrate-dealers: environment and clusters', () => {
  it('refuses to run when --env and APP_ENV disagree, in either direction, and writes nothing', async () => {
    for (const [argv, appEnv] of [[['--apply'], 'production'], [['--env', 'production', '--apply'], 'development'], [['--env', 'development', '--apply'], 'production']] as const) {
      const result = await run([...argv], env({ APP_ENV: appEnv, MONGODB_URI: appEnv === 'production' ? 'mongodb://127.0.0.1:1/?tls=true' : testMongoUri() }));
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.error.join(), /does not match/);
    }
    assert.deepEqual(await common().listCollections({ name: 'dealers' }, { nameOnly: true }).toArray(), []);
  });

  it('keeps the TLS rule of production and never connects when it fails', async () => {
    const weak = await run(['--env', 'production'], env({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:27027/?directConnection=true' }));
    assert.equal(weak.code, 1);
    assert.match(weak.error.join(), /MONGODB_URI: must use TLS in production/);
  });

  it('runs on production when asked, only on the production common database', async () => {
    const prod = await openTestDatabases('production');
    try {
      await prod.databases.common().collection('users').insertOne(dealerUser(30));
      const info: string[] = [];
      const error: string[] = [];
      const code = await main(['--env', 'production', '--apply'], {
        env: {},
        loadEnvFile: () => undefined,
        info: (line) => info.push(line),
        error: (line) => error.push(line),
        // The TLS rule is not weakened: the loader and client factory are replaced because the local server has no TLS.
        loadDatabaseConfig: () => ({ ...loadDatabaseConfig(env()), appEnv: 'production', dbNamePrefix: prod.prefix }),
        createClient: (config, options) => createMongoClient({ ...config, appEnv: 'development' }, options),
      });
      assert.equal(code, 0, error.join());
      assert.deepEqual(info, ['Applied on production: dealer users 1, created 1, already present 0, errors 0']);
      assert.equal(await prod.databases.common().collection('dealers').countDocuments(), 1);
      assert.deepEqual(await common().listCollections({ name: 'dealers' }, { nameOnly: true }).toArray(), []);
    } finally {
      await prod.cleanup();
    }
  });

  it('opens only the common cluster', async () => {
    const uri = testMongoUri();
    const opened: string[] = [];
    const info: string[] = [];
    const code = await main(['--apply'], {
      env: env({ MONGODB_URI: undefined, MONGODB_CLUSTERS: 'cluster0,cluster1,cluster2', MONGODB_COMMON_CLUSTER: 'cluster1', MONGODB_URI_CLUSTER0: 'mongodb://127.0.0.1:1/?directConnection=true', MONGODB_URI_CLUSTER1: uri, MONGODB_URI_CLUSTER2: 'mongodb://127.0.0.1:2/?directConnection=true' }),
      loadEnvFile: () => undefined,
      info: (line) => info.push(line),
      error: () => undefined,
      createClient: (config, options) => {
        opened.push(config.mongodbUri.reveal());
        return createMongoClient(config, options);
      },
    });
    assert.equal(code, 0, info.join());
    assert.deepEqual(opened, [uri, uri]);
    assert.equal(await dealers().countDocuments(), 8);
  });

  it('reports a close that fails without the connection string', async () => {
    const uri = testMongoUri();
    const errors: string[] = [];
    const code = await main([], {
      env: env({ MONGODB_ANALYTICS_URI: uri }),
      loadEnvFile: () => undefined,
      info: () => undefined,
      error: (line) => errors.push(line),
      createClient: (config, options) => {
        const client = createMongoClient(config, options);
        const close = client.close.bind(client);
        client.close = async () => {
          await close();
          throw new Error(`close failed for ${uri}`);
        };
        return client;
      },
    });
    assert.equal(code, 0);
    assert.equal(errors.filter((line) => line.startsWith('Error: close failed')).length, 2);
    assert.ok(errors.every((line) => !line.includes(uri)));
  });
});

describe('migrate-dealers: command line and configuration', () => {
  it('accepts exactly --env <name> and --apply, once each', async () => {
    for (const argv of [['--env'], ['--env', 'staging'], ['--env', 'PRODUCTION'], ['--apply', '--apply'], ['--env', 'development', '--env', 'development'], ['--bogus'], ['apply'], ['--apply=true'], ['--out', 'x']]) {
      const result = await run(argv);
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.error.join(), /Usage/);
    }
    assert.equal((await run(['--apply', '--env', 'development'])).code, 0);
  });

  it('reports configuration problems by variable name', async () => {
    const result = await run([], {}, () => {
      throw Object.assign(new Error('ENOENT: no .env'), { code: 'ENOENT' });
    });
    assert.equal(result.code, 1);
    assert.match(result.error.join(), /APP_ENV: is required/);
  });

  it('tolerates only a missing .env file', async () => {
    const other = await run([], env(), () => {
      throw Object.assign(new Error('EISDIR: is a directory'), { code: 'EISDIR' });
    });
    assert.equal(other.code, 1);
    assert.match(other.error.join(), /EISDIR/);
    const thrown = await run([], env(), () => {
      throw 'not an error object';
    });
    assert.equal(thrown.code, 1);
    assert.match(thrown.error.join(), /Unknown error/);
  });

  it('fails cleanly when MongoDB is unreachable, without printing the URI', async () => {
    const uri = 'mongodb://127.0.0.1:1/?directConnection=true';
    const result = await run(['--apply'], env({ MONGODB_URI: uri, MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' }));
    assert.equal(result.code, 1);
    assert.ok(result.error.length > 0);
    assert.ok(!result.error.join().includes(uri));
  });
});

describe('migrateDealers (unit)', () => {
  it('counts a write that failed with something that is not an Error by its type only', async () => {
    const errors: string[] = [];
    const fake = {
      collection: (name: string) =>
        name === 'users'
          ? { find: () => (async function* () { yield { _id: new ObjectId(), userName: 'a-secret-name' }; })() }
          : { updateOne: () => Promise.reject('plain string with a-secret-name') },
    } as unknown as Db;
    const report = await migrateDealers(fake, { apply: true, now: () => NOW, onError: (name) => errors.push(name) });
    assert.deepEqual(report, { dealerUsers: 1, alreadyPresent: 0, created: 0, errors: 1 });
    assert.deepEqual(errors, ['string']);
  });

  it('counts an upsert that matched as already present', async () => {
    const fake = {
      collection: (name: string) =>
        name === 'users'
          ? { find: () => (async function* () { yield { _id: new ObjectId() }; })() }
          : { updateOne: () => Promise.resolve({ upsertedCount: 0 }) },
    } as unknown as Db;
    const report = await migrateDealers(fake, { apply: true, now: () => NOW, onError: () => undefined });
    assert.deepEqual(report, { dealerUsers: 1, alreadyPresent: 1, created: 0, errors: 0 });
  });
});

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the real CLI in an empty directory that holds only the given `.env`; the parent environment is not inherited. */
async function runCli(args: string[], dotEnv: string | undefined): Promise<Outcome> {
  const cwd = await mkdtemp(join(tmpdir(), 'flood-migrate-'));
  try {
    if (dotEnv !== undefined) {
      await writeFile(join(cwd, '.env'), dotEnv);
    }
    return await new Promise<Outcome>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env: process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {} });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const dotEnv = (overrides: Record<string, string | undefined> = {}): string =>
  Object.entries(env(overrides))
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

describe('node src/tools/migrate-dealers/cli.ts', () => {
  it('reads .env and, by default, only counts', async () => {
    const outcome = await runCli([], dotEnv());
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(outcome.stdout, /^Dry run on development, nothing written: dealer users 8, already registered 0, to create 8/);
    assert.equal(await dealers().countDocuments(), 0);
  });

  it('writes with --apply', async () => {
    const outcome = await runCli(['--apply'], dotEnv());
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(outcome.stdout, /created 8/);
    assert.equal(await dealers().countDocuments(), 8);
  });

  it('exits 1 when there is no .env and no environment, on unknown arguments and on another environment', async () => {
    const missing = await runCli([], undefined);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /APP_ENV/);
    const unknown = await runCli(['--bogus'], dotEnv());
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Usage/);
    const other = await runCli([], dotEnv({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/?tls=true' }));
    assert.equal(other.code, 1);
    assert.match(other.stderr, /does not match/);
  });
});
