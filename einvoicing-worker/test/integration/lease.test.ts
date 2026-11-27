import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Collection } from 'mongodb';
import { createLease, LEASE_COLLECTION, LEASE_ID } from '../../src/lease.ts';
import type { LeaseDocument } from '../../src/lease.ts';
import { connectAndPing } from '../../src/db/client.ts';
import { openTestDatabase } from '../helpers/mongo.ts';
import type { TestDatabase } from '../helpers/mongo.ts';

const TTL = 30_000;
const T0 = Date.UTC(2026, 0, 1);

describe('lease on MongoDB', () => {
  let testDb: TestDatabase;
  let collection: Collection<LeaseDocument>;

  before(async () => {
    testDb = await openTestDatabase();
    await connectAndPing(testDb.client);
    collection = testDb.db.collection<LeaseDocument>(LEASE_COLLECTION);
  });
  after(() => testDb.drop());
  beforeEach(async () => {
    await collection.deleteMany({});
  });

  const lease = (instanceId: string) => createLease({ collection, instanceId, ttlMs: TTL });

  it('creates the only document with epoch 1 and the TTL', async () => {
    assert.equal(await lease('a').tryAcquire(T0), 1);
    const doc = await collection.findOne({ _id: LEASE_ID });
    assert.deepEqual(doc, { _id: LEASE_ID, holder: 'a', epoch: 1, acquiredAt: new Date(T0), renewedAt: new Date(T0), expiresAt: new Date(T0 + TTL) });
    assert.equal(await collection.countDocuments(), 1);
  });

  it('refuses a second instance while the lease is live and lets exactly one of many win', async () => {
    const a = lease('a');
    assert.equal(await a.tryAcquire(T0), 1);
    assert.equal(await lease('b').tryAcquire(T0 + TTL - 1), null);
    assert.equal((await collection.findOne({ _id: LEASE_ID }))?.holder, 'a');

    await collection.deleteMany({});
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => lease(`c${i}`).tryAcquire(T0)));
    assert.equal(results.filter((r) => r !== null).length, 1);
    assert.equal(await collection.countDocuments(), 1);
  });

  it('keeps the epoch when the holder takes a live lease again and increments it after expiry', async () => {
    assert.equal(await lease('a').tryAcquire(T0), 1);
    assert.equal(await lease('a').tryAcquire(T0 + 1000), 1, 'restart under the same name inside the TTL');
    assert.equal((await collection.findOne({ _id: LEASE_ID }))?.acquiredAt.getTime(), T0);
    assert.equal(await lease('a').tryAcquire(T0 + TTL + 1000), 2, 'after expiry the epoch moves on');
  });

  it('lets another instance take over after expiry with epoch + 1 and fences the old holder', async () => {
    const a = lease('a');
    const b = lease('b');
    assert.equal(await a.tryAcquire(T0), 1);
    assert.equal(await b.tryAcquire(T0 + TTL), 2, 'expiresAt equal to now counts as expired');
    assert.equal(await a.renew(T0 + TTL + 1), false, 'the old holder lost it');
    assert.equal(await a.renew(T0 + TTL + 2), false, 'and stays out until it acquires again');
    assert.equal(await a.release(T0 + TTL + 3), false);
    assert.equal(await b.renew(T0 + TTL + 4), true);
    const doc = await collection.findOne({ _id: LEASE_ID });
    assert.equal(doc?.holder, 'b');
    assert.equal(doc?.epoch, 2);
    assert.equal(doc?.expiresAt.getTime(), T0 + TTL + 4 + TTL);
  });

  it('extends the lease on renew and refuses renew before acquiring', async () => {
    const a = lease('a');
    assert.equal(await a.renew(T0), false);
    await a.tryAcquire(T0);
    assert.equal(await a.renew(T0 + 10_000), true);
    const doc = await collection.findOne({ _id: LEASE_ID });
    assert.equal(doc?.renewedAt.getTime(), T0 + 10_000);
    assert.equal(doc?.expiresAt.getTime(), T0 + 10_000 + TTL);
    assert.equal(doc?.epoch, 1);
  });

  it('releases on shutdown so another instance can take over at once, once only', async () => {
    const a = lease('a');
    const b = lease('b');
    await a.tryAcquire(T0);
    assert.equal(await b.tryAcquire(T0 + 1000), null);
    assert.equal(await a.release(T0 + 2000), true);
    assert.equal(await a.release(T0 + 2000), false, 'already released');
    assert.equal(await b.tryAcquire(T0 + 2000), 2);
  });

  it('does not release a lease it no longer holds', async () => {
    const a = lease('a');
    await a.tryAcquire(T0);
    await collection.updateOne({ _id: LEASE_ID }, { $set: { holder: 'b', epoch: 2 } });
    assert.equal(await a.release(T0 + 1000), false);
    assert.equal((await collection.findOne({ _id: LEASE_ID }))?.expiresAt.getTime(), T0 + TTL);
  });

  it('propagates errors other than a duplicate key', async () => {
    const broken = {
      findOneAndUpdate: async () => {
        throw Object.assign(new Error('network'), { code: 6 });
      },
    } as unknown as Collection<LeaseDocument>;
    await assert.rejects(createLease({ collection: broken, instanceId: 'a', ttlMs: TTL }).tryAcquire(T0), { code: 6 });
    const plain = {
      findOneAndUpdate: async () => {
        throw 'not an error object';
      },
    } as unknown as Collection<LeaseDocument>;
    await assert.rejects(createLease({ collection: plain, instanceId: 'a', ttlMs: TTL }).tryAcquire(T0));
  });

  it('declares no index besides _id and no validator', async () => {
    await collection.insertOne({ _id: LEASE_ID, holder: 'a', epoch: 1, acquiredAt: new Date(T0), renewedAt: new Date(T0), expiresAt: new Date(T0) });
    const indexes = await collection.indexes();
    assert.deepEqual(indexes.map((i) => i.name), ['_id_']);
    const info = await testDb.db.listCollections({ name: LEASE_COLLECTION }, { nameOnly: false }).toArray();
    assert.equal(JSON.stringify((info[0] as { options?: unknown } | undefined)?.options ?? {}).includes('validator'), false);
  });
});
