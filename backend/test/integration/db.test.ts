import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, MongoClient } from 'mongodb';
import type { CollectionRegistry } from '../../src/db/collections.ts';
import { createMongoClient } from '../../src/db/client.ts';
import { assertAllowedDatabaseName, createDatabases } from '../../src/db/databases.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { createPingCheck } from '../../src/db/ping.ts';
import { Secret } from '../../src/shared/security/secret.ts';
import { freePort, startApp } from '../helpers/app.ts';
import { openTestDatabases, singleCluster, TEST_CLUSTER } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const REGISTRY: CollectionRegistry = {
  common: {
    probes: {
      ownership: 'new',
      indexes: [
        { name: 'code_unique', key: { code: 1 }, unique: true },
        { name: 'ttl_expires', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
        { name: 'owner_created', key: { ownerId: 1, createdAt: -1 } },
      ],
    },
  },
  group: {},
};

let ctx: TestDatabases;
before(async () => {
  ctx = await openTestDatabases();
});
after(async () => {
  await ctx.cleanup();
});

describe('ensureIndexes (real MongoDB)', () => {
  it('creates the declared indexes with explicit names, idempotently', async () => {
    await ensureIndexes(ctx.databases, REGISTRY);
    await ensureIndexes(ctx.databases, REGISTRY);
    const indexes = await ctx.databases.common().collection('probes').indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));
    assert.deepEqual([...byName.keys()].sort(), ['_id_', 'code_unique', 'owner_created', 'ttl_expires']);
    assert.equal(byName.get('code_unique')?.unique, true);
    assert.equal(byName.get('ttl_expires')?.expireAfterSeconds, 0);
    assert.equal(byName.get('owner_created')?.unique, undefined);
    assert.equal(byName.get('owner_created')?.expireAfterSeconds, undefined);
  });

  it('really enforces the unique index', async () => {
    await ensureIndexes(ctx.databases, REGISTRY);
    const probes = ctx.databases.common().collection('probes');
    await probes.insertOne({ code: 'A' });
    await assert.rejects(probes.insertOne({ code: 'A' }), (error: { code?: number }) => error.code === 11000);
  });

  it('applies the real registry idempotently: the users indexes are non-unique and the legacy unique index is untouched', async () => {
    const users = ctx.databases.common().collection('users');
    // As in production: the legacy unique index on userName already exists before the backend starts.
    await users.createIndex({ userName: 1 }, { name: 'userName_1', unique: true });
    await ensureIndexes(ctx.databases);
    await ensureIndexes(ctx.databases);
    const byName = new Map((await users.indexes()).map((index) => [index.name, index]));
    assert.deepEqual([...byName.keys()].sort(), ['_id_', 'dealerId_1', 'groupId_1_role_1', 'userName_1']);
    assert.equal(byName.get('userName_1')?.unique, true);
    assert.deepEqual(byName.get('groupId_1_role_1')?.key, { groupId: 1, role: 1 });
    assert.deepEqual(byName.get('dealerId_1')?.key, { dealerId: 1 });
    // Nothing unique or TTL was added by us, and no validator was put on the shared collection.
    for (const name of ['groupId_1_role_1', 'dealerId_1']) {
      assert.equal(byName.get(name)?.unique, undefined);
      assert.equal(byName.get(name)?.expireAfterSeconds, undefined);
    }
    const [usersInfo] = await ctx.databases.common().listCollections({ name: 'users' }).toArray();
    assert.equal((usersInfo as { options?: { validator?: unknown } }).options?.validator, undefined);
    const [credentialsInfo] = await ctx.databases.common().listCollections({ name: 'userCredentials' }).toArray();
    assert.ok((credentialsInfo as { options?: { validator?: unknown } }).options?.validator !== undefined);
    assert.deepEqual((await ctx.databases.common().collection('userCredentials').indexes()).map((index) => index.name), ['_id_']);
    const sessionIndexes = new Map((await ctx.databases.common().collection('sessions').indexes()).map((index) => [index.name, index]));
    assert.deepEqual([...sessionIndexes.keys()].sort(), ['_id_', 'accessTokenHash_1', 'expiresAt_1', 'previousRefreshHashes_1', 'refreshTokenHash_1', 'userId_1_revokedAt_1']);
    assert.equal(sessionIndexes.get('accessTokenHash_1')?.unique, true);
    assert.equal(sessionIndexes.get('refreshTokenHash_1')?.unique, true);
    assert.equal(sessionIndexes.get('expiresAt_1')?.expireAfterSeconds, 0);
    const [sessionsInfo] = await ctx.databases.common().listCollections({ name: 'sessions' }).toArray();
    assert.ok((sessionsInfo as { options?: { validator?: unknown } }).options?.validator !== undefined);
  });

  it('refuses a registry that breaks the coexistence rules, before touching the database', async () => {
    const legacyUnique: CollectionRegistry = {
      common: { legacyProbe: { ownership: 'legacy-read', indexes: [{ name: 'u', key: { userName: 1 }, unique: true }] } },
      group: {},
    };
    await assert.rejects(ensureIndexes(ctx.databases, legacyUnique), /unique and TTL indexes are forbidden/);
    const names = (await ctx.databases.common().listCollections({ name: 'legacyProbe' }).toArray()).length;
    assert.equal(names, 0);
  });

  it('refuses indexes declared on group collections', async () => {
    const groupIndex: CollectionRegistry = {
      common: {},
      group: { things: { ownership: 'new', indexes: [{ name: 'x', key: { x: 1 } }] } },
    };
    await assert.rejects(ensureIndexes(ctx.databases, groupIndex), /group\.things: indexes on group databases are not supported yet/);
  });
});

