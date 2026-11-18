import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { MongoClient } from 'mongodb';
import { createDatabases, UnknownClusterError } from '../../src/db/databases.ts';
import { createGroupDatabasePurger } from '../../src/db/group-database-purger.ts';
import type { GroupDatabasePurger } from '../../src/db/group-database-purger.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases, singleCluster } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const G = fixtureId('group', 1);
let ctx: TestDatabases;
let purger: GroupDatabasePurger;

beforeEach(async () => {
  ctx = await openTestDatabases();
  purger = createGroupDatabasePurger(ctx.databases, { prefix: ctx.prefix, appEnv: ctx.appEnv });
});

afterEach(async () => {
  await ctx.cleanup();
});

const listing = async (): Promise<string[]> => (await ctx.databases.listGroupIds('cluster0')).map((id) => id.toHexString());

/** A group database with two collections, a view and the documents in them. */
async function seed(): Promise<void> {
  const db = ctx.databases.group(G, 'cluster0');
  await db.collection('products').insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);
  await db.collection('files').insertOne({ n: 1 });
  await db.createCollection('products_view', { viewOn: 'products', pipeline: [] });
}

/** Databases over the same MongoDB whose client replaces `dropCollection` of the group databases. */
function withDrop(replace: (original: (name: string) => Promise<boolean>, name: string) => Promise<boolean>): GroupDatabasePurger {
  const client: MongoClient = ctx.client;
  const open = client.db.bind(client);
  const wrapped = Object.create(client) as MongoClient;
  wrapped.db = ((name?: string) => {
    const db = open(name);
    const drop = db.dropCollection.bind(db);
    db.dropCollection = ((collection: string) => replace(drop, collection)) as typeof db.dropCollection;
    return db;
  }) as typeof client.db;
  const context = { prefix: ctx.prefix, appEnv: ctx.appEnv } as const;
  return createGroupDatabasePurger(createDatabases(singleCluster(wrapped), context), context);
}

describe('GroupDatabasePurger', () => {
  it('counts the collections, views included, and the documents of a group database; a missing database is empty', async () => {
    assert.deepEqual(await purger.describe(G, 'cluster0'), { collections: 0, documents: 0, newestActivity: null });
    await seed();
    assert.deepEqual(await purger.describe(G, 'cluster0'), { collections: 3, documents: 4, newestActivity: null });
  });

  it('reports the newest creation time of the ids of sales and documents, ignoring ids that are not ObjectIds and other collections', async () => {
    const db = ctx.databases.group(G, 'cluster0');
    const at = (iso: string): ObjectId => ObjectId.createFromTime(Date.parse(iso) / 1000);
    await db.collection('sales').insertMany([{ _id: at('2025-03-01T00:00:00Z') }, { _id: at('2025-05-01T00:00:00Z') }, { _id: at('2025-04-01T00:00:00Z') }]);
    await db.collection('documents').insertOne({ _id: at('2025-02-01T00:00:00Z') });
    await db.collection('products').insertOne({ _id: at('2026-01-01T00:00:00Z') });
    assert.equal((await purger.describe(G, 'cluster0')).newestActivity?.toISOString(), '2025-05-01T00:00:00.000Z');
    await db.collection('documents').insertOne({ _id: at('2025-06-01T00:00:00Z') });
    assert.equal((await purger.describe(G, 'cluster0')).newestActivity?.toISOString(), '2025-06-01T00:00:00.000Z');
  });

  it('knows no activity when the ids are not ObjectIds or the collections are empty', async () => {
    const db = ctx.databases.group(G, 'cluster0');
    await db.collection('sales').insertOne({ _id: 'legacy-string-id' as unknown as ObjectId });
    await db.createCollection('documents');
    assert.equal((await purger.describe(G, 'cluster0')).newestActivity, null);
  });

  it('drops every collection and view, so the database leaves the listing, and does nothing the second time', async () => {
    await seed();
    assert.deepEqual(await listing(), [G.toHexString()]);
    assert.equal(await purger.drop(G, 'cluster0'), 3);
    assert.deepEqual(await listing(), []);
    assert.equal(await purger.drop(G, 'cluster0'), 0);
  });

  it('drops the system.views that the views leave behind, and no other system collection is ever listed for a drop', async () => {
    await seed();
    const db = ctx.databases.group(G, 'cluster0');
    assert.equal((await db.listCollections({ name: 'system.views' }, { nameOnly: true }).toArray()).length, 1);
    assert.deepEqual(await purger.describe(G, 'cluster0'), { collections: 3, documents: 4, newestActivity: null }, 'system.views is not counted');
    await purger.drop(G, 'cluster0');
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), []);
  });

  it('does not touch another group, the common database or a database of another environment', async () => {
    await seed();
    const other = ctx.databases.group(fixtureId('group', 2), 'cluster0');
    await other.collection('products').insertOne({ n: 1 });
    await ctx.databases.common().collection('probe').insertOne({ n: 1 });
    const foreign = ctx.client.db(`${ctx.prefix}production_${G.toHexString()}`);
    await foreign.collection('products').insertOne({ n: 1 });
    await purger.drop(G, 'cluster0');
    assert.equal(await other.collection('products').countDocuments(), 1);
    assert.equal(await ctx.databases.common().collection('probe').countDocuments(), 1);
    assert.equal(await foreign.collection('products').countDocuments(), 1);
  });

  it('accepts a collection that is dropped between the listing and its turn, and rethrows every other error', async () => {
    await seed();
    const raced = withDrop(async (original, name) => {
      await original(name);
      return original(name);
    });
    assert.equal(await raced.drop(G, 'cluster0'), 3);
    assert.deepEqual(await listing(), []);
    await seed();
    const refused = withDrop(async () => {
      throw new Error('refused');
    });
    await assert.rejects(refused.drop(G, 'cluster0'), /refused/);
    assert.deepEqual(await listing(), [G.toHexString()]);
  });

  it('fails for a cluster that is not configured', async () => {
    await assert.rejects(purger.describe(G, 'nowhere'), UnknownClusterError);
    await assert.rejects(purger.drop(G, 'nowhere'), UnknownClusterError);
  });

  it('refuses a group id that is not an ObjectId before touching anything', async () => {
    await seed();
    await assert.rejects(purger.drop('not-an-id' as unknown as ObjectId, 'cluster0'), /Invalid group id/);
    assert.deepEqual(await listing(), [G.toHexString()]);
  });
});
