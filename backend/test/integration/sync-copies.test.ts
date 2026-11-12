import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { loadDatabaseConfig } from '../../src/config.ts';
import { createMongoClient } from '../../src/db/client.ts';
import type { Databases } from '../../src/db/databases.ts';
import { main } from '../../src/tools/sync-copies/main.ts';
import { BLOCK_BYTES, BLOCK_DOCUMENTS, DEFAULT_BLOCK_LIMITS } from '../../src/tools/sync-copies/reconcile.ts';
import type { BlockLimits } from '../../src/tools/sync-copies/reconcile.ts';
import { syncCopies } from '../../src/tools/sync-copies/sync.ts';
import type { SyncOptions } from '../../src/tools/sync-copies/sync.ts';
import { fixtureId, legacyCompany, legacyGroup, legacyPlace } from '../helpers/legacy-fixtures.ts';
import { mongoEnv, openTestClusters, openTestDatabases, testMongoUri } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const CLI = fileURLToPath(new URL('../../src/tools/sync-copies/cli.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../../src/tools/sync-copies', import.meta.url));
const NOW = new Date('2026-11-12T10:00:00.000Z');

interface Run {
  code: number;
  info: string[];
  error: string[];
}

let ctx: TestDatabases;
const common = (): Db => ctx.databases.common();
const groupDb = (n: number): Db => ctx.databases.group(fixtureId('group', n), 'cluster0');
const G = (n: number): ObjectId => fixtureId('group', n);
const env = (overrides: Record<string, string | undefined> = {}) => mongoEnv({ DB_NAME_PREFIX: ctx.prefix, ...overrides }) as Record<string, string>;

async function run(argv: string[], variables: Record<string, string | undefined> = env(), limits?: BlockLimits): Promise<Run> {
  const info: string[] = [];
  const error: string[] = [];
  const code = await main(argv, {
    env: variables,
    loadEnvFile: () => undefined,
    info: (line) => info.push(line),
    error: (line) => error.push(line),
    now: () => NOW,
    ...(limits === undefined ? {} : { limits }),
  });
  return { code, info, error };
}

/** Groups 1 to 3, each with two companies and two places (company 2n-1 and 2n, place 2n-1 and 2n of the same number). */
async function seed(groups = [1, 2, 3]): Promise<void> {
  await common().collection('groups').insertMany(groups.map((n) => legacyGroup(n)));
  for (const n of groups) {
    const companies = [legacyCompany(2 * n - 1, G(n)), legacyCompany(2 * n, G(n))];
    await groupDb(n).collection('companies').insertMany(companies);
    await groupDb(n).collection('places').insertMany([
      legacyPlace(2 * n - 1, G(n), fixtureId('company', 2 * n - 1)),
      legacyPlace(2 * n, G(n), fixtureId('company', 2 * n), { rooms: [{ name: 'room-a', tables: [1, 2] }], devices: [{ type: 'cash', info: { v: 1 } }] }),
    ]);
  }
}

const copies = (collection: 'companies' | 'places', n: number): Promise<Document[]> => common().collection(collection).find({ groupId: G(n) }).sort({ _id: 1 }).toArray();
const originals = (collection: 'companies' | 'places', n: number): Promise<Document[]> => groupDb(n).collection(collection).find({}).sort({ _id: 1 }).toArray();
const allCopies = async (collection: 'companies' | 'places'): Promise<Document[]> => common().collection(collection).find({}).sort({ _id: 1 }).toArray();
const issues = (): Promise<Document[]> => common().collection('syncIssues').find({}).sort({ _id: 1 }).toArray();
const kinds = async (): Promise<string[]> => (await issues()).map((issue) => `${String(issue['kind'])}${issue['repaired'] === true ? '+' : ''}`).sort();
const collectionNames = async (): Promise<string[]> => (await common().listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name).sort();

async function assertMirrors(groups = [1, 2, 3]): Promise<void> {
  for (const collection of ['companies', 'places'] as const) {
    for (const n of groups) {
      const expected = (await originals(collection, n)).map((document) => ({ ...document, groupId: G(n) }));
      assert.deepEqual(await copies(collection, n), expected, `${collection} of group ${String(n)}`);
    }
  }
}

/** Every document of every database of the test prefix, to prove a run wrote nothing. */
async function snapshot(): Promise<Record<string, Document[]>> {
  const result: Record<string, Document[]> = {};
  const { databases } = await ctx.client.db().admin().listDatabases({ nameOnly: true });
  for (const { name } of databases.filter((entry) => entry.name.startsWith(ctx.prefix))) {
    for (const entry of await ctx.client.db(name).listCollections({}, { nameOnly: true }).toArray()) {
      result[`${name}.${entry.name}`] = await ctx.client.db(name).collection(entry.name).find({}).sort({ _id: 1 }).toArray();
    }
  }
  return result;
}

function options(overrides: Partial<SyncOptions> = {}): SyncOptions {
  return {
    apply: true,
    groupId: null,
    runId: new ObjectId(),
    now: () => NOW,
    limits: DEFAULT_BLOCK_LIMITS,
    logger: { error: () => undefined },
    onGroupError: () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  ctx = await openTestDatabases();
});

afterEach(async () => {
  await ctx.cleanup();
});

