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
import { main } from '../../src/tools/purge-trashed-groups/main.ts';
import type { MainDeps } from '../../src/tools/purge-trashed-groups/main.ts';
import { MAX_GROUP_LINES } from '../../src/tools/purge-trashed-groups/report.ts';
import { USER_BATCH } from '../../src/tools/purge-trashed-groups/purge.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace, legacyUser } from '../helpers/legacy-fixtures.ts';
import { TEST_DB_PREFIX, assertSafeTestDatabaseName, mongoEnv, openTestDatabases, testMongoUri } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const CLI = fileURLToPath(new URL('../../src/tools/purge-trashed-groups/cli.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../../src/tools/purge-trashed-groups', import.meta.url));
const NOW = new Date('2026-11-18T10:00:00.000Z');

interface Run {
  code: number;
  info: string[];
  error: string[];
}

let ctx: TestDatabases;
let strangers: string[] = [];
const common = (): Db => ctx.databases.common();
const groupDb = (n: number): Db => ctx.databases.group(G(n), 'cluster0');
const G = (n: number): ObjectId => fixtureId('group', n);
const hex = (n: number): string => G(n).toHexString();
const env = (overrides: Record<string, string | undefined> = {}) => mongoEnv({ DB_NAME_PREFIX: ctx.prefix, ...overrides }) as Record<string, string>;

async function run(argv: string[], overrides: Partial<MainDeps> = {}, variables: Record<string, string | undefined> = env()): Promise<Run> {
  const info: string[] = [];
  const error: string[] = [];
  const code = await main(argv, { env: variables, loadEnvFile: () => undefined, info: (line) => info.push(line), error: (line) => error.push(line), now: () => NOW, sleep: async () => undefined, ...overrides });
  return { code, info, error };
}

/** Dry run with the given arguments, then `--apply` with the count and the digest it printed: the way an operator uses the tool. */
async function applyRun(args: string[], overrides: Partial<MainDeps> = {}, variables: Record<string, string | undefined> = env()): Promise<Run> {
  const dry = await run(args, overrides, variables);
  const count = /purgeable (\d+)/.exec(dry.info[0] ?? '');
  const digest = /Selection digest: ([0-9a-f]{16})/.exec(dry.info.join('\n'));
  assert.ok(count !== null && digest !== null, `the dry run did not print a selection: ${dry.info.join(' | ')} ${dry.error.join(' | ')}`);
  return run([...args, '--apply', '--expect', count[1]!, '--expect-digest', digest[1]!], overrides, variables);
}

/** The user ids of the fixtures of group `n`: two with a group role, one PSA and one D that carry the id of the group. */
const userId = (n: number, k: number): ObjectId => fixtureId('user', 100 * n + k);

/** Documents of a group that exist in the common database and, for the group database, inside it. */
interface SeedOptions {
  trash?: unknown;
  groupExtra?: Document;
  withDatabase?: boolean;
}

/** Seeds one group with its group database, copies, users, sessions, credentials and dependent data. */
async function seedGroup(n: number, options: SeedOptions = {}): Promise<void> {
  await common().collection('groups').insertOne(legacyGroup(n, { trash: options.trash ?? true, databaseHost: null, ...options.groupExtra }));
  if (options.withDatabase !== false) {
    const db = groupDb(n);
    await db.collection('companies').insertMany([legacyCompany(2 * n - 1, G(n)), legacyCompany(2 * n, G(n))]);
    await db.collection('places').insertMany([legacyPlace(2 * n - 1, G(n), fixtureId('company', 2 * n - 1)), legacyPlace(2 * n, G(n), fixtureId('company', 2 * n))]);
    await db.collection('products').insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await db.createCollection('products_view', { viewOn: 'products', pipeline: [] });
  }
  await common().collection('companies').insertMany([legacyCompany(2 * n - 1, G(n)), legacyCompany(2 * n, G(n))]);
  await common().collection('places').insertMany([legacyPlace(2 * n - 1, G(n), fixtureId('company', 2 * n - 1)), legacyPlace(2 * n, G(n), fixtureId('company', 2 * n))]);
  const users = [
    legacyUser(100 * n + 1, { role: 'SA', groupId: G(n) }),
    legacyUser(100 * n + 2, { role: 'E', groupId: G(n) }),
    legacyUser(100 * n + 3, { role: 'PSA', groupId: G(n) }),
    legacyUser(100 * n + 4, { role: 'D', groupId: G(n) }),
  ];
  await common().collection('users').insertMany(users);
  for (const user of users) {
    await common().collection('userCredentials').insertOne({ _id: user._id, passwordHash: 'h', failedLogins: 0 });
    await common().collection('sessions').insertOne({ userId: user._id, accessTokenHash: `a${String(user._id)}`, revokedAt: null });
    await common().collection('idempotencyKeys').insertOne({ principal: (user._id as ObjectId).toHexString(), route: 'POST /v1/x', key: 'k', state: 'done' });
  }
  const keys = [{ _id: new ObjectId(), groupId: G(n), name: 'k1', hash: `h1-${n}` }, { _id: new ObjectId(), groupId: G(n), name: 'k2', hash: `h2-${n}` }];
  await common().collection('apiKeys').insertMany(keys);
  await common().collection('apiUsage').insertMany([
    { keyId: keys[0]!._id, groupId: G(n), day: '2026-11-01', route: 'GET /a' },
    { keyId: keys[0]!._id, groupId: G(n), day: '2026-11-02', route: 'GET /a' },
    { keyId: keys[1]!._id, groupId: G(n), day: '2026-11-01', route: 'GET /a' },
  ]);
  await common().collection('storeKeys').insertOne({ groupId: G(n), placeId: fixtureId('place', 2 * n), keyHash: `s-${n}` });
  await common().collection('storeActivationCodes').insertOne({ groupId: G(n), placeId: fixtureId('place', 2 * n - 1), codeHash: `c-${n}` });
  await common().collection('reserve_with_google').insertOne({ groupId: G(n), placeId: fixtureId('place', 2 * n), name: 'rwg' });
  await common().collection('activityEvents').insertOne({ at: NOW, action: 'user.created', groupId: G(n), category: 'data' });
}

/** The dependants of the two users of group `n` with a group role. */
const dependants = async (n: number): Promise<number> => {
  const ids = [userId(n, 1), userId(n, 2)];
  const hexes = ids.map((id) => id.toHexString());
  return (
    (await common().collection('userCredentials').countDocuments({ _id: { $in: ids } })) +
    (await common().collection('sessions').countDocuments({ userId: { $in: ids } })) +
    (await common().collection('idempotencyKeys').countDocuments({ principal: { $in: hexes } }))
  );
};

/** Everything of group `n` that lives in the common database, as counts. */
async function remaining(n: number): Promise<Record<string, number>> {
  const byGroup = (name: string): Promise<number> => common().collection(name).countDocuments({ groupId: G(n) });
  return {
    group: await common().collection('groups').countDocuments({ _id: G(n) }),
    users: await common().collection('users').countDocuments({ groupId: G(n), role: { $in: ['SA', 'CA', 'PA', 'E'] } }),
    kept: await common().collection('users').countDocuments({ groupId: G(n), role: { $in: ['PSA', 'D'] } }),
    companies: await byGroup('companies'),
    places: await byGroup('places'),
    apiKeys: await byGroup('apiKeys'),
    apiUsage: await byGroup('apiUsage'),
    storeKeys: await byGroup('storeKeys'),
    codes: await byGroup('storeActivationCodes'),
    rwg: await byGroup('reserve_with_google'),
    dependants: await dependants(n),
    database: (await ctx.databases.listGroupIds('cluster0')).filter((id) => id.equals(G(n))).length,
  };
}

const FULL = { group: 1, users: 2, kept: 2, companies: 2, places: 2, apiKeys: 2, apiUsage: 3, storeKeys: 1, codes: 1, rwg: 1, dependants: 6, database: 1 };
const PURGED = { group: 0, users: 0, kept: 2, companies: 0, places: 0, apiKeys: 0, apiUsage: 0, storeKeys: 0, codes: 0, rwg: 0, dependants: 0, database: 0 };

