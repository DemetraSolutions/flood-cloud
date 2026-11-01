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
import { openTestDatabases } from '../helpers/mongo.ts';
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

  it('does nothing with the real registry (no indexes declared yet)', async () => {
    await ensureIndexes(ctx.databases);
  });

  it('refuses a registry that breaks the coexistence rules, before touching the database', async () => {
    const legacyUnique: CollectionRegistry = {
      common: { users: { ownership: 'legacy-read', indexes: [{ name: 'u', key: { userName: 1 }, unique: true }] } },
      group: {},
    };
    await assert.rejects(ensureIndexes(ctx.databases, legacyUnique), /unique and TTL indexes are forbidden/);
    const names = (await ctx.databases.common().listCollections({ name: 'users' }).toArray()).length;
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
    const dev = createDatabases(ctx.client, { prefix: '', appEnv: 'development' });
    assert.equal(dev.common().databaseName, 'development_common');
    // The accessor can only build names of its own environment: there is no way to ask for production_*.
    assert.throws(() => dev.group('zz' as unknown as ObjectId), Error);
    const prod = createDatabases(ctx.client, { prefix: '', appEnv: 'production' });
    assert.equal(prod.common().databaseName, 'production_common');
    assert.throws(() => assertAllowedDatabaseName('production_common', { prefix: '', appEnv: 'development' }), /not allowed/);
  });

  it('keeps groups apart: tenant A does not see tenant B', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    await ctx.databases.group(a).collection('items').insertOne({ label: 'A-only' });
    await ctx.databases.group(b).collection('items').insertOne({ label: 'B-only' });
    const seenByA = await ctx.databases.group(a).collection('items').find().toArray();
    const seenByB = await ctx.databases.group(b).collection('items').find().toArray();
    assert.deepEqual(seenByA.map((doc) => doc['label']), ['A-only']);
    assert.deepEqual(seenByB.map((doc) => doc['label']), ['B-only']);
    assert.notEqual(ctx.databases.group(a).databaseName, ctx.databases.group(b).databaseName);
  });

  it('runs a transaction across the common and a group database (replica set)', async () => {
    const groupId = new ObjectId();
    const common = ctx.databases.common().collection('tx_common');
    const group = ctx.databases.group(groupId).collection('tx_group');
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
        checks: [createPingCheck(createDatabases(dead, { prefix: ctx.prefix, appEnv: 'development' }))],
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
    await assert.rejects(createPingCheck(createDatabases(client, { prefix: ctx.prefix, appEnv: 'development' }))());
  });
});

describe('database listing (real MongoDB)', () => {
  it('lists only the group databases of this prefix and environment, sorted', async () => {
    const own = [new ObjectId('0000000000000000000000bb'), new ObjectId('0000000000000000000000aa')];
    for (const id of own) {
      await ctx.databases.group(id).collection('companies').insertOne({ name: 'probe' });
    }
    const other = createDatabases(ctx.client, { prefix: ctx.prefix, appEnv: 'production' });
    await other.group(new ObjectId('0000000000000000000000cc')).collection('companies').insertOne({ name: 'probe' });
    const listed = (await ctx.databases.listGroupIds()).map((id) => id.toHexString());
    assert.ok(listed.includes('0000000000000000000000aa') && listed.includes('0000000000000000000000bb'));
    assert.ok(!listed.includes('0000000000000000000000cc'));
    assert.deepEqual(listed, [...listed].sort());
  });

  it('counts the other databases without exposing names', async () => {
    const head = `${ctx.prefix}development_`;
    await ctx.client.db(`${head}queue`).collection('jobs').insertOne({ n: 1 });
    await ctx.client.db(`${head}flite_common`).collection('x').insertOne({ n: 1 });
    await ctx.databases.common().collection('probes').insertOne({ n: 1 });
    const counts = await ctx.databases.countOtherDatabases();
    assert.deepEqual(Object.keys(counts).sort(), ['flite_common', 'other', 'queue']);
    assert.equal(counts.queue, 1);
    assert.equal(counts.flite_common, 1);
    assert.ok(counts.other >= 1);
  });

  it('reports the server version', async () => {
    assert.match(await ctx.databases.serverVersion(), /^\d+\.\d+\.\d+/);
  });
});