describe('createDatabases (real MongoDB)', () => {
  it('refuses production_common when APP_ENV is development, whatever the prefix', async () => {
    const dev = createDatabases(singleCluster(ctx.client), { prefix: '', appEnv: 'development' });
    assert.equal(dev.common().databaseName, 'development_common');
    // The accessor can only build names of its own environment: there is no way to ask for production_*.
    assert.throws(() => dev.group('zz' as unknown as ObjectId, TEST_CLUSTER), Error);
    const prod = createDatabases(singleCluster(ctx.client), { prefix: '', appEnv: 'production' });
    assert.equal(prod.common().databaseName, 'production_common');
    assert.throws(() => assertAllowedDatabaseName('production_common', { prefix: '', appEnv: 'development' }), /not allowed/);
  });

  it('keeps groups apart: tenant A does not see tenant B', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    await ctx.databases.group(a, TEST_CLUSTER).collection('items').insertOne({ label: 'A-only' });
    await ctx.databases.group(b, TEST_CLUSTER).collection('items').insertOne({ label: 'B-only' });
    const seenByA = await ctx.databases.group(a, TEST_CLUSTER).collection('items').find().toArray();
    const seenByB = await ctx.databases.group(b, TEST_CLUSTER).collection('items').find().toArray();
    assert.deepEqual(seenByA.map((doc) => doc['label']), ['A-only']);
    assert.deepEqual(seenByB.map((doc) => doc['label']), ['B-only']);
    assert.notEqual(ctx.databases.group(a, TEST_CLUSTER).databaseName, ctx.databases.group(b, TEST_CLUSTER).databaseName);
  });

  it('runs a transaction across the common and a group database (replica set)', async () => {
    const groupId = new ObjectId();
    const common = ctx.databases.common().collection('tx_common');
    const group = ctx.databases.group(groupId, TEST_CLUSTER).collection('tx_group');
    // Collections must exist before a multi-database transaction touches them.
    await common.insertOne({ seed: true });
    await group.insertOne({ seed: true });

    await ctx.client.withSession((session) =>
      session.withTransaction(async () => {
        await common.insertOne({ sale: 1 }, { session });
        await group.insertOne({ sale: 1 }, { session });
      }),
    );
    assert.equal(await common.countDocuments({ sale: 1 }), 1);
    assert.equal(await group.countDocuments({ sale: 1 }), 1);

    await assert.rejects(
      ctx.client.withSession((session) =>
        session.withTransaction(async () => {
          await common.insertOne({ sale: 2 }, { session });
          await group.insertOne({ sale: 2 }, { session });
          throw new Error('abort');
        }),
      ),
      /abort/,
    );
    assert.equal(await common.countDocuments({ sale: 2 }), 0);
    assert.equal(await group.countDocuments({ sale: 2 }), 0);
  });
});