/** Every document of every database of the test prefix, to prove a run wrote nothing. */
async function snapshot(): Promise<Record<string, Document[]>> {
  const result: Record<string, Document[]> = {};
  const { databases } = await ctx.client.db().admin().listDatabases({ nameOnly: true });
  for (const { name } of databases.filter((entry) => entry.name.startsWith(ctx.prefix) || strangers.includes(entry.name))) {
    for (const entry of await ctx.client.db(name).listCollections({}, { nameOnly: true }).toArray()) {
      result[`${name}.${entry.name}`] = await ctx.client.db(name).collection(entry.name).find({}).sort({ _id: 1 }).toArray();
    }
  }
  return result;
}

/** The databases that must never be touched: another environment and another prefix with the group id of group 1, and the queue database. */
async function seedStrangers(): Promise<void> {
  const otherPrefix = `${TEST_DB_PREFIX}a1b2c3_`;
  const names = [`${ctx.prefix}production_${hex(1)}`, `${otherPrefix}development_${hex(1)}`, `${ctx.prefix}development_queue`, `${ctx.prefix}development_flite_common`];
  for (const name of names) {
    assertSafeTestDatabaseName(name);
    await ctx.client.db(name).collection('documents').insertMany([{ n: 1, groupId: G(1) }, { n: 2 }]);
  }
  strangers = names.filter((name) => !name.startsWith(ctx.prefix));
}

beforeEach(async () => {
  ctx = await openTestDatabases();
  strangers = [];
});

afterEach(async () => {
  for (const name of strangers) {
    assertSafeTestDatabaseName(name);
    await ctx.client.db(name).dropDatabase();
  }
  await ctx.cleanup();
});

/** Fixture values that must never appear in the output of the tool. */
const HELD_NONE = 'Held back and not purged: recentlyActive 0, unknownActivity 0, externalHost 0, unusableCluster 0';
const SECRET_PATTERN = /group-0|Name0|Surname0|@example|fixture|mongodb:\/\/|company-|place-/i;

describe('purge-trashed-groups: dry run (the default)', () => {
  it('writes nothing at all (every collection and database is identical afterwards) and reports counts and ids only', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await seedGroup(3, { trash: false });
    await seedStrangers();
    const before = await snapshot();
    const result = await run([]);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(result.error, []);
    assert.equal(result.info[0], 'Dry run on development, nothing written: trashed groups examined 2, purgeable 2');
    assert.equal(result.info[1], 'Held back: recentlyActive 0 (activity newer than 365 days), unknownActivity 0 (documents but no activity date), externalHost 0, unusableCluster 0, possiblyInterrupted 0. Purgeable without a database: withoutDatabase 0');
    const line = 'collections=4 documents=7 users=2 companies=2 places=2 apiKeys=2 apiUsage=3 storeKeys=1 activationCodes=1 reserveWithGoogle=1';
    assert.equal(result.info[2], 'Totals of the purgeable groups: databases 2, collections=8 documents=14 users=4 companies=4 places=4 apiKeys=4 apiUsage=6 storeKeys=2 activationCodes=2 reserveWithGoogle=2, usersKept=4 (users of the groups that are not deleted: PSA, D, or without a group role)');
    assert.match(result.info[3]!, /^Selection digest: [0-9a-f]{16}$/);
    assert.equal(result.info[4], `${hex(1)} ${line} usersKept=2 activeUsers=2 lastActivity=2024-01-15`);
    assert.equal(result.info[5], `${hex(2)} ${line} usersKept=2 activeUsers=2 lastActivity=2024-01-15`);
    assert.equal(result.info[6], `Nothing has been deleted. Take a backup, then run again with the same options plus --apply --expect 2 --expect-digest ${result.info[3]!.slice(-16)}`);
    assert.equal(result.info.length, 7);
    assert.doesNotMatch(result.info.join('\n'), SECRET_PATTERN);
  });

  it('prints at most 50 group lines and then how many more there are', async () => {
    await common().collection('groups').insertMany(Array.from({ length: MAX_GROUP_LINES + 3 }, (_, index) => ({ _id: G(index + 1), trash: true, name: 'secret-name' })));
    const result = await run([]);
    assert.equal(result.code, 0);
    assert.equal(result.info.filter((line) => /^[0-9a-f]{24} /.test(line)).length, MAX_GROUP_LINES);
    assert.ok(result.info.some((line) => line.startsWith('Purgeable but without a database')), 'groups with no database are listed');
    assert.ok(result.info.includes('… and 3 more'));
    assert.match(result.info[0]!, /examined 53, purgeable 53$/);
    assert.doesNotMatch(result.info.join('\n'), /secret-name/);
  });

  it('says so when nothing is in the trash, and never purges a group whose cluster is not configured', async () => {
    await seedGroup(1, { trash: false });
    const empty = await run([]);
    assert.equal(empty.info[0], 'Dry run on development, nothing written: trashed groups examined 0, purgeable 0');
    assert.equal(empty.info[2], 'Totals of the purgeable groups: databases 0, collections=0 documents=0 users=0 companies=0 places=0 apiKeys=0 apiUsage=0 storeKeys=0 activationCodes=0 reserveWithGoogle=0, usersKept=0 (users of the groups that are not deleted: PSA, D, or without a group role)');
    assert.equal(empty.info.at(-1)!.includes('--expect 0 --expect-digest'), true);
    await seedGroup(2, { groupExtra: { dataCluster: 'nowhere' } });
    const unusable = await run([]);
    assert.equal(unusable.code, 0);
    assert.match(unusable.info[0]!, /examined 1, purgeable 0$/);
    assert.match(unusable.info[1]!, /unusableCluster 1/);
    assert.equal(unusable.info.find((line) => line.startsWith(hex(2))), `${hex(2)} held=unusableCluster activeUsers=2 lastActivity=2024-01-15`);
    const before = await snapshot();
    const applied = await applyRun([]);
    assert.equal(applied.code, 0, applied.error.join());
    assert.deepEqual(await snapshot(), before);
  });
});

describe('purge-trashed-groups: selection', () => {
  it('takes only the groups whose trash is exactly the boolean true: not "true", 1, an array that holds true, false or no field', async () => {
    await seedGroup(1);
    await seedGroup(2, { trash: 'true' });
    await seedGroup(3, { trash: 1 });
    await seedGroup(4, { trash: [true] });
    await seedGroup(5, { trash: false });
    await common().collection('groups').insertOne({ _id: G(6), name: 'no trash field' });
    await common().collection('groups').insertOne({ _id: 'not-an-object-id' as unknown as ObjectId, trash: true });
    const before = await snapshot();
    const dry = await run([]);
    assert.match(dry.info[0]!, /purgeable 1$/);
    assert.ok(dry.info.some((line) => line.startsWith(hex(1))));
    const applied = await applyRun([]);
    assert.equal(applied.code, 0, applied.error.join());
    assert.deepEqual(await remaining(1), PURGED);
    for (const n of [2, 3, 4, 5]) {
      assert.deepEqual(await remaining(n), FULL, `group ${n}`);
    }
    assert.equal(await common().collection('groups').countDocuments(), 6);
    const after = await snapshot();
    for (const key of Object.keys(before).filter((name) => !name.includes(hex(1)))) {
      if (key.endsWith('.groups') || key.endsWith('.activityEvents')) {
        continue;
      }
      if (/\.(users|companies|places|apiKeys|apiUsage|storeKeys|storeActivationCodes|reserve_with_google|sessions|userCredentials|idempotencyKeys)$/.test(key)) {
        continue;
      }
      assert.deepEqual(after[key], before[key], key);
    }
  });

  it('--group takes one trashed group and refuses a group that is not in the trash or does not exist, writing nothing', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await seedGroup(3, { trash: false });
    const before = await snapshot();
    const one = await run(['--group', hex(2)]);
    assert.match(one.info[0]!, /purgeable 1$/);
    assert.ok(one.info.some((line) => line.startsWith(hex(2))) && !one.info.some((line) => line.startsWith(hex(1))));
    for (const group of [hex(3), hex(9)]) {
      for (const argv of [['--group', group], ['--group', group, '--apply', '--expect', '1', '--expect-digest', '0123456789abcdef']]) {
        const refused = await run(argv);
        assert.equal(refused.code, 1);
        assert.match(refused.error.join(), /the group given with --group is not in the trash/);
      }
    }
    assert.deepEqual(await snapshot(), before);
    const applied = await applyRun(['--group', hex(2)]);
    assert.equal(applied.code, 0, applied.error.join());
    assert.deepEqual(await remaining(2), PURGED);
    assert.deepEqual(await remaining(1), FULL);
  });

  it('--limit takes the first n by _id, and --group with --limit stays one group', async () => {
    for (const n of [3, 1, 2]) {
      await seedGroup(n);
    }
    const first = await run(['--limit', '2']);
    assert.match(first.info[0]!, /purgeable 2$/);
    assert.deepEqual(first.info.filter((line) => /^[0-9a-f]{24} /.test(line)).map((line) => line.slice(0, 24)), [hex(1), hex(2)]);
    const applied = await applyRun(['--limit', '1']);
    assert.equal(applied.code, 0, applied.error.join());
    assert.deepEqual(await remaining(1), PURGED);
    assert.deepEqual(await remaining(2), FULL);
    assert.deepEqual(await remaining(3), FULL);
    assert.match((await run(['--group', hex(3), '--limit', '5'])).info[0]!, /purgeable 1$/);
  });
});