describe('sync-copies: dry run (the default)', () => {
  it('reports what is missing and writes nothing: no copy, no syncIssues, no index, not even the collections', async () => {
    await seed();
    const before = await snapshot();
    const result = await run([]);
    assert.equal(result.code, 2, result.error.join());
    assert.deepEqual(result.info, [
      result.info[0]!,
      'Dry run on development, nothing written: groups examined 3, with database 3, failed 0',
      'companies: originals 6, copies 0, missing 6, different 0, extra 0, repaired 0',
      'places: originals 6, copies 0, missing 6, different 0, extra 0, repaired 0',
      'Issues: missingCopy 12',
      ...[1, 2, 3].map((n) => `  group ${G(n).toHexString()}: companies missing 2, different 0, extra 0; places missing 2, different 0, extra 0; issues missingCopy 4`),
      'Run again with --apply to repair the differences',
    ]);
    assert.match(result.info[0]!, /^Cluster cluster0: MongoDB \d+\.\d+\.\d+, replica set$/);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await collectionNames(), ['groups']);
  });

  it('still writes nothing when copies exist but differ or are in excess', async () => {
    await seed();
    assert.equal((await run(['--apply'])).code, 2);
    await common().collection('companies').updateOne({ _id: fixtureId('company', 1) }, { $set: { name: 'tampered' } });
    await common().collection('places').deleteOne({ _id: fixtureId('place', 3) });
    await common().collection('companies').insertOne({ _id: new ObjectId(), groupId: G(1), name: 'stray' });
    const before = await snapshot();
    const result = await run([]);
    assert.equal(result.code, 2);
    assert.match(result.info.join('\n'), /companies: originals 6, copies 7, missing 0, different 1, extra 1, repaired 0/);
    assert.match(result.info.join('\n'), /places: originals 6, copies 5, missing 1, different 0, extra 0, repaired 0/);
    assert.deepEqual(await snapshot(), before);
  });

  it('prints no document id, no name, no connection string', async () => {
    await seed();
    const result = await run([]);
    const output = [...result.info, ...result.error].join('\n');
    for (const collection of ['companies', 'places'] as const) {
      for (const n of [1, 2, 3]) {
        for (const document of await originals(collection, n)) {
          assert.ok(!output.includes((document._id as ObjectId).toHexString()));
          assert.ok(!output.includes(String(document['name'])));
        }
      }
    }
    assert.ok(!output.includes(testMongoUri()));
  });
});

describe('sync-copies --apply: initial load and idempotence', () => {
  it('loads the whole documents with the group id of the database, creates the indexes and records ids only', async () => {
    await seed();
    const groupsBefore = (await snapshot())[`${ctx.prefix}development_common.groups`];
    const groupDbsBefore = await Promise.all([1, 2, 3].map((n) => Promise.all([originals('companies', n), originals('places', n)])));
    const result = await run(['--apply']);
    assert.equal(result.code, 2, result.error.join());
    assert.match(result.info.join('\n'), /Applied on development: groups examined 3, with database 3, failed 0/);
    assert.match(result.info.join('\n'), /companies: originals 6, copies 0, missing 6, different 0, extra 0, repaired 6/);
    assert.match(result.info.join('\n'), /places: originals 6, copies 0, missing 6, different 0, extra 0, repaired 6/);
    await assertMirrors();
    // The embedded parts and the integrations are copied identically.
    const place = (await copies('places', 1))[1]!;
    assert.deepEqual(place['rooms'], [{ name: 'room-a', tables: [1, 2] }]);
    assert.equal(place['integrations'].dojo.apiKey, 'fixture-integration-secret');
    // The group databases and the groups are never written.
    assert.deepEqual((await snapshot())[`${ctx.prefix}development_common.groups`], groupsBefore);
    assert.deepEqual(await Promise.all([1, 2, 3].map((n) => Promise.all([originals('companies', n), originals('places', n)]))), groupDbsBefore);

    const stored = await issues();
    assert.equal(stored.length, 12);
    assert.deepEqual(new Set(stored.map((issue) => String((issue['runId'] as ObjectId).toHexString()))).size, 1);
    for (const issue of stored) {
      assert.deepEqual(Object.keys(issue).sort(), ['_id', 'collection', 'detectedAt', 'documentId', 'groupId', 'kind', 'repaired', 'runId']);
      assert.equal(issue['kind'], 'missingCopy');
      assert.equal(issue['repaired'], true);
      assert.deepEqual(issue['detectedAt'], NOW);
      assert.ok(issue['documentId'] instanceof ObjectId && issue['groupId'] instanceof ObjectId);
    }
    const names = async (collection: string) => (await common().collection(collection).indexes()).map((index) => index.name).sort();
    assert.deepEqual(await names('companies'), ['_id_', 'groupId_1__id_1', 'groupId_1_name_1']);
    assert.deepEqual(await names('places'), ['_id_', 'groupId_1__id_1', 'groupId_1_companyId_1', 'groupId_1_name_1']);
    assert.deepEqual(await names('syncIssues'), ['_id_', 'detectedAt_ttl', 'kind_1_detectedAt_-1', 'runId_1']);
    const ttl = (await common().collection('syncIssues').indexes()).find((index) => index.name === 'detectedAt_ttl')!;
    assert.equal(ttl.expireAfterSeconds, 180 * 24 * 60 * 60);
    assert.deepEqual(await collectionNames(), ['companies', 'groups', 'places', 'syncIssues']);
  });

  it('keeps the BSON numeric types exactly (a whole-number double stays a double, an int64 stays an int64)', async () => {
    await seed([1]);
    const { Double, Int32, Long } = await import('mongodb');
    const id = fixtureId('place', 1);
    await groupDb(1).collection('places').updateOne({ _id: id }, { $set: { price: new Double(5), count: new Long(7), small: new Int32(3) } });
    assert.equal((await run(['--apply'])).code, 2);
    const raw = await common().collection('places').findOne({ _id: id }, { promoteValues: false, promoteLongs: false });
    assert.ok(raw?.['price'] instanceof Double);
    assert.ok(raw?.['count'] instanceof Long);
    assert.ok(raw?.['small'] instanceof Int32);
    assert.equal((await run([])).code, 0);
  });

  it('is idempotent: the second run finds nothing, exits 0 and writes nothing', async () => {
    await seed();
    assert.equal((await run(['--apply'])).code, 2);
    const before = await snapshot();
    for (const argv of [['--apply'], []]) {
      const again = await run(argv);
      assert.equal(again.code, 0, again.error.join());
      assert.match(again.info.join('\n'), /companies: originals 6, copies 6, missing 0, different 0, extra 0, repaired 0/);
      assert.ok(again.info.includes('Issues: none'));
      assert.equal(again.info.filter((line) => line.startsWith('  group')).length, 0);
      assert.deepEqual(await snapshot(), before);
    }
  });
});

