import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createQueueStore } from '../../src/engine/queue.ts';
import type { QueueStore } from '../../src/engine/queue.ts';
import { FencedError } from '../../src/limits/limiters.ts';
import { createWorld, T0 } from '../helpers/world.ts';
import type { World } from '../helpers/world.ts';

const LEASE = 120_000;
const HOUR_MS = 3_600_000;

describe('queue store (real MongoDB)', () => {
  let world: World;
  let store: QueueStore;
  before(async () => {
    world = await createWorld();
    store = createQueueStore({ collection: world.queue, recordLeaseMs: LEASE });
  });
  after(() => world.drop());
  beforeEach(() => world.reset());

  /** Inserts a record; ids grow with the order of the calls. */
  let counter = 0;
  const insert = async (values: Document = {}): Promise<ObjectId> => {
    const _id = ObjectId.createFromTime(Math.floor(T0 / 1000) - 100_000 + counter++);
    await world.queue.insertOne({ _id, company: { code: 'IT1', fattura_elettronica: { hub: 'h' } }, ...values });
    return _id;
  };
  const read = async (id: ObjectId): Promise<Document> => (await world.queue.findOne({ _id: id })) as Document;
  const date = (offsetMs: number): Date => new Date(T0 + offsetMs);

  describe('indexes', () => {
    it('are created idempotently, with stable names, and the claims use them', async () => {
      await store.ensureIndexes();
      await store.ensureIndexes();
      const indexes = await world.queue.indexes();
      assert.deepEqual(indexes.find((index) => index.name === 'einvoicingWorker_upload')?.key, { 'company.fattura_elettronica.hub': 1, _id: 1 });
      assert.deepEqual(indexes.find((index) => index.name === 'einvoicingWorker_status')?.key, { 'worker.state': 1, 'worker.nextStatusAt': 1 });
      for (let i = 0; i < 400; i += 1) {
        await insert({ company: { code: 'IT1', fattura_elettronica: { hub: i % 4 === 0 ? 'h' : 'other' } }, ...(i % 2 === 0 ? { hubId: 'f.xml', worker: { state: 'uploaded', epoch: 1, nextStatusAt: date(-i) } } : {}) });
      }
      const at = date(0);
      const plan = async (filter: Document, sort: Document): Promise<string> => JSON.stringify(((await world.queue.find(filter).sort(sort).explain('queryPlanner')) as Document)['queryPlanner'].winningPlan);
      const upload = await plan(
        { 'company.fattura_elettronica.hub': 'h', sent: { $exists: false }, hubId: { $exists: false }, error: { $exists: false }, $or: [{ worker: { $exists: false } }, { 'worker.state': { $in: ['claimed'] }, 'worker.leaseUntil': { $lte: at } }] },
        { _id: 1 },
      );
      assert.match(upload, /"stage":"IXSCAN".*"indexName":"einvoicingWorker_upload"/);
      assert.doesNotMatch(upload, /COLLSCAN/);
      const status = await plan({ hubId: { $exists: true }, 'company.fattura_elettronica.hub': { $in: ['h'] }, 'worker.state': 'uploaded', 'worker.epoch': { $lte: 1 }, 'worker.nextStatusAt': { $lte: at } }, { 'worker.nextStatusAt': 1, _id: 1 });
      assert.match(status, /"stage":"IXSCAN"/, 'an index serves the status claim: the planner picks the hub index when the hub is selective');
      assert.doesNotMatch(status, /COLLSCAN/);
      const hinted = JSON.stringify(((await world.queue.find({ 'worker.state': 'uploaded', 'worker.nextStatusAt': { $lte: at } }).sort({ 'worker.nextStatusAt': 1 }).explain('queryPlanner')) as Document)['queryPlanner'].winningPlan);
      assert.match(hinted, /"indexName":"einvoicingWorker_status"/, 'without a hub filter the status index is the one used, with no sort stage');
      assert.doesNotMatch(hinted, /"stage":"SORT"/);
    });
  });

  describe('claimForUpload', () => {
    it('claims the oldest record of the hub and stamps epoch, lease, attempts and the first attempt time', async () => {
      const first = await insert();
      await insert();
      await insert({ company: { code: 'IT2', fattura_elettronica: { hub: 'other' } } });
      const claim = await store.claimForUpload('h', [], 4, T0);
      assert.ok(claim);
      assert.deepEqual(claim.record['_id'], first);
      assert.equal(claim.previousState, undefined);
      assert.equal(claim.record['worker'], undefined, 'the document returned is the one before the claim');
      assert.deepEqual((await read(first))['worker'], { state: 'claimed', epoch: 4, leaseUntil: date(LEASE), attempts: 1, nextAttemptAt: date(0) });
    });

    it('skips records already sent, uploaded, in error, of another hub or of a cooling seller', async () => {
      await insert({ sent: true });
      await insert({ hubId: 'x.xml' });
      await insert({ error: { errorCode: 'X' } });
      await insert({ company: { code: 'IT9', fattura_elettronica: { hub: 'other' } } });
      await insert({ company: { code: 'COOL', fattura_elettronica: { hub: 'h' } } });
      assert.equal(await store.claimForUpload('h', ['COOL', 'ALSO'], 1, T0), null);
      const free = await insert({ company: { code: 'FREE', fattura_elettronica: { hub: 'h' } } });
      assert.deepEqual((await store.claimForUpload('h', ['COOL'], 1, T0))?.record['_id'], free);
    });

    it('lets exactly one of many concurrent claimers win a record', async () => {
      await insert();
      const stores = Array.from({ length: 8 }, () => createQueueStore({ collection: world.queue, recordLeaseMs: LEASE }));
      const claims = await Promise.all(stores.map((each, index) => each.claimForUpload('h', [], index + 1, T0)));
      assert.equal(claims.filter((claim) => claim !== null).length, 1);
      assert.equal((await read((claims.find((claim) => claim !== null) as { record: Document }).record['_id'] as ObjectId))['worker'].attempts, 1);
    });

    it('gives each of many concurrent claimers a different record', async () => {
      const ids = await Promise.all(Array.from({ length: 6 }, () => insert()));
      const claims = await Promise.all(ids.map((_, index) => store.claimForUpload('h', [], 1 + (index % 2), T0)));
      assert.deepEqual(new Set(claims.map((claim) => String(claim?.record['_id']))).size, 6);
    });

    it('does not take a record while its lease is valid, and takes it when the lease and the attempt time have passed', async () => {
      const id = await insert();
      await store.claimForUpload('h', [], 1, T0);
      assert.equal(await store.claimForUpload('h', [], 1, T0 + LEASE - 1), null, 'lease still valid');
      assert.equal((await store.claimForUpload('h', [], 1, T0 + LEASE))?.previousState, 'claimed');
      assert.equal((await read(id))['worker'].attempts, 2);
      await world.queue.updateOne({ _id: id }, { $set: { 'worker.nextAttemptAt': date(10 * LEASE) } });
      assert.equal(await store.claimForUpload('h', [], 1, T0 + 5 * LEASE), null, 'in backoff: the attempt time has not come');
      assert.ok(await store.claimForUpload('h', [], 1, T0 + 10 * LEASE + LEASE));
    });

    it('keeps `uploading` through a claim, so the record is looked up before it is uploaded again', async () => {
      const id = await insert({ worker: { state: 'uploading', epoch: 1, leaseUntil: date(-1), attempts: 1, nextAttemptAt: date(-1) } });
      const claim = await store.claimForUpload('h', [], 2, T0);
      assert.equal(claim?.previousState, 'uploading');
      assert.equal((await read(id))['worker'].state, 'uploading');
      assert.equal((await read(id))['worker'].epoch, 2);
    });

    it('takes a failed record only when its error was removed (a manual retry)', async () => {
      const id = await insert({ error: { errorCode: 'VALIDATION' }, worker: { state: 'failed', epoch: 1, leaseUntil: date(-1), attempts: 1, nextAttemptAt: date(-1) } });
      assert.equal(await store.claimForUpload('h', [], 1, T0), null);
      await world.queue.updateOne({ _id: id }, { $unset: { error: '' } });
      assert.equal((await store.claimForUpload('h', [], 1, T0))?.previousState, 'failed');
      assert.equal((await read(id))['worker'].state, 'claimed');
    });

    it('never takes records that are uploaded, done or in review', async () => {
      for (const state of ['uploaded', 'done', 'review']) {
        await insert({ worker: { state, epoch: 1, leaseUntil: date(-1), attempts: 1, nextAttemptAt: date(-1) } });
      }
      assert.equal(await store.claimForUpload('h', [], 1, T0), null);
    });

    it('fences by epoch: a record stamped by a newer epoch is not taken by an older holder', async () => {
      await insert({ worker: { state: 'claimed', epoch: 7, leaseUntil: date(-1), attempts: 1, nextAttemptAt: date(-1) } });
      assert.equal(await store.claimForUpload('h', [], 6, T0), null);
      assert.ok(await store.claimForUpload('h', [], 7, T0));
    });
  });

  describe('fenced writes', () => {
    it('increments counters in the same fenced update, from zero when the field is absent', async () => {
      const id = await insert();
      await store.claimForUpload('h', [], 1, T0);
      await store.update(id, 1, { 'worker.lastCode': 'a' }, [], { 'worker.maybeSentCycles': 1 });
      await store.update(id, 1, {}, [], { 'worker.maybeSentCycles': 1 });
      const worker = (await read(id))['worker'];
      assert.deepEqual([worker.maybeSentCycles, worker.lastCode], [2, 'a']);
      await assert.rejects(store.update(id, 2, {}, [], { 'worker.maybeSentCycles': 1 }), FencedError);
    });

    it('writes while the epoch matches and raises FencedError after another epoch claimed the record', async () => {
      const id = await insert();
      await store.claimForUpload('h', [], 1, T0);
      await store.markUploading(id, 1, T0 + 1000);
      assert.equal((await read(id))['worker'].state, 'uploading');
      assert.deepEqual((await read(id))['worker'].firstUploadAt, date(1000));
      await store.markUploading(id, 1, T0 + 2000);
      assert.deepEqual((await read(id))['worker'].firstUploadAt, date(1000), 'the first upload time is kept');
      await store.extendLease(id, 1, T0 + 50_000);
      assert.deepEqual((await read(id))['worker'].leaseUntil, date(50_000 + LEASE));
      await store.update(id, 1, { sent: true, 'worker.lastCode': 'x' }, ['worker.nextAttemptAt']);
      const after = await read(id);
      assert.equal(after['sent'], true);
      assert.equal(after['worker'].lastCode, 'x');
      assert.equal('nextAttemptAt' in after['worker'], false);

      await world.queue.updateOne({ _id: id }, { $set: { 'worker.epoch': 2 } });
      await assert.rejects(store.extendLease(id, 1, T0), FencedError);
      await assert.rejects(store.markUploading(id, 1, T0), FencedError);
      await assert.rejects(store.update(id, 1, { sent: false }), FencedError);
      await assert.rejects(store.remove(id, 1), FencedError);
      assert.equal((await read(id))['sent'], true, 'the old holder changed nothing');
      await store.remove(id, 2);
      assert.equal(await world.queue.countDocuments(), 0);
    });

    it('refuses to start an upload once the record lease has run out', async () => {
      const id = await insert();
      await store.claimForUpload('h', [], 1, T0);
      await assert.rejects(store.markUploading(id, 1, T0 + LEASE), /write fenced: queue record/);
      assert.equal((await read(id))['worker'].state, 'claimed');
    });

    it('an update without fields to remove does not send an $unset', async () => {
      const id = await insert();
      await store.claimForUpload('h', [], 1, T0);
      await store.update(id, 1, { note: 'x' });
      assert.equal((await read(id))['note'], 'x');
    });
  });

  describe('markSent', () => {
    it('stores sent and hubId whatever the epoch, once, and the pending history key', async () => {
      const id = await insert();
      await store.claimForUpload('h', [], 1, T0);
      await world.queue.updateOne({ _id: id }, { $set: { 'worker.epoch': 9 } });
      await store.markSent(id, 'first.xml', 'the-key');
      await store.markSent(id, 'second.xml', 'other-key');
      const after = await read(id);
      assert.equal(after['sent'], true);
      assert.equal(after['hubId'], 'first.xml', 'idempotent: the first answer stays');
      assert.equal(after['worker'].historyKey, 'the-key');
      assert.equal(after['worker'].historyPending, true);
      assert.equal(after['worker'].epoch, 9, 'worker.* are left to the fenced writes');
    });

    it('without a history key it marks nothing pending', async () => {
      const id = await insert();
      await store.claimForUpload('h', [], 1, T0);
      await store.markSent(id, 'a.xml', undefined);
      assert.equal((await read(id))['worker'].historyPending, undefined);
    });
  });

  describe('claimForStatus', () => {
    const uploaded = (nextStatusAt: number, extra: Document = {}): Document => ({
      hubId: 'file.xml',
      groupId: new ObjectId(),
      records: [{ big: 'payload' }],
      worker: { state: 'uploaded', epoch: 1, leaseUntil: date(-1), attempts: 1, uploadedAt: date(-3600_000), nextStatusAt: date(nextStatusAt), statusChecks: 2, ...extra },
    });

    it('claims the most overdue record, pushes its due time to the end of the lease and returns only what the job needs', async () => {
      const late = await insert(uploaded(-1000));
      await insert(uploaded(-5000));
      const early = await insert(uploaded(-9000));
      await insert(uploaded(1000));
      const record = await store.claimForStatus(['h'], 3, T0);
      assert.deepEqual(record?.['_id'], early);
      assert.equal(record?.['records'], undefined, 'projection');
      assert.equal(record?.['hubId'], 'file.xml');
      assert.deepEqual(record?.['worker'], { state: 'uploaded', epoch: 3, leaseUntil: date(LEASE), attempts: 1, uploadedAt: date(-3600_000), nextStatusAt: date(LEASE), statusChecks: 2 });
      assert.deepEqual((await store.claimForStatus(['h'], 3, T0))?.['_id'] instanceof ObjectId, true);
      void late;
    });

    it('adopts a record the legacy uploaded: uploadedAt from its id, no checks yet', async () => {
      const id = await insert({ hubId: 'legacy.xml' });
      const record = await store.claimForStatus(['h'], 2, T0);
      assert.deepEqual(record?.['_id'], id);
      const worker = record?.['worker'] as Document;
      assert.equal(worker['state'], 'uploaded');
      assert.equal(worker['statusChecks'], 0);
      assert.equal(worker['attempts'], 0);
      assert.equal(worker['uploadedAt'].getTime(), Math.floor(id.getTimestamp().getTime() / 1000) * 1000);
    });

    it('adopts a legacy record whose id is not an ObjectId with the present time', async () => {
      await world.queue.insertOne({ _id: 'text-id' as never, hubId: 'legacy.xml', company: { fattura_elettronica: { hub: 'h' } } });
      const record = await store.claimForStatus(['h'], 1, T0);
      assert.deepEqual((record?.['worker'] as Document)['uploadedAt'], date(0));
    });

    it('skips what is not due, not uploaded, not of the hubs asked, finished, in review, or owned by a newer epoch', async () => {
      await insert(uploaded(1000));
      await insert({ ...uploaded(-1000), worker: { ...(uploaded(-1000)['worker'] as Document), state: 'done' } });
      await insert({ ...uploaded(-1000), worker: { ...(uploaded(-1000)['worker'] as Document), state: 'review' } });
      await insert({ ...uploaded(-1000), worker: { ...(uploaded(-1000)['worker'] as Document), state: 'claimed', leaseUntil: date(HOUR_MS) } });
      await insert({ ...uploaded(-1000), worker: { ...(uploaded(-1000)['worker'] as Document), epoch: 9 } });
      await insert({ ...uploaded(-1000), company: { code: 'X', fattura_elettronica: { hub: 'elsewhere' } } });
      await insert({ company: { code: 'X', fattura_elettronica: { hub: 'h' } } });
      assert.equal(await store.claimForStatus(['h'], 3, T0), null);
    });

    it('adopts a file whose `uploaded` write was fenced out, once its lease ended, and not before', async () => {
      const id = await insert({ ...uploaded(-1000), worker: { state: 'uploading', epoch: 1, leaseUntil: date(30_000), attempts: 1, nextAttemptAt: date(0) } });
      assert.equal(await store.claimForStatus(['h'], 2, T0), null);
      const record = await store.claimForStatus(['h'], 2, T0 + 30_000);
      assert.deepEqual(record?.['_id'], id);
      assert.equal((record?.['worker'] as Document)['state'], 'uploaded');
      assert.equal((record?.['worker'] as Document)['statusChecks'], 0);
    });

    it('lets exactly one of many concurrent claimers win a record', async () => {
      await insert(uploaded(-1000));
      const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => store.claimForStatus(['h'], index + 1, T0)));
      assert.equal(claims.filter((claim) => claim !== null).length, 1);
    });

    it('takes a record again when its lease expired (a crash during the check)', async () => {
      await insert(uploaded(-1000));
      assert.ok(await store.claimForStatus(['h'], 1, T0));
      assert.equal(await store.claimForStatus(['h'], 1, T0 + LEASE - 1), null);
      assert.ok(await store.claimForStatus(['h'], 1, T0 + LEASE));
    });
  });
});