describe('purge-trashed-groups --apply: what is deleted and what is not', () => {
  it('deletes exactly the trashed groups with their databases, copies, group users and dependent data, and nothing else', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await seedGroup(3, { trash: false });
    await seedStrangers();
    // Data of the common database that has to survive: the other collections, the other users, the other groups.
    await common().collection('dealers').insertOne({ _id: fixtureId('user', 7), company: 'kept' });
    await common().collection('settings').insertOne({ _id: 'priceList' as unknown as ObjectId, value: 1 });
    await common().collection('billingClosures').insertOne({ _id: new ObjectId(), groupId: G(1) });
    await common().collection('syncIssues').insertOne({ _id: new ObjectId(), groupId: G(1), kind: 'extraCopy' });
    await common().collection('rateLimits').insertOne({ _id: 'bucket:abc' as unknown as ObjectId, count: 1 });
    await common().collection('countries').insertOne({ _id: fixtureId('country', 1), code: 'IT' });
    await common().collection('probe').insertOne({ n: 1 });
    const before = await snapshot();
    const result = await applyRun([]);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(result.error, []);
    const counts = 'collections=4 documents=7 users=2 companies=2 places=2 apiKeys=2 apiUsage=3 storeKeys=1 activationCodes=1 reserveWithGoogle=1 idempotencyKeys=2';
    assert.deepEqual(result.info, [HELD_NONE, `Purged ${hex(1)} ${counts}`, `Purged ${hex(2)} ${counts}`, 'Applied on development: purged 2, skipped 0, skippedExternalHost 0, restoredDuringPurge 0, failed 0, events not written 0, withoutDatabase 0. Deleted: collections=8 documents=14 users=4 companies=4 places=4 apiKeys=4 apiUsage=6 storeKeys=2 activationCodes=2 reserveWithGoogle=2 idempotencyKeys=4']);
    assert.doesNotMatch(result.info.join('\n'), SECRET_PATTERN);

    assert.deepEqual(await remaining(1), PURGED);
    assert.deepEqual(await remaining(2), PURGED);
    assert.deepEqual(await remaining(3), FULL);
    assert.deepEqual((await ctx.databases.listGroupIds('cluster0')).map((id) => id.toHexString()), [hex(3)]);

    // The PSA and the D of a purged group are intact, with their credentials, sessions and idempotency keys.
    for (const n of [1, 2]) {
      for (const k of [3, 4]) {
        assert.equal(await common().collection('users').countDocuments({ _id: userId(n, k), groupId: G(n) }), 1);
        assert.equal(await common().collection('userCredentials').countDocuments({ _id: userId(n, k) }), 1);
        assert.equal(await common().collection('sessions').countDocuments({ userId: userId(n, k) }), 1);
        assert.equal(await common().collection('idempotencyKeys').countDocuments({ principal: userId(n, k).toHexString() }), 1);
      }
    }

    // Everything else is byte for byte what it was: the other group, the kept collections, the stranger databases, the queue.
    const after = await snapshot();
    const untouched = ['groups', 'users', 'companies', 'places', 'apiKeys', 'apiUsage', 'storeKeys', 'storeActivationCodes', 'reserve_with_google', 'sessions', 'userCredentials', 'idempotencyKeys', 'activityEvents'];
    for (const key of Object.keys(before)) {
      const collection = key.slice(key.lastIndexOf('.') + 1);
      if (key.startsWith(`${ctx.prefix}development_common.`) && untouched.includes(collection)) {
        continue;
      }
      if (key.startsWith(`${ctx.prefix}development_${hex(1)}.`) || key.startsWith(`${ctx.prefix}development_${hex(2)}.`)) {
        assert.equal(key in after, false, `${key} is gone`);
        continue;
      }
      assert.deepEqual(after[key], before[key], key);
    }
    // Of the group collections that were touched, only the documents of the purged groups are missing.
    for (const collection of ['groups', 'users', 'companies', 'places', 'apiKeys', 'apiUsage', 'storeKeys', 'storeActivationCodes', 'reserve_with_google', 'sessions', 'userCredentials', 'idempotencyKeys']) {
      const key = `${ctx.prefix}development_common.${collection}`;
      const gone = (before[key] ?? []).filter((document) => !(after[key] ?? []).some((candidate) => String(candidate._id) === String(document._id)));
      for (const document of gone) {
        const owner = document['groupId'] ?? document['_id'];
        const belongs = [G(1), G(2)].some((group) => String(owner) === String(group)) || [1, 2].some((n) => [1, 2].some((k) => String(document['_id']) === String(userId(n, k)) || String(document['userId']) === String(userId(n, k)) || document['principal'] === userId(n, k).toHexString()));
        assert.ok(belongs, `${key} lost a document of another group`);
      }
      assert.ok((after[key] ?? []).every((document) => (before[key] ?? []).some((candidate) => String(candidate._id) === String(document._id))), `${key} gained a document`);
    }

    // One group.purged event per purged group, written by the system with the counts and nothing else; the earlier events stay.
    const events = await common().collection('activityEvents').find({ action: 'group.purged' }).sort({ groupId: 1 }).toArray();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event['groupId']), [G(1), G(2)]);
    for (const event of events) {
      assert.deepEqual(event['actor'], { kind: 'system' });
      assert.equal(event['category'], 'data');
      assert.equal(event['outcome'], 'success');
      assert.deepEqual(event['resource'], { type: 'group', id: (event['groupId'] as ObjectId).toHexString() });
      assert.deepEqual(event['metadata'], { collections: 4, documents: 7, users: 2, companies: 2, places: 2, apiKeys: 2, apiUsage: 3, storeKeys: 1, activationCodes: 1, reserveWithGoogle: 1, idempotencyKeys: 2, resumed: false });
      assert.deepEqual(event['at'], NOW);
      assert.ok(event['expiresAt'] instanceof Date && event['expiresAt'] > NOW);
    }
    assert.equal(await common().collection('activityEvents').countDocuments({ action: 'user.created' }), 3);
  });

  it('is repeatable: a second run finds nothing in the trash and changes nothing', async () => {
    await seedGroup(1);
    assert.equal((await applyRun([])).code, 0);
    const before = await snapshot();
    const again = await applyRun([]);
    assert.equal(again.code, 0, again.error.join());
    assert.equal(again.info.at(-1), 'Applied on development: purged 0, skipped 0, skippedExternalHost 0, restoredDuringPurge 0, failed 0, events not written 0, withoutDatabase 0. Deleted: collections=0 documents=0 users=0 companies=0 places=0 apiKeys=0 apiUsage=0 storeKeys=0 activationCodes=0 reserveWithGoogle=0 idempotencyKeys=0');
    assert.deepEqual(await snapshot(), before);
  });

  it('matches the ObjectId and the hex string forms of groupId, and never a groupId or a role that is an array or only looks like one', async () => {
    await seedGroup(1);
    await seedGroup(2, { trash: false });
    const stringId = new ObjectId();
    await common().collection('companies').insertOne({ _id: stringId, groupId: hex(1), name: 'string form' });
    await common().collection('places').insertOne({ _id: new ObjectId(), groupId: hex(1) });
    await common().collection('reserve_with_google').insertOne({ _id: new ObjectId(), groupId: hex(1) });
    await common().collection('users').insertOne(legacyUser(150, { role: 'PA', groupId: hex(1) }));
    // Not this group's alone, or not clearly a group role: kept.
    const shared = new ObjectId();
    await common().collection('companies').insertOne({ _id: shared, groupId: [G(1), G(2)] });
    await common().collection('users').insertMany([
      legacyUser(151, { role: 'SA', groupId: [G(1), G(2)] }),
      legacyUser(152, { role: ['PSA', 'SA'], groupId: G(1) }),
      legacyUser(153, { role: 'sa', groupId: G(1) }),
      legacyUser(154, { role: 'API', groupId: G(1) }),
      legacyUser(155, { role: undefined, groupId: G(1) }),
      legacyUser(156, { role: 'SA', groupId: G(2) }),
      legacyUser(157, { role: 'SA', groupId: hex(2) }),
      legacyUser(158, { role: 'SA', groupId: null }),
    ]);
    const dry = await run([]);
    assert.match(dry.info[2]!, /users=3 companies=3 places=3 .*usersKept=6/);
    const result = await applyRun([]);
    assert.equal(result.code, 0, result.error.join());
    assert.equal(await common().collection('companies').countDocuments({ _id: stringId }), 0);
    assert.equal(await common().collection('companies').countDocuments({ _id: shared }), 1);
    assert.equal(await common().collection('places').countDocuments({ groupId: hex(1) }), 0);
    assert.equal(await common().collection('reserve_with_google').countDocuments({ groupId: hex(1) }), 0);
    assert.equal(await common().collection('users').countDocuments({ _id: { $in: [fixtureId('user', 150), fixtureId('user', 101), fixtureId('user', 102)] } }), 0);
    const kept = await common().collection('users').find({ _id: { $in: [151, 152, 153, 154, 155, 156, 157, 158].map((n) => fixtureId('user', n)) } }).toArray();
    assert.equal(kept.length, 8);
    // Group 2 still has its two companies and the copy that lists both groups and its two users 151 and 156 (counted here because the array of 151 holds the group).
    assert.deepEqual(await remaining(2), { ...FULL, companies: 3, users: 4 });
  });

  it('works for a group with no database and for a group with no data at all', async () => {
    await seedGroup(1, { withDatabase: false });
    await common().collection('groups').insertOne({ _id: G(2), trash: true });
    const dry = await run([]);
    assert.match(dry.info.find((line) => line.startsWith(hex(1)))!, /^[0-9a-f]{24} collections=0 documents=0 users=2 companies=2 /);
    const result = await applyRun([]);
    assert.equal(result.code, 0, result.error.join());
    assert.equal(result.info[1], `Purged ${hex(1)} collections=0 documents=0 users=2 companies=2 places=2 apiKeys=2 apiUsage=3 storeKeys=1 activationCodes=1 reserveWithGoogle=1 idempotencyKeys=2 resumed=true`);
    assert.equal(result.info[2], `Purged ${hex(2)} collections=0 documents=0 users=0 companies=0 places=0 apiKeys=0 apiUsage=0 storeKeys=0 activationCodes=0 reserveWithGoogle=0 idempotencyKeys=0 resumed=true`);
    assert.match(result.info.at(-1)!, /purged 2, .*withoutDatabase 2\./);
    assert.match(dry.info[1]!, /withoutDatabase 2$/);
    assert.ok(dry.info.includes('Purgeable but without a database (check them):'));
    assert.equal(await common().collection('groups').countDocuments({ _id: { $in: [G(1), G(2)] } }), 0);
  });

  it('deletes more users and keys than one batch holds', async () => {
    await seedGroup(1);
    const total = USER_BATCH * 2 + 5;
    const users = Array.from({ length: total }, (_, index) => legacyUser(1000 + index, { role: index % 2 === 0 ? 'CA' : 'PA', groupId: G(1) }));
    await common().collection('users').insertMany(users);
    await common().collection('userCredentials').insertMany(users.map((user) => ({ _id: user._id as ObjectId })));
    await common().collection('sessions').insertMany(users.map((user) => ({ userId: user._id as ObjectId })));
    const keys = Array.from({ length: 103 }, () => ({ _id: new ObjectId(), groupId: G(1) }));
    await common().collection('apiKeys').insertMany(keys);
    await common().collection('apiUsage').insertMany(keys.map((key) => ({ keyId: key._id, groupId: G(1), day: '2026-11-03', route: 'GET /b' })));
    const dry = await run([]);
    assert.match(dry.info[4]!, new RegExp(`users=${total + 2} .* apiKeys=105 apiUsage=106 `));
    const result = await applyRun([]);
    assert.equal(result.code, 0, result.error.join());
    assert.match(result.info[1]!, new RegExp(`users=${total + 2} .* apiKeys=105 apiUsage=106 `));
    assert.deepEqual(await remaining(1), PURGED);
    assert.equal(await common().collection('sessions').countDocuments({ userId: { $in: users.map((user) => user._id as ObjectId) } }), 0);
    assert.equal(await common().collection('userCredentials').countDocuments({ _id: { $in: users.map((user) => user._id as ObjectId) } }), 0);
  });
});