describe('sync-copies: reconciliation', () => {
  beforeEach(async () => {
    await seed();
    assert.equal((await run(['--apply'])).code, 2);
    await common().collection('syncIssues').deleteMany({});
  });

  it('writes missing and different copies byte-exact, reports the extra ones without deleting them, and records each', async () => {
    await common().collection('companies').deleteOne({ _id: fixtureId('company', 1) });
    await common().collection('companies').updateOne({ _id: fixtureId('company', 3) }, { $set: { name: 'tampered' } });
    // Same value, other type: the number differs from the numeric string.
    await common().collection('places').updateOne({ _id: fixtureId('place', 5) }, { $set: { postcode: 100 } });
    await common().collection('places').updateOne({ _id: fixtureId('place', 2) }, { $unset: { rooms: '' } });
    // Same content, other field order.
    const reordered = (await copies('companies', 3))[1]!;
    await common().collection('companies').replaceOne({ _id: reordered._id }, { ...Object.fromEntries(Object.entries(reordered).reverse().filter(([key]) => key !== '_id')) });
    const extraId = new ObjectId();
    await common().collection('companies').insertOne({ _id: extraId, groupId: G(2), name: 'gone' });
    await common().collection('places').insertOne({ _id: new ObjectId(), groupId: G(3), name: 'gone-too' });

    const result = await run(['--apply']);
    assert.equal(result.code, 2, result.error.join());
    assert.match(result.info.join('\n'), /companies: originals 6, copies 6, missing 1, different 2, extra 1, repaired 3/);
    assert.match(result.info.join('\n'), /places: originals 6, copies 7, missing 0, different 2, extra 1, repaired 2/);
    assert.deepEqual(await kinds(), ['differentCopy+', 'differentCopy+', 'differentCopy+', 'differentCopy+', 'extraCopy', 'extraCopy', 'missingCopy+']);
    const extra = (await issues()).find((issue) => issue['kind'] === 'extraCopy' && issue['collection'] === 'companies')!;
    assert.deepEqual([extra['documentId'], extra['groupId'], extra['repaired']], [extraId, G(2), false]);
    assert.equal(await common().collection('companies').countDocuments({ _id: extraId }), 1, 'nothing is ever deleted');
    // Only the extras remain different from the originals.
    await common().collection('companies').deleteOne({ _id: extraId });
    await common().collection('places').deleteMany({ name: 'gone-too' });
    await assertMirrors();
    assert.equal((await run([])).code, 0);
  });

  it('never touches a copy of another group, even with the same _id: it records idCollision and goes on with the rest of the group', async () => {
    await common().collection('companies').deleteMany({ groupId: { $in: [G(1), G(2)] } });
    // A copy of group 3 that carries the _id of the company 1 of group 1.
    const collided = fixtureId('company', 1);
    await common().collection('companies').updateOne({ _id: collided }, { $set: { groupId: G(3), name: 'owned by group 3' } }, { upsert: true });
    const result = await run(['--apply']);
    assert.equal(result.code, 2, result.error.join());
    assert.deepEqual(result.error, []);
    assert.match(result.info.join('\n'), /failed 0/);
    assert.match(result.info.join('\n'), /Issues: missingCopy 3, extraCopy 1, idCollision 1/);
    assert.equal((await copies('companies', 1)).map((document) => document._id.toHexString()).join(), fixtureId('company', 2).toHexString(), 'the other company of the group is copied');
    assert.equal((await copies('companies', 2)).length, 2);
    // The copy of the other group is untouched.
    assert.equal((await common().collection('companies').findOne({ _id: collided }))!['name'], 'owned by group 3');
    const collision = (await issues()).find((issue) => issue['kind'] === 'idCollision')!;
    assert.deepEqual([collision['documentId'], collision['groupId'], collision['collection'], collision['repaired']], [collided, G(1), 'companies', false]);
    // It stays reported at every run, until somebody settles it.
    const again = await run([]);
    assert.equal(again.code, 2);
  });

  it('does not remove the copy of a document deleted from the group database: it only reports it', async () => {
    await groupDb(1).collection('places').deleteOne({ _id: fixtureId('place', 1) });
    await groupDb(2).collection('companies').deleteMany({});
    const result = await run(['--apply']);
    assert.equal(result.code, 0);
    assert.match(result.info.join('\n'), /companies: originals 4, copies 6, missing 0, different 0, extra 2, repaired 0/);
    assert.match(result.info.join('\n'), /Issues: extraCopy 3/);
    assert.equal(await common().collection('places').countDocuments({ _id: fixtureId('place', 1) }), 1);
    assert.equal((await copies('companies', 2)).length, 2);
  });

  it('treats a group database without the collections as empty: all its copies are extra, none is deleted', async () => {
    await groupDb(3).dropDatabase();
    await groupDb(3).collection('products').insertOne({ n: 1 });
    const result = await run(['--apply']);
    assert.equal(result.code, 0);
    assert.match(result.info.join('\n'), /places: originals 4, copies 6, missing 0, different 0, extra 2, repaired 0/);
    assert.equal((await copies('places', 3)).length + (await copies('companies', 3)).length, 4);
  });

  it('keeps the groupId of a copy of a document whose original keeps a wrong one: the copy is made with the right one, the original is left alone', async () => {
    await groupDb(1).collection('places').updateOne({ _id: fixtureId('place', 1) }, { $set: { groupId: G(2) } });
    await groupDb(1).collection('places').updateOne({ _id: fixtureId('place', 2) }, { $unset: { groupId: '' } });
    await groupDb(1).collection('companies').updateOne({ _id: fixtureId('company', 1) }, { $set: { groupId: G(1).toHexString() } });
    await groupDb(1).collection('companies').updateOne({ _id: fixtureId('company', 2) }, { $set: { groupId: null } });
    const result = await run(['--apply']);
    assert.equal(result.code, 2);
    assert.deepEqual(await kinds(), ['differentCopy+', 'groupIdMismatch', 'groupIdMismatch', 'groupIdMismatch', 'groupIdMismatch']);
    // The original is untouched; where the field was missing it goes last in the copy.
    assert.equal((await originals('places', 1))[0]!['groupId'].toHexString(), G(2).toHexString());
    assert.equal('groupId' in (await originals('places', 1))[1]!, false);
    assert.equal(Object.keys((await copies('places', 1))[1]!).at(-1), 'groupId');
    assert.equal((await copies('places', 1))[0]!['groupId'].toHexString(), G(1).toHexString());
    // Nothing is left of the copy in the wrong group.
    assert.equal(await common().collection('places').countDocuments({ groupId: G(2), _id: fixtureId('place', 1) }), 0);
    await assertMirrors();
    // The anomaly is still there, so it is still reported, but nothing else is.
    const again = await run(['--apply']);
    assert.equal(again.code, 0, 'a known data issue does not change the exit code');
    assert.match(again.info.join('\n'), /Issues: groupIdMismatch 4$/m);
    assert.match(again.info.join('\n'), /companies: originals 6, copies 6, missing 0, different 0, extra 0, repaired 0/);
  });

  it('reports a place whose company is missing, unknown or not an id, and still copies it', async () => {
    const places = groupDb(2).collection('places');
    await places.updateOne({ _id: fixtureId('place', 3) }, { $unset: { companyId: '' } });
    await places.updateOne({ _id: fixtureId('place', 4) }, { $set: { companyId: fixtureId('company', 999) } });
    await places.insertOne(legacyPlace(30, G(2), fixtureId('company', 3) as ObjectId, { companyId: 'not-an-id' }));
    await places.insertOne(legacyPlace(31, G(2), fixtureId('company', 3)));
    for (const limits of [DEFAULT_BLOCK_LIMITS, { documents: 1, bytes: BLOCK_BYTES }]) {
      await common().collection('syncIssues').deleteMany({});
      const result = await run([], env(), limits);
      assert.equal(result.code, 2);
      assert.deepEqual(await kinds(), []);
      assert.match(result.info.join('\n'), /Issues: missingCopy 2, differentCopy 2, orphanCompany 3/);
    }
    await run(['--apply']);
    const orphans = (await issues()).filter((issue) => issue['kind'] === 'orphanCompany');
    assert.deepEqual(orphans.map((issue) => (issue['documentId'] as ObjectId).toHexString()).sort(), [fixtureId('place', 3), fixtureId('place', 4), fixtureId('place', 30)].map((value) => value.toHexString()).sort());
    assert.ok(orphans.every((issue) => issue['repaired'] === false && issue['collection'] === 'places'));
    assert.equal((await copies('places', 2)).length, 4);
  });

  it('skips and reports a document whose _id is not an ObjectId', async () => {
    await groupDb(1).collection('companies').insertMany([{ _id: 'legacy-string-id', groupId: G(1), name: 'odd' }, { _id: 42, name: 'odder' }] as unknown as Document[]);
    const result = await run(['--apply']);
    assert.equal(result.code, 0);
    assert.match(result.info.join('\n'), /Issues: nonObjectId 2/);
    assert.match(result.info.join('\n'), /companies: originals 6, copies 6/);
    assert.deepEqual(await kinds(), ['nonObjectId', 'nonObjectId']);
    assert.ok((await issues()).every((issue) => issue['documentId'] === null && issue['collection'] === 'companies'));
    assert.equal(await common().collection('companies').countDocuments({ name: 'odd' }), 0);
  });
});