describe('readiness ping (real MongoDB)', () => {
  it('is 200 when the database answers', async () => {
    const app = await startApp({ readiness: { isShuttingDown: () => false, checks: [createPingCheck(ctx.databases)] } });
    try {
      assert.equal((await fetch(`${app.baseUrl}/health/ready`)).status, 200);
    } finally {
      await app.close();
    }
  });

  it('is 503 when the database is unreachable, without leaking details', async () => {
    const dead = new MongoClient(`mongodb://127.0.0.1:${await freePort()}/?directConnection=true`, {
      serverSelectionTimeoutMS: 1000,
    });
    const app = await startApp({
      readiness: {
        isShuttingDown: () => false,
        checks: [createPingCheck(createDatabases(singleCluster(dead), { prefix: ctx.prefix, appEnv: 'development' }))],
      },
    });
    try {
      const res = await fetch(`${app.baseUrl}/health/ready`);
      assert.equal(res.status, 503);
      assert.ok(!JSON.stringify(await res.json()).includes('127.0.0.1'));
    } finally {
      await app.close();
      await dead.close();
    }
  });

  it('is 503 after the client is closed and the server is gone', async () => {
    const client = createMongoClient({
      mongodbUri: new Secret(`mongodb://127.0.0.1:${await freePort()}/?directConnection=true`),
      mongodbServerSelectionTimeoutMs: 1000,
      mongodbMaxPoolSize: 1,
    });
    await client.close();
    await assert.rejects(createPingCheck(createDatabases(singleCluster(client), { prefix: ctx.prefix, appEnv: 'development' }))());
  });
});

describe('database listing (real MongoDB)', () => {
  it('lists only the group databases of this prefix and environment, sorted', async () => {
    const own = [new ObjectId('0000000000000000000000bb'), new ObjectId('0000000000000000000000aa')];
    for (const id of own) {
      await ctx.databases.group(id, TEST_CLUSTER).collection('companies').insertOne({ name: 'probe' });
    }
    const other = createDatabases(singleCluster(ctx.client), { prefix: ctx.prefix, appEnv: 'production' });
    await other.group(new ObjectId('0000000000000000000000cc'), TEST_CLUSTER).collection('companies').insertOne({ name: 'probe' });
    const listed = (await ctx.databases.listGroupIds(TEST_CLUSTER)).map((id) => id.toHexString());
    assert.ok(listed.includes('0000000000000000000000aa') && listed.includes('0000000000000000000000bb'));
    assert.ok(!listed.includes('0000000000000000000000cc'));
    assert.deepEqual(listed, [...listed].sort());
  });

  it('counts the other databases without exposing names', async () => {
    const head = `${ctx.prefix}development_`;
    await ctx.client.db(`${head}queue`).collection('jobs').insertOne({ n: 1 });
    await ctx.client.db(`${head}flite_common`).collection('x').insertOne({ n: 1 });
    await ctx.databases.common().collection('probes').insertOne({ n: 1 });
    const counts = await ctx.databases.countOtherDatabases(TEST_CLUSTER);
    assert.deepEqual(Object.keys(counts).sort(), ['flite_common', 'other', 'queue']);
    assert.equal(counts.queue, 1);
    assert.equal(counts.flite_common, 1);
    assert.ok(counts.other >= 1);
  });

  it('reports the server version', async () => {
    assert.match(await ctx.databases.serverVersion(TEST_CLUSTER), /^\d+\.\d+\.\d+/);
  });
});