describe('purge-trashed-groups: refusals', () => {
  it('refuses --apply when --expect does not match the selection, before any write', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await seedStrangers();
    const before = await snapshot();
    const digest = /Selection digest: ([0-9a-f]{16})/.exec((await run([])).info.join('\n'))![1]!;
    for (const expect of ['1', '3', '0']) {
      const result = await run(['--apply', '--expect', expect, '--expect-digest', digest]);
      assert.equal(result.code, 1);
      assert.match(result.error.join(), new RegExp(`Refusing to apply: --expect ${expect} but the selection counts 2 groups \\(nothing was written\\)`));
    }
    // The right count with the digest of another selection (or a digest that is not one) is refused too.
    for (const wrong of ['0123456789abcdef', digest.replace(/^./, digest[0] === 'a' ? 'b' : 'a')]) {
      const result = await run(['--apply', '--expect', '2', '--expect-digest', wrong]);
      assert.equal(result.code, 1);
      assert.match(result.error.join(), /--expect-digest does not match the digest of the selection \(nothing was written\)/);
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('refuses --apply without --expect, --expect without --apply, and every malformed argument', async () => {
    await seedGroup(1);
    const before = await snapshot();
    const good = hex(1);
    for (const argv of [['--apply'], ['--expect', '1'], ['--apply', '--expect'], ['--apply', '--expect', 'x'], ['--apply', '--expect', '-1'], ['--apply', '--expect', '1.5'], ['--apply', '--expect', '1234567'], ['--apply', '--apply', '--expect', '1'], ['--apply', '--expect', '1', '--expect', '1'], ['--apply', '--expect', '1'], ['--apply', '--expect-digest', '0123456789abcdef'], ['--expect-digest', '0123456789abcdef'], ['--apply', '--expect', '1', '--expect-digest', 'ABCDEF0123456789'], ['--apply', '--expect', '1', '--expect-digest', '0123456789abcde'], ['--min-idle-days'], ['--min-idle-days', '3651'], ['--min-idle-days', '-1'], ['--min-idle-days', '1', '--min-idle-days', '1'], ['--include-active', '--include-active'], ['--pause-ms', '60001'], ['--pause-ms', 'x'], ['--skip'], ['--skip', 'abc'], ['--skip', good, '--skip', good], ['--orphans', '--apply', '--expect', '1', '--expect-digest', '0123456789abcdef'], ['--orphans', '--limit', '1'], ['--orphans', '--orphans'], ['--env'], ['--env', 'staging'], ['--group'], ['--group', 'abc'], ['--group', 'A'.repeat(24)], ['--group', `${good}0`], ['--group', good, '--group', good], ['--limit'], ['--limit', '0'], ['--limit', '1001'], ['--limit', '01'], ['--limit', '1.5'], ['--limit', 'all'], ['--bogus'], ['apply'], ['--group=' + good], ['--all']]) {
      const result = await run(argv);
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.error.join(), /^Usage: node src\/tools\/purge-trashed-groups\/cli\.ts/, argv.join(' '));
    }
    assert.deepEqual(await snapshot(), before);
    for (const argv of [['--limit', '1'], ['--limit', '1000'], ['--env', 'development', '--group', good, '--limit', '10']]) {
      assert.equal((await run(argv)).code, 0, argv.join(' '));
    }
  });

  it('refuses to run when --env and APP_ENV disagree, in either direction, before any client is created', async () => {
    await seedGroup(1);
    const before = await snapshot();
    for (const [argv, appEnv] of [[['--env', 'production'], 'development'], [[], 'production'], [['--env', 'development'], 'production']] as const) {
      let created = 0;
      const result = await run([...argv], {
        createClient: (config, options) => {
          created += 1;
          return createMongoClient(config, options);
        },
      }, env({ APP_ENV: appEnv, MONGODB_URI: appEnv === 'production' ? 'mongodb://127.0.0.1:1/?tls=true' : testMongoUri() }));
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.error.join(), /does not match/, argv.join(' '));
      assert.equal(created, 0);
    }
    assert.deepEqual(await snapshot(), before);
  });

  it('keeps the TLS rule of production and tolerates only a missing .env', async () => {
    const weak = await run(['--env', 'production'], {}, env({ APP_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:27027/?directConnection=true' }));
    assert.equal(weak.code, 1);
    assert.match(weak.error.join(), /MONGODB_URI: must use TLS in production/);
    await seedGroup(1, { trash: false });
    const missing = await run([], { loadEnvFile: () => { throw Object.assign(new Error('no file'), { code: 'ENOENT' }); } });
    assert.equal(missing.code, 0, missing.error.join());
    const broken = await run([], { loadEnvFile: () => { throw new Error('unreadable'); } });
    assert.equal(broken.code, 1);
    assert.match(broken.error.join(), /unreadable/);
    const none = await run([], {}, {});
    assert.equal(none.code, 1);
    assert.match(none.error.join(), /APP_ENV: is required/);
  });

  it('accepts --env production when APP_ENV is production: dry run writes nothing, --apply deletes only the production data', async () => {
    await seedGroup(1);
    const prod = await openTestDatabases('production');
    try {
      const prodCommon = prod.databases.common();
      const prodGroup = prod.databases.group(G(1), 'cluster0');
      await prodCommon.collection('groups').insertOne(legacyGroup(1, { trash: true, databaseHost: null }));
      await prodGroup.collection('companies').insertOne(legacyCompany(1, G(1)));
      await prodCommon.collection('companies').insertOne(legacyCompany(1, G(1)));
      const call = async (argv: string[]): Promise<Run> => run(argv, { loadDatabaseConfig: () => ({ ...loadDatabaseConfig(env()), appEnv: 'production', dbNamePrefix: prod.prefix }), createClient: (config, options) => createMongoClient({ ...config, appEnv: 'development' }, options) }, {});
      const dry = await call(['--env', 'production', '--include-active']);
      assert.equal(dry.code, 0, dry.error.join());
      assert.match(dry.info[0]!, /^Dry run on production, nothing written/);
      assert.equal(await prodCommon.collection('groups').countDocuments(), 1);
      const applied = await call(['--env', 'production', '--include-active', '--apply', '--expect', '1', '--expect-digest', /Selection digest: ([0-9a-f]{16})/.exec(dry.info.join('\n'))![1]!]);
      assert.equal(applied.code, 0, applied.error.join());
      assert.match(applied.info.at(-1)!, /^Applied on production: purged 1/);
      assert.equal(await prodCommon.collection('groups').countDocuments(), 0);
      assert.equal(await prodCommon.collection('companies').countDocuments(), 0);
      assert.deepEqual(await prod.databases.listGroupIds('cluster0'), []);
      assert.deepEqual(await remaining(1), FULL, 'the development data is untouched');
    } finally {
      await prod.cleanup();
    }
  });

  it('refuses to run when the common database is not there (wrong prefix), and writes nothing', async () => {
    await seedGroup(1);
    const before = await snapshot();
    const wrong = await run(['--apply', '--expect', '1', '--expect-digest', '0123456789abcdef'], {}, env({ DB_NAME_PREFIX: `${ctx.prefix.slice(0, -1)}w_` }));
    assert.equal(wrong.code, 1);
    assert.match(wrong.error.join(), /common database does not exist.*DB_NAME_PREFIX/);
    assert.deepEqual(await snapshot(), before);
  });

  it('refuses --apply when the common cluster is not a replica set, before any write, but still allows the dry run', async () => {
    await seedGroup(1);
    const before = await snapshot();
    const standalone: MainDeps['createClient'] = (config, options) => {
      const client = createMongoClient(config, options);
      const open = client.db.bind(client);
      client.db = ((name?: string) => {
        const db = open(name);
        if (name === undefined) {
          const admin = db.admin();
          db.admin = (() => ({ listDatabases: (listOptions: Document) => admin.listDatabases(listOptions), command: async () => ({ isWritablePrimary: true }) })) as unknown as typeof db.admin;
        }
        return db;
      }) as typeof client.db;
      return client;
    };
    const refused = await applyRun([], { createClient: standalone });
    assert.equal(refused.code, 1);
    assert.match(refused.error.join(), /not a replica set/);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await run([], { createClient: standalone })).code, 0);
  });

  it('fails cleanly when MongoDB is unreachable, without printing the URI', async () => {
    const uri = 'mongodb://127.0.0.1:1/?directConnection=true';
    const result = await run([], {}, env({ MONGODB_URI: uri, MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' }));
    assert.equal(result.code, 1);
    assert.ok(result.error.length > 0);
    assert.ok(!result.error.join().includes(uri));
  });

  it('reports a close that fails without the connection string', async () => {
    await seedGroup(1, { trash: false });
    const uri = testMongoUri();
    const result = await run([], {
      createClient: (config, options) => {
        const client = createMongoClient(config, options);
        const close = client.close.bind(client);
        client.close = async () => {
          await close();
          throw new Error(`close failed for ${uri}`);
        };
        return client;
      },
    }, env({ MONGODB_ANALYTICS_URI: uri }));
    assert.equal(result.code, 0);
    assert.equal(result.error.filter((line) => line.startsWith('Error: close failed')).length, 2);
    assert.ok(result.error.every((line) => !line.includes(uri)));
  });
});

describe('purge-trashed-groups --apply: concurrent changes and failures', () => {
  it('skips a group that was restored between the selection and its turn, and goes on with the others', async () => {
    await seedGroup(1);
    await seedGroup(2);
    const result = await applyRun([], {
      afterStep: async (step, group) => {
        if (step === 'start' && group === hex(1)) {
          await common().collection('groups').updateOne({ _id: G(1) }, { $set: { trash: false } });
        }
      },
    });
    assert.equal(result.code, 0, result.error.join());
    assert.equal(result.info[1], `Skipped ${hex(1)}: no longer in the trash`);
    assert.match(result.info.at(-1)!, /purged 1, skipped 1, skippedExternalHost 0, restoredDuringPurge 0, failed 0/);
    assert.deepEqual(await remaining(1), FULL);
    assert.deepEqual(await remaining(2), PURGED);
  });

  it('skips a group whose trash became something other than the boolean true', async () => {
    await seedGroup(1);
    const result = await applyRun([], {
      afterStep: async (step) => {
        if (step === 'start') {
          await common().collection('groups').updateOne({ _id: G(1) }, { $set: { trash: 1 } });
        }
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.info.at(-1)!, /purged 0, skipped 1, skippedExternalHost 0, restoredDuringPurge 0, failed 0/);
    assert.deepEqual(await remaining(1), FULL);
  });

  /** The steps in the order of the run. */
  const STEPS = ['start', 'users', 'dependent', 'copies', 'database'] as const;
  /** What remains of group 1 after the step `step` has finished (and the run stopped there). */
  const afterStep = (step: (typeof STEPS)[number]): Record<string, number> => {
    const done = STEPS.indexOf(step);
    return {
      group: 1,
      users: done >= 1 ? 0 : 2,
      kept: 2,
      dependants: done >= 1 ? 0 : 6,
      apiKeys: done >= 2 ? 0 : 2,
      apiUsage: done >= 2 ? 0 : 3,
      storeKeys: done >= 2 ? 0 : 1,
      codes: done >= 2 ? 0 : 1,
      rwg: done >= 2 ? 0 : 1,
      companies: done >= 3 ? 0 : 2,
      places: done >= 3 ? 0 : 2,
      database: done >= 4 ? 0 : 1,
    };
  };
  const credentialsKept = (n: number): Promise<number> => common().collection('userCredentials').countDocuments({ _id: { $in: [userId(n, 3), userId(n, 4)] } });

  for (const step of STEPS) {
    it(`resumes after a failure at the step "${step}": the group stays in the trash, the others are purged, the exit code is not 0, and a second run completes`, async () => {
      await seedGroup(1);
      await seedGroup(2);
      const failing = await applyRun([], {
        afterStep: (current, group) => {
          if (current === step && group === hex(1)) {
            throw new TypeError(`injected at ${step} with secret-detail`);
          }
        },
      });
      assert.equal(failing.code, 1);
      assert.deepEqual(failing.error, [`Group ${hex(1)} failed: TypeError`]);
      assert.match(failing.info.at(-1)!, /purged 1, skipped 0, skippedExternalHost 0, restoredDuringPurge 0, failed 1/);
      assert.deepEqual(await remaining(2), PURGED, 'the other group is purged');
      const left = await remaining(1);
      for (const [key, value] of Object.entries(afterStep(step))) {
        if (key !== 'dependants') {
          assert.equal(left[key], value, key);
        }
      }
      assert.equal(await common().collection('groups').countDocuments({ _id: G(1), trash: true }), 1, 'the group document, still trashed, is what makes the run resumable');
      // Once the users are gone a group with a database and no login looks like one of unknown activity: the resumed run needs the options of the first one.
      const usersGone = STEPS.indexOf(step) >= 1 && step !== 'database';
      const dry = await run([]);
      assert.match(dry.info[0]!, usersGone ? /examined 1, purgeable 0$/ : /purgeable 1$/);
      if (usersGone) {
        assert.match(dry.info[1]!, /unknownActivity 1 .*possiblyInterrupted 1\./);
        assert.ok(dry.info.some((line) => line.startsWith(`${hex(1)} held=unknownActivity activeUsers=0 lastActivity=none possibly interrupted purge`)));
      }
      const resumed = await applyRun(usersGone ? ['--include-active'] : []);
      assert.equal(resumed.code, 0, resumed.error.join());
      assert.deepEqual(await remaining(1), PURGED);
      const events = await common().collection('activityEvents').find({ action: 'group.purged', groupId: G(1) }).toArray();
      assert.equal(events.length, 1);
      assert.equal(events[0]!['metadata']['resumed'], step === 'database', 'resumed tells that the database was already gone: the counts are those of the second run only');
    });
  }

  for (const step of ['users', 'dependent', 'copies', 'database'] as const) {
    it(`stops a group restored while it is being purged right after the step "${step}", deleting nothing more, and counts it apart from the failures`, async () => {
      await seedGroup(1);
      await seedGroup(2);
      const result = await applyRun([], {
        afterStep: async (current, group) => {
          if (current === step && group === hex(1)) {
            await common().collection('groups').updateOne({ _id: G(1) }, { $set: { trash: false } });
          }
        },
      });
      assert.equal(result.code, 1);
      assert.deepEqual(result.error, [`Group ${hex(1)}: restored during the purge, stopped after step ${step}`]);
      assert.match(result.info.at(-1)!, /purged 1, skipped 0, skippedExternalHost 0, restoredDuringPurge 1, failed 0/);
      const left = await remaining(1);
      for (const [key, value] of Object.entries(afterStep(step))) {
        if (key !== 'dependants') {
          assert.equal(left[key], value, `${key}: exactly what the steps up to ${step} deleted, and nothing after`);
        }
      }
      assert.equal(await common().collection('groups').countDocuments({ _id: G(1), trash: false }), 1, 'the restored group document is never deleted');
      assert.equal(await credentialsKept(1), 2);
      assert.equal(await common().collection('activityEvents').countDocuments({ action: 'group.purged', groupId: G(1) }), 0);
      assert.deepEqual(await remaining(2), PURGED);
    });
  }

  it('fails a group whose cluster became unusable between the audit and its turn before touching anything', async () => {
    await seedGroup(1);
    const result = await applyRun([], {
      afterStep: async (step) => {
        if (step === 'start') {
          await common().collection('groups').updateOne({ _id: G(1) }, { $set: { dataCluster: 'nowhere' } });
        }
      },
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.error, [`Group ${hex(1)} failed: Error`]);
    assert.deepEqual(await remaining(1), FULL);
  });

  it('never purges a group that got a dedicated database host between the audit and its turn', async () => {
    await seedGroup(1);
    const result = await applyRun([], {
      afterStep: async (step) => {
        if (step === 'start') {
          await common().collection('groups').updateOne({ _id: G(1) }, { $set: { databaseHost: 'db.dedicated.test' } });
        }
      },
    });
    assert.equal(result.code, 0, result.error.join());
    assert.equal(result.info[1], `Skipped ${hex(1)}: it has a dedicated database host`);
    assert.match(result.info.at(-1)!, /purged 0, skipped 0, skippedExternalHost 1, restoredDuringPurge 0, failed 0/);
    assert.deepEqual(await remaining(1), FULL);
  });

  it('reports a group.purged event that cannot be written, never with the connection string, and exits non-zero', async () => {
    await seedGroup(1);
    const uri = testMongoUri();
    const result = await applyRun([], {
      createClient: (config, options) => {
        const client = createMongoClient(config, options);
        const open = client.db.bind(client);
        client.db = ((name?: string) => {
          const db = open(name);
          const collection = db.collection.bind(db);
          db.collection = ((collectionName: string) => {
            const handle = collection(collectionName);
            if (collectionName === 'activityEvents') {
              handle.insertOne = (() => Promise.reject(new TypeError(`refused ${uri}`))) as typeof handle.insertOne;
            }
            return handle;
          }) as typeof db.collection;
          return db;
        }) as typeof client.db;
        return client;
      },
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.error, [`Group ${hex(1)}: the group.purged event could not be written: TypeError`]);
    assert.match(result.info.at(-1)!, /purged 1, skipped 0, skippedExternalHost 0, restoredDuringPurge 0, failed 0, events not written 1/);
    assert.deepEqual(await remaining(1), PURGED);
    assert.ok(![...result.info, ...result.error].join().includes(uri));
  });

  it('reports anything that is not an Error as an unknown failure', async () => {
    await seedGroup(1);
    await seedGroup(2);
    const result = await applyRun([], {
      afterStep: (step, group) => {
        if (step === 'start' && group === hex(1)) {
          throw 'a string';
        }
      },
    });
    assert.deepEqual(result.error, [`Group ${hex(1)} failed: unknown`]);
  });
});


const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const idAt = (date: Date): ObjectId => ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

describe('purge-trashed-groups: groups that may still be at work', () => {
  it('holds back a group whose sales or documents are newer than the idle limit, lists it with its date and active users, and purges only the others', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await seedGroup(3);
    await groupDb(1).collection('sales').insertOne({ _id: idAt(daysAgo(10)) });
    await groupDb(2).collection('documents').insertOne({ _id: idAt(daysAgo(400)) });
    await groupDb(3).collection('sales').insertOne({ _id: idAt(daysAgo(364)) });
    const dry = await run([]);
    assert.match(dry.info[0]!, /examined 3, purgeable 1$/);
    assert.match(dry.info[1]!, /recentlyActive 2 \(activity newer than 365 days\)/);
    assert.ok(dry.info.includes(`${hex(1)} held=recentlyActive activeUsers=2 lastActivity=${daysAgo(10).toISOString().slice(0, 10)}`));
    assert.ok(dry.info.includes(`${hex(3)} held=recentlyActive activeUsers=2 lastActivity=${daysAgo(364).toISOString().slice(0, 10)}`));
    assert.match(dry.info.find((line) => line.startsWith(hex(2)))!, new RegExp(`activeUsers=2 lastActivity=${daysAgo(400).toISOString().slice(0, 10)}$`));
    const before = await snapshot();
    const result = await applyRun([]);
    assert.equal(result.code, 0, result.error.join());
    assert.equal(result.info[0], 'Held back and not purged: recentlyActive 2, unknownActivity 0, externalHost 0, unusableCluster 0');
    assert.deepEqual(await remaining(2), PURGED);
    assert.deepEqual(await remaining(1), FULL);
    assert.deepEqual(await remaining(3), FULL);
    const after = await snapshot();
    for (const key of Object.keys(before).filter((name) => name.includes(hex(1)) || name.includes(hex(3)))) {
      assert.deepEqual(after[key], before[key], key);
    }
  });

  it('measures the activity of the group users from the dates of their tokens and the last login of their credentials, ignoring junk, and of no one else', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await seedGroup(3);
    await seedGroup(4);
    // 1: a recent token date. 2: junk only (strings, missing dates, a tokens field that is not a list). 3: a recent last login in the credentials. 4: a recent login of a PSA, which is no group user.
    await common().collection('users').updateOne({ _id: userId(1, 1) }, { $set: { tokens: [{ date: 'yesterday' }, { date: daysAgo(3) }, 7, null, { ip: 'x' }] } });
    await common().collection('users').updateOne({ _id: userId(2, 1) }, { $set: { tokens: [{ date: 'yesterday' }, 7, null, { ip: 'x' }] } });
    await common().collection('users').updateOne({ _id: userId(2, 2) }, { $set: { tokens: 'not a list' } });
    await common().collection('userCredentials').updateOne({ _id: userId(3, 2) }, { $set: { lastLoginAt: daysAgo(20) } });
    await common().collection('users').updateOne({ _id: userId(4, 3) }, { $set: { tokens: [{ date: daysAgo(1) }] } });
    await common().collection('userCredentials').updateOne({ _id: userId(4, 4) }, { $set: { lastLoginAt: daysAgo(1) } });
    // Active users: status true and not in the trash.
    await common().collection('users').updateOne({ _id: userId(2, 1) }, { $set: { status: false } });
    await common().collection('users').updateOne({ _id: userId(2, 2) }, { $set: { trash: true } });
    const dry = await run([]);
    assert.match(dry.info[0]!, /examined 4, purgeable 1$/);
    assert.ok(dry.info.includes(`${hex(1)} held=recentlyActive activeUsers=2 lastActivity=${daysAgo(3).toISOString().slice(0, 10)}`));
    assert.ok(dry.info.includes(`${hex(3)} held=recentlyActive activeUsers=2 lastActivity=${daysAgo(20).toISOString().slice(0, 10)}`));
    assert.ok(dry.info.includes(`${hex(2)} held=unknownActivity activeUsers=0 lastActivity=none`), 'junk dates are no date: documents but no activity is not idle');
    assert.match(dry.info.find((line) => line.startsWith(hex(4)) && line.includes('collections='))!, /activeUsers=2 lastActivity=2024-01-15$/);
  });

  it('--min-idle-days sets the limit (0 to 3650) and --include-active brings the held groups back, in the dry run and in the apply, with a digest of its own', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await groupDb(1).collection('sales').insertOne({ _id: idAt(daysAgo(10)) });
    const digestOf = (lines: string[]): string => /Selection digest: ([0-9a-f]{16})/.exec(lines.join('\n'))![1]!;
    const strict = await run([]);
    const loose = await run(['--min-idle-days', '5']);
    const everything = await run(['--include-active']);
    const none = await run(['--min-idle-days', '0']);
    assert.match(strict.info[0]!, /purgeable 1$/);
    assert.match(loose.info[0]!, /purgeable 2$/);
    assert.match(everything.info[0]!, /purgeable 2$/);
    assert.match(none.info[0]!, /purgeable 2$/);
    assert.match(strict.info[1]!, /recentlyActive 1 \(activity newer than 365 days\)/);
    assert.match(loose.info[1]!, /recentlyActive 0 \(activity newer than 5 days\)/);
    assert.equal(new Set([digestOf(loose.info), digestOf(everything.info), digestOf(none.info)]).size, 1);
    assert.notEqual(digestOf(strict.info), digestOf(loose.info));
    // A digest of the strict selection does not open the wider one.
    const refused = await run(['--include-active', '--apply', '--expect', '1', '--expect-digest', digestOf(strict.info)]);
    assert.equal(refused.code, 1);
    assert.match(refused.error.join(), /Refusing to apply: --expect 1 but the selection counts 2 groups/);
    const applied = await applyRun(['--include-active']);
    assert.equal(applied.code, 0, applied.error.join());
    assert.deepEqual(await remaining(1), PURGED);
    assert.deepEqual(await remaining(2), PURGED);
  });

  it('holds back a group with documents but no activity date as unknownActivity, purges one with no documents, and --include-active brings the first back', async () => {
    await seedGroup(1);
    await seedGroup(2);
    await seedGroup(3, { withDatabase: false });
    for (const n of [1, 2, 3]) {
      await common().collection('users').deleteMany({ groupId: G(n), role: { $in: ['SA', 'E'] } });
    }
    // Group 2 keeps its documents but its collections hold no id with a date to read: only empty ones are left.
    await groupDb(2).collection('products').deleteMany({});
    await groupDb(2).collection('companies').deleteMany({});
    await groupDb(2).collection('places').deleteMany({});
    const dry = await run([]);
    assert.match(dry.info[0]!, /examined 3, purgeable 2$/);
    assert.match(dry.info[1]!, /unknownActivity 1 \(documents but no activity date\).*possiblyInterrupted 1\./);
    assert.ok(dry.info.some((line) => line.startsWith(`${hex(1)} held=unknownActivity activeUsers=0 lastActivity=none possibly interrupted purge`)));
    assert.ok(dry.info.some((line) => line.startsWith(`${hex(2)} collections=`)), 'no documents and no date: purgeable');
    assert.ok(dry.info.some((line) => line.startsWith(`${hex(3)} collections=0`)), 'no database and no date: purgeable');
    const result = await applyRun([]);
    assert.equal(result.code, 0, result.error.join());
    assert.equal(result.info[0], 'Held back and not purged: recentlyActive 0, unknownActivity 1, externalHost 0, unusableCluster 0');
    assert.equal((await remaining(1))['database'], 1);
    assert.equal((await remaining(2))['database'], 0);
    const all = await applyRun(['--include-active']);
    assert.equal(all.code, 0, all.error.join());
    assert.equal((await remaining(1))['database'], 0);
  });

  it('does not let held back groups block --limit: the block is made of purgeable groups', async () => {
    for (const n of [1, 2, 3, 4]) {
      await seedGroup(n);
    }
    await groupDb(1).collection('sales').insertOne({ _id: idAt(daysAgo(1)) });
    await groupDb(2).collection('sales').insertOne({ _id: idAt(daysAgo(1)) });
    const result = await applyRun(['--limit', '1']);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(await remaining(3), PURGED);
    assert.deepEqual(await remaining(4), FULL);
    assert.deepEqual(await remaining(1), FULL);
  });

  it('with --group, a held back group is listed and not purged', async () => {
    await seedGroup(1);
    await groupDb(1).collection('sales').insertOne({ _id: idAt(daysAgo(1)) });
    const result = await applyRun(['--group', hex(1)]);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(await remaining(1), FULL);
  });
});

describe('purge-trashed-groups: groups with a dedicated database host and groups without a database', () => {
  it('counts and lists a group with a databaseHost, never purges it and deletes nothing for it, whatever the type of the value; a blank host is no host', async () => {
    await seedGroup(1, { groupExtra: { databaseHost: 'db.dedicated.test' } });
    await seedGroup(2, { groupExtra: { databaseHost: 5 } });
    await seedGroup(3, { groupExtra: { databaseHost: '   ' } });
    await seedGroup(4, { groupExtra: { databaseHost: '' } });
    await common().collection('groups').updateOne({ _id: G(4) }, { $unset: { databaseHost: '' } });
    const dry = await run([]);
    assert.match(dry.info[0]!, /examined 4, purgeable 2$/);
    assert.match(dry.info[1]!, /externalHost 2/);
    assert.ok(dry.info.includes(`${hex(1)} held=externalHost activeUsers=2 lastActivity=2024-01-15`));
    assert.ok(dry.info.includes(`${hex(2)} held=externalHost activeUsers=2 lastActivity=2024-01-15`));
    const before = await snapshot();
    const result = await applyRun([]);
    assert.equal(result.code, 0, result.error.join());
    assert.equal(result.info[0], 'Held back and not purged: recentlyActive 0, unknownActivity 0, externalHost 2, unusableCluster 0');
    assert.deepEqual(await remaining(1), FULL);
    assert.deepEqual(await remaining(2), FULL);
    assert.deepEqual(await remaining(3), PURGED);
    assert.deepEqual(await remaining(4), PURGED);
    const after = await snapshot();
    for (const key of Object.keys(before).filter((name) => name.includes(hex(1)) || name.includes(hex(2)))) {
      assert.deepEqual(after[key], before[key], key);
    }
  });

  it('purges a group with no collection and lists it apart in the dry run, in the line and in the summary', async () => {
    await seedGroup(1, { withDatabase: false });
    await seedGroup(2);
    const dry = await run([]);
    assert.match(dry.info[1]!, /withoutDatabase 1$/);
    assert.deepEqual(dry.info.slice(dry.info.indexOf('Purgeable but without a database (check them):')), ['Purgeable but without a database (check them):', hex(1), dry.info.at(-1)!]);
    const result = await applyRun([]);
    assert.match(result.info.at(-1)!, /purged 2, .* withoutDatabase 1\./);
    assert.equal(result.info[1], `Purged ${hex(1)} collections=0 documents=0 users=2 companies=2 places=2 apiKeys=2 apiUsage=3 storeKeys=1 activationCodes=1 reserveWithGoogle=1 idempotencyKeys=2 resumed=true`);
  });
});

describe('purge-trashed-groups: --skip, --pause-ms and --orphans', () => {
  it('--skip leaves groups out of the selection and of the digest, up to 50, and refuses duplicates', async () => {
    for (const n of [1, 2, 3]) {
      await seedGroup(n);
    }
    const all = await run([]);
    const skipped = await run(['--skip', hex(1), '--skip', hex(3)]);
    assert.match(skipped.info[0]!, /examined 1, purgeable 1$/);
    assert.ok(skipped.info.some((line) => line.startsWith(hex(2))) && !skipped.info.some((line) => line.startsWith(hex(1))));
    assert.notEqual(/digest: (\w+)/.exec(skipped.info.join())![1], /digest: (\w+)/.exec(all.info.join())![1]);
    const result = await applyRun(['--skip', hex(1), '--skip', hex(3)]);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(await remaining(2), PURGED);
    assert.deepEqual(await remaining(1), FULL);
    assert.deepEqual(await remaining(3), FULL);
    const refused = await run(['--group', hex(1), '--skip', hex(1)]);
    assert.equal(refused.code, 1);
    assert.match(refused.error.join(), /not in the trash \(or is in the --skip list\)/);
    const many = Array.from({ length: 50 }, (_, index) => ['--skip', fixtureId('group', 100 + index).toHexString()]).flat();
    assert.equal((await run(many)).code, 0);
    assert.equal((await run([...many, '--skip', fixtureId('group', 999).toHexString()])).code, 1);
  });

  it('waits --pause-ms (200 by default) between groups, never before the first, never after the last, and not at all with 0', async () => {
    for (const n of [1, 2, 3]) {
      await seedGroup(n);
    }
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    assert.equal((await applyRun(['--limit', '2'], { sleep })).code, 0);
    assert.deepEqual(waits, [200]);
    waits.length = 0;
    await seedGroup(4);
    await seedGroup(5);
    assert.equal((await applyRun(['--pause-ms', '7'], { sleep })).code, 0);
    assert.deepEqual(waits, [7, 7]);
    waits.length = 0;
    await seedGroup(6);
    await seedGroup(7);
    assert.equal((await applyRun(['--pause-ms', '0'], { sleep })).code, 0);
    assert.deepEqual(waits, []);
  });

  it('really waits with the default timer', async () => {
    await seedGroup(1);
    await seedGroup(2);
    const dry = await run(['--pause-ms', '1']);
    const digest = /Selection digest: ([0-9a-f]{16})/.exec(dry.info.join('\n'))![1]!;
    const info: string[] = [];
    const code = await main(['--pause-ms', '1', '--apply', '--expect', '2', '--expect-digest', digest], { env: env(), loadEnvFile: () => undefined, info: (line) => info.push(line), error: () => undefined, now: () => NOW });
    assert.equal(code, 0);
    assert.match(info.at(-1)!, /purged 2/);
  });

  it('--orphans lists, read only, the group databases that have no group document, on every cluster, and nothing else', async () => {
    await seedGroup(1, { trash: false });
    await seedGroup(2);
    await groupDb(8).collection('products').insertOne({ n: 1 });
    await groupDb(9).collection('products').insertOne({ n: 1 });
    await ctx.client.db(`${ctx.prefix}production_${hex(7)}`).collection('products').insertOne({ n: 1 });
    await ctx.client.db(`${ctx.prefix}development_queue`).collection('documents').insertOne({ n: 1 });
    const before = await snapshot();
    const result = await run(['--orphans']);
    assert.equal(result.code, 0, result.error.join());
    assert.deepEqual(result.info, ['Orphans on development, nothing written: group databases without a group document 2', `cluster0 ${hex(8)}`, `cluster0 ${hex(9)}`]);
    assert.deepEqual(await snapshot(), before);
    const none = await run(['--orphans', '--env', 'development']);
    assert.equal(none.code, 0);
  });
});

describe('the sources of the command', () => {
  it('delete only through filters that name a group, and never touch the queue database, PSA or D users', async () => {
    const deletions = /\.(deleteMany|deleteOne)\(/g;
    for (const file of await readdir(SRC)) {
      const text = await readFile(join(SRC, file), 'utf8');
      assert.ok(!/queue\(\)/.test(text), `${file} must not reach the queue database`);
      assert.ok(!/['"`](PSA|D)['"`]/.test(text.replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${file} must not name the PSA or D roles in code`);
      for (const match of text.matchAll(deletions)) {
        const line = text.slice(text.lastIndexOf('\n', match.index) + 1, text.indexOf('\n', match.index));
        assert.ok(/groupIdFilter|groupId\)|filter|TRASHED|principal|_id/.test(line), `${file}: a deletion without a group filter: ${line.trim()}`);
      }
    }
  });
});

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the real CLI in an empty directory that holds only the given `.env`; the parent environment is not inherited. */
async function runCli(args: string[], dotEnv: string | undefined): Promise<Outcome> {
  const cwd = await mkdtemp(join(tmpdir(), 'flood-purge-'));
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

const dotEnv = (): string =>
  Object.entries(env())
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

describe('node src/tools/purge-trashed-groups/cli.ts', () => {
  it('reads .env, performs a dry run, refuses a wrong --expect and applies with the right one', async () => {
    await seedGroup(1);
    const dry = await runCli([], dotEnv());
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Dry run on development, nothing written: trashed groups examined 1, purgeable 1/);
    assert.deepEqual(await remaining(1), FULL);
    const digest = /Selection digest: ([0-9a-f]{16})/.exec(dry.stdout)![1]!;
    const refused = await runCli(['--apply', '--expect', '2', '--expect-digest', digest], dotEnv());
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Refusing to apply/);
    assert.deepEqual(await remaining(1), FULL);
    const applied = await runCli(['--apply', '--expect', '1', '--expect-digest', digest], dotEnv());
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /Applied on development: purged 1/);
    assert.deepEqual(await remaining(1), PURGED);
  });

  it('prints the usage and exits 1 on a wrong argument, and reports a missing configuration', async () => {
    const bad = await runCli(['--bogus'], dotEnv());
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Usage/);
    const none = await runCli([], undefined);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /APP_ENV: is required/);
  });
});