describe('sync-copies: groups and databases that do not match', () => {
  it('reports a database without a group document and does not copy it, whatever the cluster', async () => {
    await seed();
    const stray = fixtureId('group', 77);
    await ctx.databases.group(stray, 'cluster0').collection('companies').insertOne(legacyCompany(70, stray));
    await common().collection('companies').insertOne({ ...legacyCompany(70, stray) });
    const result = await run(['--apply']);
    assert.equal(result.code, 2);
    assert.match(result.info.join('\n'), /Issues: missingCopy 12, extraCopy 1, databaseWithoutGroup 1/);
    assert.match(result.info.join('\n'), new RegExp(`group ${stray.toHexString()}: companies missing 0, different 0, extra 1; .*issues extraCopy 1, databaseWithoutGroup 1`));
    assert.equal(await common().collection('companies').countDocuments({ groupId: stray }), 1, 'its copy is reported, never removed');
    const record = (await issues()).find((issue) => issue['kind'] === 'databaseWithoutGroup')!;
    assert.deepEqual([record['groupId'], record['collection'], record['documentId'], record['repaired']], [stray, null, null, false]);
  });

  it('counts the copies of a group that has no database, of a group that does not exist and of a group with an unusable cluster, and deletes none', async () => {
    await seed([1]);
    await common().collection('groups').insertMany([legacyGroup(2), legacyGroup(3, { dataCluster: 'ghost' })]);
    const nobody = fixtureId('group', 50);
    const orphanCopy = (collection: string, group: ObjectId, _id: unknown = new ObjectId()): Promise<unknown> => common().collection(collection).insertOne({ _id, groupId: group, name: 'x' } as Document);
    await orphanCopy('companies', G(2));
    await orphanCopy('places', G(2));
    await orphanCopy('places', G(2), 'string-id');
    await orphanCopy('companies', nobody);
    await orphanCopy('companies', G(3));
    const result = await run(['--apply']);
    assert.equal(result.code, 2, result.error.join());
    assert.match(result.info.join('\n'), /Issues: missingCopy 4, extraCopy 3, unknownCluster 1, invalidCopy 1/);
    assert.equal(await common().collection('companies').countDocuments({ groupId: { $in: [G(2), nobody] } }), 2);
    assert.equal(await common().collection('places').countDocuments({ groupId: G(2) }), 2);
    assert.equal(await common().collection('companies').countDocuments({ groupId: G(3) }), 1);
    const extras = (await issues()).filter((issue) => issue['kind'] === 'extraCopy');
    assert.ok(extras.every((issue) => issue['documentId'] instanceof ObjectId && issue['repaired'] === false));
    const invalid = (await issues()).find((issue) => issue['kind'] === 'invalidCopy')!;
    assert.deepEqual([invalid['groupId'], invalid['documentId'], invalid['collection']], [G(2), null, 'places']);
    const unknown = (await issues()).find((issue) => issue['kind'] === 'unknownCluster')!;
    assert.deepEqual([unknown['groupId'], unknown['collection'], unknown['documentId']], [G(3), null, null]);
  });

  it('reports the extra and the invalid copies of a dry run', async () => {
    await seed([1]);
    await common().collection('places').insertMany([{ _id: new ObjectId(), groupId: fixtureId('group', 60) }, { _id: 'string-id', groupId: fixtureId('group', 60) }] as Document[]);
    const result = await run([]);
    assert.equal(result.code, 2);
    assert.match(result.info.join('\n'), /Issues: missingCopy 4, extraCopy 1, invalidCopy 1/);
    assert.equal(await common().collection('places').countDocuments(), 2);
  });
});

