import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { NormalizedStatus, StatusOutcome } from '../../src/providers/types.ts';
import { createClock, createFakeAdapter, createRig, groupStatusOf, queueRecordOf, seedDealerAccount, seedPlatformAccount, seedRecord, T0 } from '../helpers/world.ts';
import type { Rig, RigOptions, World } from '../helpers/world.ts';
import { createWorld } from '../helpers/world.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('engine: status (real MongoDB, fake provider)', () => {
  let world: World;
  before(async () => {
    world = await createWorld();
  });
  after(() => world.drop());
  beforeEach(() => world.reset());

  const setup = async (options: Partial<RigOptions> = {}): Promise<Rig> => {
    await seedPlatformAccount(world, 'fake', { username: 'platform-user', password: 'platform-secret' });
    return createRig(world, { hubs: ['fake'], ...options });
  };

  /** A record the provider has already taken, due for a status check `dueIn` ms from T0. */
  const uploaded = async (hub: string, values: Record<string, unknown> = {}, worker: Document = {}, group = true): Promise<Document> =>
    await seedRecord(
      world,
      hub,
      {
        sent: true,
        hubId: 'file-1.xml',
        worker: { state: 'uploaded', epoch: 1, leaseUntil: new Date(T0 - HOUR), attempts: 1, uploadedAt: new Date(T0 - HOUR), nextStatusAt: new Date(T0 - 1000), statusChecks: 0, ...worker },
        ...values,
      },
      { group },
    );
  const stored = async (record: Document): Promise<Document> => (await queueRecordOf(world, record)) as Document;
  const answer = (rig: Rig, status: NormalizedStatus, sdiErrors?: Array<{ code: string; description: string }>): void => {
    rig.adapter.onStatus = () => ({ kind: 'status', status, ...(sdiErrors === undefined ? {} : { sdiErrors }) });
  };

  describe('a non-final answer', () => {
    it('writes sendStatus on the record and on the group document and schedules the next check', async () => {
      const rig = await setup();
      const record = await uploaded('fake');
      answer(rig, 'takingCharge');
      await rig.round();
      assert.deepEqual(rig.adapter.statuses.map((call) => call.providerId), ['file-1.xml']);
      assert.equal(rig.adapter.statuses[0]?.account.password.reveal(), 'platform-secret');
      const after = await stored(record);
      assert.equal(after['sendStatus'], 'takingCharge');
      assert.equal(await groupStatusOf(world, record), 'takingCharge');
      assert.deepEqual(after['worker'], {
        state: 'uploaded',
        epoch: 1,
        leaseUntil: new Date(T0),
        attempts: 1,
        uploadedAt: new Date(T0 - HOUR),
        nextStatusAt: new Date(T0 + 5 * MINUTE),
        statusChecks: 1,
        lastCode: 'takingCharge',
      });
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 1, 'not due yet');
    });

    it('asks again after 5, 15, 30 minutes, 1, 2, 4, 8 hours, then every 12 hours', async () => {
      const rig = await setup();
      const record = await uploaded('fake');
      answer(rig, 'sent');
      const gaps: number[] = [];
      for (let check = 0; check < 10; check += 1) {
        const before = rig.clock.now();
        await rig.round();
        const worker = (await stored(record))['worker'] as Document;
        const due = (worker['nextStatusAt'] as Date).getTime();
        gaps.push((due - before) / MINUTE);
        rig.clock.set(due);
      }
      assert.deepEqual(gaps, [5, 15, 30, 60, 120, 240, 480, 720, 720, 720]);
    });

    it('does not ask a record that is not yet due, nor one of another state', async () => {
      const rig = await setup();
      await uploaded('fake', {}, { nextStatusAt: new Date(T0 + MINUTE) });
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 0);
    });

    it('a file uploaded by this worker is first asked two minutes after the upload', async () => {
      const rig = await setup();
      await seedRecord(world, 'fake');
      await rig.round();
      rig.clock.advance(2 * MINUTE - 1);
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 0);
      rig.clock.advance(1);
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 1);
    });

    it('stops polling after 30 days from the upload and flags the record for a manual check, keeping it visible', async () => {
      const rig = await setup();
      const record = await uploaded('fake', {}, { uploadedAt: new Date(T0 - 30 * DAY) });
      answer(rig, 'sent');
      await rig.round();
      const after = await stored(record);
      assert.equal((after['worker'] as Document)['state'], 'review');
      assert.equal((after['worker'] as Document)['nextStatusAt'], undefined);
      assert.equal(after['sendStatus'], 'sent');
      assert.ok(rig.log.messages('warn').includes('the invoice needs a manual check: polling stopped'));
      rig.clock.advance(2 * DAY);
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 1, 'no more polling');
      const young = await uploaded('fake', {}, { uploadedAt: new Date(rig.clock.now() - 30 * DAY + 1000), nextStatusAt: new Date(rig.clock.now()) });
      rig.clock.advance(1);
      await rig.round();
      assert.equal(((await stored(young))['worker'] as Document)['state'], 'uploaded', 'not yet 30 days');
    });
  });

  describe('final answers', () => {
    const finals: Array<[NormalizedStatus, 'FPR12' | 'FPA12']> = [
      ['accepted', 'FPR12'],
      ['delivered', 'FPR12'],
      ['notDelivered', 'FPR12'],
      ['effectiveDate', 'FPR12'],
      ['deliveryImpossible', 'FPR12'],
      ['accepted', 'FPA12'],
      ['effectiveDate', 'FPA12'],
      ['deliveryImpossible', 'FPA12'],
    ];
    for (const [status, format] of finals) {
      it(`${status} is final for ${format}: the record is deleted and the group keeps the status`, async () => {
        const rig = await setup();
        const record = await uploaded('fake', { 'counterpart.fattura_elettronica.formato_trasmissione': format });
        answer(rig, status);
        await rig.round();
        assert.equal(await queueRecordOf(world, record), null);
        assert.equal(await groupStatusOf(world, record), status);
      });
    }

    it('delivered and notDelivered are not final for the public administration (FPA12): the record stays and is asked again', async () => {
      const rig = await setup();
      const record = await uploaded('fake', { 'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12' });
      for (const status of ['delivered', 'notDelivered'] as const) {
        answer(rig, status);
        rig.clock.advance(HOUR);
        await world.queue.updateOne({ _id: record['_id'] }, { $set: { 'worker.nextStatusAt': new Date(rig.clock.now() - 1) } });
        await rig.round();
        assert.equal((await stored(record))['sendStatus'], status);
        assert.equal(await groupStatusOf(world, record), status);
      }
      answer(rig, 'accepted');
      rig.clock.advance(HOUR);
      await world.queue.updateOne({ _id: record['_id'] }, { $set: { 'worker.nextStatusAt': new Date(rig.clock.now() - 1) } });
      await rig.round();
      assert.equal(await queueRecordOf(world, record), null);
    });

    it('a simplified invoice (TD07-TD09) is judged as a private one even when the counterpart says FPA12', async () => {
      const rig = await setup();
      const record = await uploaded('fake', { 'fattura_elettronica.tipo': 'TD07', 'counterpart.fattura_elettronica.formato_trasmissione': 'FPA12' });
      answer(rig, 'delivered');
      await rig.round();
      assert.equal(await queueRecordOf(world, record), null);
    });

    const kept: Array<[NormalizedStatus, string, string]> = [
      ['rejected', 'SDI_REJECTED', 'Fattura scartata dal SdI'],
      ['processingError', 'PROCESSING_ERROR', 'Errore di elaborazione della fattura presso il provider'],
      ['refused', 'REFUSED', 'Fattura rifiutata dal committente'],
    ];
    for (const [status, code, text] of kept) {
      it(`${status} keeps the record with ${code}, releases the number and stops polling`, async () => {
        const rig = await setup();
        const record = await uploaded('fake');
        await world.sent.insertOne({ key: 'k', queueId: record['_id'] as ObjectId, hub: 'fake', providerId: 'file-1.xml', sentAt: new Date(T0), released: false });
        answer(rig, status);
        await rig.round();
        const after = await stored(record);
        assert.deepEqual(after['error'], { errorCode: code, errorDescription: text });
        assert.equal(after['sendStatus'], status);
        assert.equal((after['worker'] as Document)['state'], 'done');
        assert.equal((after['worker'] as Document)['nextStatusAt'], undefined);
        assert.equal((after['worker'] as Document)['sdiErrors'], undefined);
        assert.equal(await groupStatusOf(world, record), status);
        assert.equal((await world.sent.findOne({ key: 'k' }))?.released, true);
        rig.clock.advance(DAY);
        await rig.round();
        assert.equal(rig.adapter.statuses.length, 1);
      });
    }

    it('stores the SdI errors of a rejection (bounded) and shows the first in the description', async () => {
      const rig = await setup();
      const record = await uploaded('fake');
      const errors = Array.from({ length: 30 }, (_, index) => ({ code: `0040${index}`.padEnd(80, 'x'), description: `Motivo ${index} ${'y'.repeat(400)}` }));
      answer(rig, 'rejected', errors);
      await rig.round();
      const after = await stored(record);
      const worker = after['worker'] as Document;
      assert.equal(worker['sdiErrors'].length, 20);
      assert.equal(worker['sdiErrors'][0].code.length, 50);
      assert.equal(worker['sdiErrors'][0].description.length, 300);
      assert.match((after['error'] as Document)['errorDescription'], /^Fattura scartata dal SdI: 0040/);
      assert.ok((after['error'] as Document)['errorDescription'].length <= 500);
    });
  });

  describe('records the provider does not know', () => {
    it('is asked again on the normal schedule, then flagged after three answers', async () => {
      const rig = await setup();
      const record = await uploaded('fake');
      rig.adapter.onStatus = () => ({ kind: 'notFound' });
      for (const expected of [1, 2]) {
        await rig.round();
        const worker = (await stored(record))['worker'] as Document;
        assert.equal(worker['state'], 'uploaded');
        assert.equal(worker['notFoundChecks'], expected);
        assert.equal(worker['statusChecks'], expected);
        rig.clock.set((worker['nextStatusAt'] as Date).getTime());
      }
      await rig.round();
      const worker = (await stored(record))['worker'] as Document;
      assert.equal(worker['state'], 'review');
      assert.equal(worker['notFoundChecks'], 3);
      assert.equal(worker['nextStatusAt'], undefined);
      assert.equal((await stored(record))['sendStatus'], undefined, 'nothing to write: the provider said nothing');
    });
  });

  describe('records uploaded by the legacy', () => {
    it('are adopted: asked at once, with the upload time taken from the record id', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake', { sent: true, hubId: 'legacy.xml' });
      answer(rig, 'sent');
      await rig.round();
      const worker = (await stored(record))['worker'] as Document;
      assert.equal(worker['state'], 'uploaded');
      assert.equal(worker['epoch'], 1);
      assert.equal(worker['statusChecks'], 1);
      assert.deepEqual(worker['nextStatusAt'], new Date(T0 + 5 * MINUTE));
      assert.equal((worker['uploadedAt'] as Date).getTime(), Math.floor((record['_id'] as ObjectId).getTimestamp().getTime() / 1000) * 1000);
      assert.equal((await stored(record))['sendStatus'], 'sent');
    });

    it('an adopted record older than 30 days is flagged after its first answer', async () => {
      const rig = await setup();
      const old = ObjectId.createFromTime(Math.floor((T0 - 40 * DAY) / 1000));
      await world.queue.insertOne({ _id: old, hubId: 'legacy.xml', sent: true, company: { code: 'x', fattura_elettronica: { hub: 'fake' } }, groupId: new ObjectId() });
      answer(rig, 'sent');
      await rig.round();
      assert.equal(((await world.queue.findOne({ _id: old })) as Document)['worker'].state, 'review');
    });
  });

  describe('the provider asks to wait', () => {
    it('for the IP: every account of the provider waits', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const rig = createRig(world, { hubs: ['fake', dealer] });
      const first = await uploaded(dealer);
      const second = await uploaded('fake', {}, { nextStatusAt: new Date(T0 - 500) });
      rig.adapter.onStatus = () => ({ kind: 'retry', scope: 'ip', afterMs: 10 * MINUTE, code: '429' });
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 1);
      const worker = (await stored(first))['worker'] as Document;
      assert.deepEqual(worker['nextStatusAt'], new Date(T0 + 10 * MINUTE));
      assert.equal(worker['lastCode'], '429');
      assert.equal(worker['statusChecks'], 0, 'not an answer');
      assert.equal(((await stored(second))['worker'] as Document)['leaseUntil'] instanceof Date, true);
      assert.equal((await world.limits.findOne({ _id: 'ip:fake:status' }))?.until.getTime(), T0 + 10 * MINUTE);
      assert.ok(rig.log.messages('warn').includes('the provider asked to wait before the next status request'));
    });

    it('for the account: the other accounts go on', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const rig = createRig(world, { hubs: ['fake', dealer] });
      const blocked = await uploaded(dealer, {}, { nextStatusAt: new Date(T0 - 2000) });
      const other = await uploaded('fake', {}, { nextStatusAt: new Date(T0 - 1000) });
      const another = await uploaded(dealer, { hubId: 'file-3.xml' }, { nextStatusAt: new Date(T0 - 500) });
      rig.adapter.onStatus = (account) => (account.hub === dealer ? { kind: 'retry', scope: 'account', afterMs: 5 * MINUTE, code: 'LIMIT' } : { kind: 'status', status: 'sent' });
      await rig.round();
      assert.deepEqual(rig.adapter.statuses.map((call) => call.account.hub), [dealer, 'fake']);
      assert.deepEqual(((await stored(blocked))['worker'] as Document)['nextStatusAt'], new Date(T0 + 5 * MINUTE));
      assert.equal((await stored(other))['sendStatus'], 'sent');
      assert.equal((await stored(another))['sendStatus'], undefined, 'the blocked account is not asked again this round');
    });
  });

  describe('several providers and a blocked account', () => {
    it('does not claim anything for a provider whose accounts are all waiting', async () => {
      const rig = await setup();
      const record = await uploaded('fake');
      rig.adapter.onStatus = () => ({ kind: 'retry', scope: 'account', afterMs: 5 * MINUTE, code: 'LIMIT' });
      await rig.round();
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 1);
      assert.deepEqual(((await stored(record))['worker'] as Document)['nextStatusAt'], new Date(T0 + 5 * MINUTE));
    });

    it('serves each provider with its own adapter and stops when the round budget is spent', async () => {
      await seedPlatformAccount(world, 'fake', { username: 'fake-user' });
      await seedPlatformAccount(world, 'other', { username: 'other-user' });
      const fake = createFakeAdapter('fake');
      const other = createFakeAdapter('other');
      const clock = createClock();
      const rig = createRig(world, { hubs: ['fake', 'other'], adapters: new Map([['fake', fake], ['other', other]]), clock, budgetMs: 5_000 });
      await uploaded('fake');
      await uploaded('other');
      other.onStatus = () => {
        clock.advance(10_000);
        return { kind: 'status', status: 'sent' };
      };
      await rig.round();
      assert.deepEqual([fake.statuses.length, other.statuses.length], [0, 1], 'the first provider used the whole budget');
      clock.advance(10_000);
      await rig.round();
      assert.equal(fake.statuses.length + other.statuses.length, 2);
    });
  });

  describe('spacing and budget', () => {
    it('waits the IP spacing between two requests inside the round', async () => {
      const rig = await setup();
      await uploaded('fake');
      await uploaded('fake', { hubId: 'file-2.xml' });
      answer(rig, 'sent');
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 2);
      assert.deepEqual(rig.clock.waits, [6000]);
    });

    it('leaves what does not fit the round budget for the next round', async () => {
      const rig = await setup({ budgetMs: 5_000 });
      await uploaded('fake');
      const later = await uploaded('fake', { hubId: 'file-2.xml' }, { nextStatusAt: new Date(T0 - 500) });
      answer(rig, 'sent');
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 1);
      assert.deepEqual(((await stored(later))['worker'] as Document)['leaseUntil'], new Date(T0 - HOUR), 'not even claimed');
    });

    it('a claimed record whose wait was interrupted is handed back for the next round', async () => {
      const clock = createClock();
      const controller = new AbortController();
      const original = clock.sleep;
      clock.sleep = async (ms, signal) => {
        controller.abort();
        await original(ms, signal);
      };
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const rig = createRig(world, { hubs: ['fake'], clock });
      const record = await uploaded('fake');
      await world.limits.insertOne({ _id: 'ip:fake:status', epoch: 1, nextAt: new Date(T0 + 3_000), until: new Date(0), step: 0, recent: [], year: 0, yearCount: 0 });
      await rig.round(1, controller.signal);
      assert.equal(rig.adapter.statuses.length, 0);
      const worker = (await stored(record))['worker'] as Document;
      assert.equal(worker['statusChecks'], 0);
      assert.deepEqual(worker['nextStatusAt'], new Date(T0));
    });
  });

  describe('records that must be left alone', () => {
    it('never claims a record of a hub outside the allowlist, with an unusable account or without an adapter', async () => {
      const off = await seedDealerAccount(world, 'fake', { enabled: false, username: 'off' });
      const outside = await seedDealerAccount(world, 'fake', { username: 'outside' });
      await seedPlatformAccount(world, 'fake', { username: 'platform' });
      const rig = createRig(world, { hubs: [off, 'fake'], adapters: new Map() });
      const records = [await uploaded(off), await uploaded(outside), await uploaded('fake'), await uploaded('unrelated')];
      await rig.round();
      for (const record of records) {
        assert.equal(((await stored(record))['worker'] as Document)['leaseUntil'].getTime(), T0 - HOUR);
      }
    });

    it('re-reads the account right before the request: a disabled one is not used', async () => {
      const rig = await setup();
      await rig.round();
      const record = await uploaded('fake');
      await world.settings.updateOne({ key: 'INTEGRATIONS' }, { $set: { 'value.fake.enabled': false } });
      await rig.round();
      assert.equal(rig.adapter.statuses.length, 0);
      assert.deepEqual(((await stored(record))['worker'] as Document)['nextStatusAt'], new Date(T0 + MINUTE));
    });
  });

  describe('errors and group documents', () => {
    it('an unexpected error never loses the record: it is asked again in a minute', async () => {
      const rig = await setup();
      const record = await uploaded('fake');
      rig.adapter.onStatus = () => {
        throw new Error('connection reset');
      };
      await rig.round();
      assert.deepEqual(((await stored(record))['worker'] as Document)['nextStatusAt'], new Date(T0 + MINUTE));
      assert.ok(rig.log.messages('error').includes('status check failed: it will be tried again'));
      assert.doesNotMatch(rig.log.lines.join('\n'), /platform-secret/);
    });

    it('writes the queue record even when the group document is missing or the group id is not an ObjectId', async () => {
      const rig = await setup();
      const noDoc = await uploaded('fake', {}, {}, false);
      const badGroup = await uploaded('fake', { hubId: 'file-2.xml' }, {}, false);
      await world.queue.updateOne({ _id: badGroup['_id'] }, { $set: { groupId: 'text' } });
      answer(rig, 'sent');
      await rig.round();
      assert.equal((await stored(noDoc))['sendStatus'], 'sent');
      assert.equal((await stored(badGroup))['sendStatus'], 'sent');
      assert.equal(rig.log.messages('warn').filter((message) => message === 'the group document was not updated').length, 2);
    });

    it('a holder that lost the lease while the provider answered writes nothing, not even on the group document', async () => {
      const rig = await setup();
      const record = await uploaded('fake');
      rig.adapter.onStatus = async () => {
        await world.queue.updateOne({ _id: record['_id'] }, { $set: { 'worker.epoch': 2 } });
        return { kind: 'status', status: 'accepted' } satisfies StatusOutcome;
      };
      await rig.round(1);
      assert.notEqual(await queueRecordOf(world, record), null, 'not deleted');
      assert.equal(await groupStatusOf(world, record), 'new');
      assert.ok(rig.log.messages('warn').includes('status stopped: a newer lease epoch owns the data'));
    });

    it('rethrows an unexpected error of the claim for the runner to log', async () => {
      const rig = await setup();
      await uploaded('fake');
      (rig.context.queue as { claimForStatus: unknown }).claimForStatus = async () => {
        throw new Error('database down');
      };
      await assert.rejects(rig.round(), /database down/);
    });

    it('stops when the signal is aborted', async () => {
      const rig = await setup();
      await uploaded('fake');
      const controller = new AbortController();
      controller.abort();
      await rig.round(1, controller.signal);
      assert.equal(rig.adapter.statuses.length, 0);
    });
  });
});
