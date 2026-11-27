import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGroupStore } from '../../src/engine/groups.ts';
import { createSentHistory } from '../../src/engine/history.ts';
import { createWorld, T0 } from '../helpers/world.ts';
import type { World } from '../helpers/world.ts';

describe('sent history (real MongoDB)', () => {
  let world: World;
  before(async () => {
    world = await createWorld();
  });
  after(() => world.drop());
  beforeEach(() => world.reset());

  const entry = (key: string, queueId: ObjectId) => ({ key, queueId, hub: 'h', providerId: 'f.xml', sentAt: new Date(T0) });

  it('creates a partial unique index idempotently', async () => {
    const history = createSentHistory(world.sent);
    await history.ensureIndexes();
    await history.ensureIndexes();
    const index = (await world.sent.indexes()).find((each) => each.name === 'key_1_unreleased');
    assert.equal(index?.unique, true);
    assert.deepEqual(index?.partialFilterExpression, { released: false });
  });

  it('answers a duplicate for another record with the same key, never for the record itself', async () => {
    const history = createSentHistory(world.sent);
    await history.ensureIndexes();
    const first = new ObjectId();
    const second = new ObjectId();
    await history.recordAccepted(entry('k', first));
    assert.equal(await history.lookupFor(second)('k'), 'duplicate');
    assert.equal(await history.lookupFor(first)('k'), 'unique', 'a recovered upload is not its own duplicate');
    assert.equal(await history.lookupFor(second)('other'), 'unique');
  });

  it('records an accepted invoice once per record and refuses a second record with the same live key', async () => {
    const history = createSentHistory(world.sent);
    await history.ensureIndexes();
    const first = new ObjectId();
    await history.recordAccepted(entry('k', first));
    await history.recordAccepted(entry('k', first));
    assert.equal(await world.sent.countDocuments(), 1);
    assert.deepEqual(await world.sent.findOne({}, { projection: { _id: 0 } }), { key: 'k', queueId: first, hub: 'h', providerId: 'f.xml', sentAt: new Date(T0), released: false });
    await assert.rejects(history.recordAccepted(entry('k', new ObjectId())), { code: 11000 });
  });

  it('frees the key when released, so the number can be sent again', async () => {
    const history = createSentHistory(world.sent);
    await history.ensureIndexes();
    const first = new ObjectId();
    await history.recordAccepted(entry('k', first));
    await history.release(first, T0 + 5000);
    assert.equal(await history.lookupFor(new ObjectId())('k'), 'unique');
    assert.deepEqual((await world.sent.findOne({ queueId: first }))?.releasedAt, new Date(T0 + 5000));
    await history.recordAccepted(entry('k', new ObjectId()));
    assert.equal(await world.sent.countDocuments(), 2);
    await history.release(new ObjectId(), T0);
    assert.equal(await world.sent.countDocuments({ released: false }), 1, 'releasing an unknown record changes nothing');
  });
});

describe('group store (real MongoDB)', () => {
  let world: World;
  before(async () => {
    world = await createWorld();
  });
  after(() => world.drop());

  it('writes sendStatus only, on an existing document of the right group', async () => {
    const store = createGroupStore(world.client, world.names);
    const groupId = new ObjectId();
    const otherGroup = new ObjectId();
    const id = new ObjectId();
    await world.group(groupId).insertOne({ _id: id, number: 5, sendStatus: 'old' });
    await world.group(otherGroup).insertOne({ _id: id, sendStatus: 'untouched' });
    assert.equal(await store.setSendStatus(groupId, id, 'accepted'), true);
    assert.deepEqual(await world.group(groupId).findOne({ _id: id }), { _id: id, number: 5, sendStatus: 'accepted' });
    assert.equal((await world.group(otherGroup).findOne({ _id: id }))?.['sendStatus'], 'untouched');
    assert.equal(await store.setSendStatus(groupId, new ObjectId(), 'accepted'), false, 'never creates a document');
    assert.equal(await world.group(groupId).countDocuments(), 1);
  });

  it('refuses a group id that is not an ObjectId (it would choose the database)', async () => {
    const store = createGroupStore(world.client, world.names);
    for (const bad of ['0123456789ABCDEF01234567', '0123456789abcdef0123456', undefined, null, 42, '../common', { $ne: 1 }]) {
      assert.equal(await store.setSendStatus(bad, new ObjectId(), 'x'), false);
      assert.equal(await store.readOriginal(bad, new ObjectId()), null);
    }
  });

  it('accepts the group id and the document id as 24 lowercase hexadecimal characters too', async () => {
    const store = createGroupStore(world.client, world.names);
    const groupId = new ObjectId();
    const id = new ObjectId();
    await world.group(groupId).insertOne({ _id: id, number: 3, sendStatus: 'old' });
    assert.equal(await store.setSendStatus(groupId.toHexString(), id, 'sent'), true);
    assert.equal((await world.group(groupId).findOne({ _id: id }))?.['sendStatus'], 'sent');
    assert.equal((await store.readOriginal(groupId.toHexString(), id.toHexString()))?.['number'], 3);
  });

  it('reads the original of a credit note: number, section and date only', async () => {
    const store = createGroupStore(world.client, world.names);
    const groupId = new ObjectId();
    const id = new ObjectId();
    await world.group(groupId).insertOne({ _id: id, number: 12, prefixSuffix: 'A/', date: new Date(T0), counterpart: { name: 'private' }, records: [1, 2] });
    assert.deepEqual(await store.readOriginal(groupId, id), { _id: id, number: 12, prefixSuffix: 'A/', date: new Date(T0) });
    assert.equal(await store.readOriginal(groupId, new ObjectId()), null);
    assert.equal(await store.readOriginal(groupId, 'not-an-object-id'), null);
    assert.equal(await store.readOriginal(groupId, undefined), null);
  });
});