describe('sync-copies: copies whose groupId is an array', () => {
  it('reports them as invalid copies, with and without a group filter, and never modifies them', async () => {
    await seed([1]);
    const id = new ObjectId();
    await common().collection('places').insertOne({ _id: id, groupId: [G(1), G(2)] });
    const all = await run([]);
    assert.deepEqual(all.error, []);
    assert.match(all.info.join('\n'), /invalidCopy 1/);
    const one = await run(['--group', G(1).toHexString()]);
    assert.match(one.info.join('\n'), /invalidCopy 1/);
    const other = await run(['--group', G(3).toHexString()]);
    assert.doesNotMatch(other.info.join('\n'), /invalidCopy/);
    assert.deepEqual((await common().collection('places').findOne({ _id: id }))!['groupId'], [G(1), G(2)]);
  });
});

describe('sync-copies --group', () => {
  it('limits everything to one group, the extra copies included', async () => {
    await seed();
    const elsewhere = fixtureId('group', 60);
    await common().collection('places').insertOne({ _id: new ObjectId(), groupId: elsewhere });
    await groupDb(1).collection('places').deleteOne({ _id: fixtureId('place', 1) });
    await common().collection('places').insertOne({ _id: fixtureId('place', 1), groupId: G(1) });
    const result = await run(['--apply', '--group', G(2).toHexString()]);
    assert.equal(result.code, 2, result.error.join());
    assert.match(result.info.join('\n'), /groups examined 1, with database 1/);
    assert.equal((await copies('companies', 2)).length, 2);
    assert.equal((await copies('companies', 1)).length + (await copies('companies', 3)).length, 0);
    assert.equal(await common().collection('places').countDocuments({ groupId: elsewhere }), 1);
    assert.equal(await common().collection('places').countDocuments({ groupId: G(1) }), 1, 'the extra copy of another group stays');
  });

  it('counts the copies of the given group when it has no database, and only those, deleting nothing', async () => {
    await seed([1]);
    const gone = fixtureId('group', 61);
    const other = fixtureId('group', 62);
    await common().collection('companies').insertMany([{ _id: new ObjectId(), groupId: gone }, { _id: new ObjectId(), groupId: other }]);
    const result = await run(['--apply', '--group', gone.toHexString()]);
    assert.equal(result.code, 0);
    assert.match(result.info.join('\n'), /groups examined 0, with database 0/);
    assert.match(result.info.join('\n'), /Issues: extraCopy 1/);
    assert.equal(await common().collection('companies').countDocuments(), 2);
  });

  it('reports a database without a group document only for the group asked for', async () => {
    await seed([1]);
    for (const n of [80, 81]) {
      await ctx.databases.group(fixtureId('group', n), 'cluster0').collection('companies').insertOne(legacyCompany(n, fixtureId('group', n)));
    }
    const result = await run(['--group', fixtureId('group', 80).toHexString()]);
    assert.equal(result.code, 0);
    assert.match(result.info.join('\n'), /Issues: databaseWithoutGroup 1/);
    assert.match(result.info.join('\n'), new RegExp(fixtureId('group', 80).toHexString()));
    assert.ok(!result.info.join('\n').includes(fixtureId('group', 81).toHexString()));
    assert.ok(!result.info.join('\n').includes(G(1).toHexString()));
  });

  it('works on a group with an unusable cluster by reporting it', async () => {
    await common().collection('groups').insertOne(legacyGroup(1, { dataCluster: 'ghost' }));
    const result = await run(['--group', G(1).toHexString()]);
    assert.equal(result.code, 0);
    assert.match(result.info.join('\n'), /Issues: unknownCluster 1/);
  });

  it('needs only the cluster of the group: the others may be down', async () => {
    await seed([1]);
    const down = { MONGODB_URI: undefined, MONGODB_CLUSTERS: 'cluster0,cluster1', MONGODB_URI_CLUSTER0: testMongoUri(), MONGODB_URI_CLUSTER1: 'mongodb://127.0.0.1:1/?directConnection=true' };
    const one = await run(['--apply', '--group', G(1).toHexString()], env(down));
    assert.equal(one.code, 2, one.error.join());
    assert.equal((await copies('companies', 1)).length, 2);
    const all = await run(['--apply'], env(down));
    assert.equal(all.code, 1);
    assert.ok(all.error.length > 0);
    assert.ok(all.error.every((line) => !line.includes('127.0.0.1')));
  });
});

describe('sync-copies: blocks and transactions', () => {
  /** Counts the transactions of the common cluster. */
  function counting(databases: Databases, before?: () => Promise<void>): { databases: Databases; transactions: () => number } {
    let count = 0;
    let first = true;
    return {
      databases: {
        ...databases,
        transaction: async (work) => {
          count += 1;
          if (first && before !== undefined) {
            first = false;
            await before();
          }
          return databases.transaction(work);
        },
      },
      transactions: () => count,
    };
  }

  it('repairs in blocks of the configured size, one transaction each, and of the configured bytes', async () => {
    await seed([1]);
    await groupDb(1).collection('companies').insertMany([3, 4, 5, 6, 7].map((n) => legacyCompany(100 + n, G(1))));
    for (const [limits, expected] of [
      [{ documents: 2, bytes: BLOCK_BYTES }, 4 + 1],
      [{ documents: 1000, bytes: 1 }, 7 + 2],
      [{ documents: 1000, bytes: BLOCK_BYTES }, 1 + 1],
    ] as const) {
      await common().collection('companies').deleteMany({});
      await common().collection('places').deleteMany({});
      const spy = counting(ctx.databases);
      const result = await syncCopies(spy.databases, options({ limits, groupId: G(1) }));
      assert.equal(spy.transactions(), expected, JSON.stringify(limits));
      assert.equal(result.errors, 0);
      await assertMirrors([1]);
    }
    assert.deepEqual([BLOCK_DOCUMENTS, BLOCK_BYTES], [200, 8 * 1024 * 1024]);
    assert.deepEqual(DEFAULT_BLOCK_LIMITS, { documents: 200, bytes: 8 * 1024 * 1024 });
  });


  it('re-reads the originals inside the transaction: a write that lands after the comparison wins over the stale data', async () => {
    await seed([1]);
    const spy = counting(ctx.databases, async () => {
      await groupDb(1).collection('companies').updateOne({ _id: fixtureId('company', 1) }, { $set: { name: 'changed meanwhile' } });
      await groupDb(1).collection('companies').deleteOne({ _id: fixtureId('company', 2) });
    });
    const result = await syncCopies(spy.databases, options({ groupId: G(1) }));
    assert.equal(result.errors, 0);
    assert.equal((await copies('companies', 1)).map((document) => document['name']).join(), 'changed meanwhile');
    await assertMirrors([1]);
  });

  it('does the same for a copy that was already there but different, and leaves the copy of an original that is gone before the repair', async () => {
    await seed([1]);
    assert.equal((await run(['--apply'])).code, 2);
    await groupDb(1).collection('companies').updateMany({}, { $set: { name: 'first change' } });
    const spy = counting(ctx.databases, async () => {
      await groupDb(1).collection('companies').updateOne({ _id: fixtureId('company', 1) }, { $set: { name: 'second change' } });
      await groupDb(1).collection('companies').deleteOne({ _id: fixtureId('company', 2) });
    });
    await syncCopies(spy.databases, options({ groupId: G(1) }));
    assert.deepEqual((await copies('companies', 1)).map((document) => document['name']), ['second change', 'company-002'], 'nothing is deleted');
  });

  it('records the kind seen at write time: a copy that appeared meanwhile is different, or already right and skipped', async () => {
    await seed([1]);
    const spy = counting(ctx.databases, async () => {
      await common().collection('companies').insertMany([{ ...legacyCompany(1, G(1)), name: 'late and different' }, legacyCompany(2, G(1))]);
    });
    const result = await syncCopies(spy.databases, options({ groupId: G(1) }));
    assert.equal(result.errors, 0);
    const companies = (await issues()).filter((issue) => issue['collection'] === 'companies');
    assert.deepEqual(companies.map((issue) => [issue['kind'], issue['repaired'], issue['documentId']]), [['differentCopy', true, fixtureId('company', 1)]]);
    await assertMirrors([1]);
  });
});

describe('sync-copies: several clusters', () => {
  it('repairs a group of the common cluster in a transaction and a group of another cluster without one', async () => {
    const clusters = await openTestClusters();
    try {
      const databases = clusters.databases;
      await databases.common().collection('groups').insertMany([legacyGroup(1), legacyGroup(2, { dataCluster: 'cluster1' })]);
      for (const [n, cluster] of [[1, 'cluster0'], [2, 'cluster1']] as const) {
        await databases.group(G(n), cluster).collection('companies').insertOne(legacyCompany(n, G(n)));
        await databases.group(G(n), cluster).collection('places').insertOne(legacyPlace(n, G(n), fixtureId('company', n)));
      }
      let transactions = 0;
      const counted: Databases = {
        ...databases,
        transaction: (work) => {
          transactions += 1;
          return databases.transaction(work);
        },
      };
      const result = await syncCopies(counted, options());
      assert.equal(result.errors, 0);
      assert.deepEqual(result.checks.map((check) => check.clusterId), ['cluster0', 'cluster1']);
      assert.equal(transactions, 2, 'one block per collection, for the group of the common cluster only');
      for (const n of [1, 2]) {
        assert.equal(await databases.common().collection('companies').countDocuments({ groupId: G(n) }), 1);
        assert.equal(await databases.common().collection('places').countDocuments({ groupId: G(n) }), 1);
      }
      // Reads of the group databases go through the main connection of the cluster of each group.
      assert.ok(clusters.opened.get('cluster1:main')!.some((name) => name.endsWith(G(2).toHexString())));
      assert.ok(!clusters.opened.get('cluster1:main')!.some((name) => name.endsWith(G(1).toHexString())));
    } finally {
      await clusters.cleanup();
    }
  });
});

describe('sync-copies: errors', () => {
  it('counts a failure while reading the extra copies of a group and goes on with the others', async () => {
    await seed([1]);
    const doomed = [fixtureId('group', 91), fixtureId('group', 92)];
    for (const group of doomed) {
      await common().collection('companies').insertOne({ _id: new ObjectId(), groupId: group });
    }
    const real = ctx.databases.common();
    const failing = new Proxy(real, {
      get: (target, property) =>
        property === 'collection'
          ? (name: string) => {
              const collection = target.collection(name);
              return new Proxy(collection, {
                get: (inner, innerProperty) =>
                  innerProperty === 'find'
                    ? (filter: Document, findOptions?: Document) => {
                        if (filter['groupId'] instanceof ObjectId && filter['groupId'].equals(doomed[0]!)) {
                          throw new Error('read refused');
                        }
                        return inner.find(filter, findOptions);
                      }
                    : Reflect.get(inner, innerProperty, inner) instanceof Function
                      ? (Reflect.get(inner, innerProperty, inner) as (...args: unknown[]) => unknown).bind(inner)
                      : Reflect.get(inner, innerProperty, inner),
              });
            }
          : Reflect.get(target, property, target) instanceof Function
            ? (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).bind(target)
            : Reflect.get(target, property, target),
    });
    const failures: string[] = [];
    const result = await syncCopies({ ...ctx.databases, common: () => failing }, options({ onGroupError: (hex, error) => failures.push(`${hex} ${(error as Error).message}`) }));
    assert.equal(result.errors, 1);
    assert.deepEqual(failures, [`${doomed[0]!.toHexString()} read refused`]);
    assert.equal(result.issues.totals().extraCopy, 1, 'the other group is still reported');
    assert.equal(await common().collection('companies').countDocuments({ groupId: { $in: doomed } }), 2);
  });

  it('stops before any write when a cluster is older than 4.4 or is not a replica set', async () => {
    await seed();
    const before = await snapshot();
    for (const [answer, message] of [
      [{ version: '4.2.9', setName: 'rs0' }, /MongoDB 4\.2\.9 is not supported, 4\.4 or later is required/],
      [{ version: '8.0.4', setName: undefined }, /MongoDB 8\.0\.4 is not a replica set/],
    ] as const) {
      const errors: string[] = [];
      const code = await main(['--apply'], {
        env: env(),
        loadEnvFile: () => undefined,
        info: () => undefined,
        error: (line) => errors.push(line),
        createClient: (config, options) => {
          const client = createMongoClient(config, options);
          const open = client.db.bind(client);
          client.db = ((name?: string) => {
            const db = open(name);
            if (name === undefined) {
              const admin = db.admin();
              db.admin = (() => ({ listDatabases: (listOptions: Document) => admin.listDatabases(listOptions), command: async (body: Document) => ('buildInfo' in body ? { version: answer.version } : answer.setName === undefined ? { isWritablePrimary: true } : { setName: answer.setName }) })) as unknown as typeof db.admin;
            }
            return db;
          }) as typeof client.db;
          return client;
        },
      });
      assert.equal(code, 1);
      assert.match(errors.join(), message);
      assert.deepEqual(await snapshot(), before, 'nothing was written, not even an index');
    }
  });

  it('survives a group that fails to read, reporting it without the connection string', async () => {
    await seed([1]);
    const uri = testMongoUri();
    const errors: string[] = [];
    const info: string[] = [];
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
          if (name !== undefined && name.endsWith(G(1).toHexString())) {
            const collection = db.collection.bind(db);
            db.collection = ((collectionName: string) => {
              const handle = collection(collectionName);
              if (collectionName === 'companies') {
                handle.find = (() => {
                  throw new Error(`cannot read ${uri}`);
                }) as typeof handle.find;
              }
              return handle;
            }) as typeof db.collection;
          }
          return db;
        }) as typeof client.db;
        return client;
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(errors, [`Group ${G(1).toHexString()} failed: Error: cannot read [redacted]`]);
    assert.match(info.join('\n'), /failed 1/);
  });
});

describe('sync-copies: environment and clusters', () => {
  it('works on development only: production is refused, as --env or as APP_ENV, before any client is created', async () => {
    await seed();
    const before = await snapshot();
    for (const [argv, appEnv] of [[['--env', 'production', '--apply'], 'development'], [['--env', 'production'], 'production'], [['--apply'], 'production'], [['--env', 'development', '--apply'], 'production']] as const) {
      let created = 0;
      const errors: string[] = [];
      const code = await main([...argv], {
        env: env({ APP_ENV: appEnv, MONGODB_URI: appEnv === 'production' ? 'mongodb://127.0.0.1:1/?tls=true' : testMongoUri() }),
        loadEnvFile: () => undefined,
        info: () => undefined,
        error: (line) => errors.push(line),
        createClient: (config, options) => {
          created += 1;
          return createMongoClient(config, options);
        },
      });
      assert.equal(code, 1, argv.join(' '));
      assert.match(errors.join(), /development environment only|does not match/, argv.join(' '));
      assert.equal(created, 0);
    }
    assert.match((await run(['--env', 'production'])).error.join(), /development environment only/);
    assert.deepEqual(await snapshot(), before);
  });

  it('refuses to run when the common database is not there (wrong prefix) or has no groups, and writes nothing', async () => {
    const wrong = await run(['--apply'], env({ DB_NAME_PREFIX: `${ctx.prefix.slice(0, -1)}w_` }));
    assert.equal(wrong.code, 1);
    assert.match(wrong.error.join(), /common database does not exist.*DB_NAME_PREFIX/);
    await common().collection('probe').insertOne({ n: 1 });
    const empty = await run(['--apply']);
    assert.equal(empty.code, 1);
    assert.match(empty.error.join(), /groups collection .* is empty/);
    assert.deepEqual(await collectionNames(), ['probe']);
  });

  it('reports a close that fails without the connection string', async () => {
    await seed([1]);
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
    assert.equal(code, 2);
    assert.equal(errors.filter((line) => line.startsWith('Error: close failed')).length, 2);
    assert.ok(errors.every((line) => !line.includes(uri)));
  });

  it('fails cleanly when MongoDB is unreachable, without printing the URI', async () => {
    const uri = 'mongodb://127.0.0.1:1/?directConnection=true';
    const result = await run(['--apply'], env({ MONGODB_URI: uri, MONGODB_SERVER_SELECTION_TIMEOUT_MS: '1000' }));
    assert.equal(result.code, 1);
    assert.ok(result.error.length > 0);
    assert.ok(!result.error.join().includes(uri));
  });
});

describe('sync-copies: command line and configuration', () => {
  it('accepts --env <name>, --apply and --group <24 hex>, once each', async () => {
    const good = G(1).toHexString();
    for (const argv of [['--env'], ['--env', 'staging'], ['--apply', '--apply'], ['--group'], ['--group', 'abc'], ['--group', 'A'.repeat(24)], ['--group', `${good}0`], ['--group', good, '--group', good], ['--bogus'], ['apply'], ['--group=' + good]]) {
      const result = await run(argv);
      assert.equal(result.code, 1, argv.join(' '));
      assert.match(result.error.join(), /Usage/);
    }
    await seed([1]);
    assert.equal((await run(['--apply', '--env', 'development', '--group', good])).code, 2);
  });

  it('reports configuration problems by variable name, tolerating a missing .env only', async () => {
    const errors: string[] = [];
    const missing = await main([], { env: {}, loadEnvFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, info: () => undefined, error: (line) => errors.push(line) });
    assert.equal(missing, 1);
    assert.match(errors.join(), /APP_ENV: is required/);
    for (const thrown of [Object.assign(new Error('EISDIR: is a directory'), { code: 'EISDIR' }), 'not an error object']) {
      const lines: string[] = [];
      const code = await main([], { env: env(), loadEnvFile: () => { throw thrown; }, info: () => undefined, error: (line) => lines.push(line) });
      assert.equal(code, 1);
      assert.match(lines.join(), typeof thrown === 'string' ? /Unknown error/ : /EISDIR/);
    }
    const noEnv = await run([], {});
    assert.match(noEnv.error.join(), /APP_ENV: is required/);
  });
});

describe('the sources of the command', () => {
  it('open the group databases for reading only: no write call is made on their collections', async () => {
    const writes = /\.(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndReplace|findOneAndDelete|drop|createIndex|createIndexes|createCollection|renameCollection)\(/g;
    for (const file of await readdir(SRC)) {
      const text = await readFile(join(SRC, file), 'utf8');
      for (const match of text.matchAll(writes)) {
        const line = text.slice(text.lastIndexOf('\n', match.index) + 1, text.indexOf('\n', match.index));
        assert.ok(!/groupDb|\boriginal\b/.test(line), `${file}: a write on a group database: ${line.trim()}`);
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
  const cwd = await mkdtemp(join(tmpdir(), 'flood-sync-'));
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

describe('node src/tools/sync-copies/cli.ts', () => {
  it('reads .env, performs a dry run and exits with the code of the report', async () => {
    await seed([1]);
    const outcome = await runCli([], dotEnv());
    assert.equal(outcome.code, 2, outcome.stderr);
    assert.match(outcome.stdout, /Dry run on development, nothing written/);
    assert.equal(await common().collection('companies').countDocuments(), 0);
    const applied = await runCli(['--apply'], dotEnv());
    assert.equal(applied.code, 2, applied.stderr);
    assert.match(applied.stdout, /Applied on development/);
    assert.equal(await common().collection('companies').countDocuments(), 2);
  });

  it('exits 0 when the copies match', async () => {
    await seed([1]);
    assert.equal((await run(['--apply'])).code, 2);
    const outcome = await runCli(['--group', G(1).toHexString()], dotEnv());
    assert.equal(outcome.code, 0, outcome.stderr);
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
