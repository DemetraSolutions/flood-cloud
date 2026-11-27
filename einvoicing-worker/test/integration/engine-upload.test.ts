import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { UploadOutcome } from '../../src/providers/types.ts';
import { baseRecord } from '../fixtures/records.ts';
import { createClock, createFakeAdapter, createRig, groupStatusOf, queueRecordOf, SELLER_A, SELLER_B, sellerFields, vatWithCheck, seedDealerAccount, seedPlatformAccount, seedRecord, T0 } from '../helpers/world.ts';
import type { Rig, RigOptions, World } from '../helpers/world.ts';
import { createWorld } from '../helpers/world.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('engine: upload (real MongoDB, fake provider)', () => {
  let world: World;
  before(async () => {
    world = await createWorld();
  });
  after(() => world.drop());
  beforeEach(() => world.reset());

  /** A rig with the platform account of the fake provider. */
  const setup = async (options: Partial<RigOptions> = {}, account: Parameters<typeof seedPlatformAccount>[2] = {}): Promise<Rig> => {
    await seedPlatformAccount(world, 'fake', { username: 'platform-user', password: 'platform-secret', ...account });
    return createRig(world, { hubs: ['fake'], ...options });
  };
  const workerOf = async (record: Document): Promise<Document> => ((await queueRecordOf(world, record)) as Document)['worker'] as Document;

  describe('the happy path', () => {
    it('claims, validates, marks uploading, calls the provider with the account and the XML, and records the outcome', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      await rig.round();

      assert.equal(rig.adapter.uploads.length, 1);
      const { account, file } = rig.adapter.uploads[0] as (typeof rig.adapter.uploads)[number];
      assert.equal(account.hub, 'fake');
      assert.equal(account.username, 'platform-user');
      assert.equal(account.password.reveal(), 'platform-secret');
      assert.deepEqual({ ...file, xml: undefined }, { queueId: (record['_id'] as ObjectId).toHexString(), sellerVat: `IT${SELLER_A}`, number: '42', date: '2026-11-27', progressive: '7', documentType: 'TD01', xml: undefined });
      assert.match(file.xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<p:FatturaElettronica /);
      assert.match(file.xml, /<IdCodice>01879020517<\/IdCodice>/, 'the transmitter of the adapter');

      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['sent'], true);
      assert.equal(stored['hubId'], 'fake-file-1.xml');
      assert.equal(stored['error'], undefined);
      assert.deepEqual(stored['worker'], {
        state: 'uploaded',
        epoch: 1,
        leaseUntil: new Date(T0),
        attempts: 1,
        firstUploadAt: new Date(T0),
        uploadedAt: new Date(T0),
        nextStatusAt: new Date(T0 + 2 * MINUTE),
        statusChecks: 0,
      });
      assert.equal(await groupStatusOf(world, record), 'new', 'the group document is written at the first status answer');
      const history = await world.sent.findOne({ queueId: record['_id'] as ObjectId });
      assert.equal(history?.hub, 'fake');
      assert.equal(history?.providerId, 'fake-file-1.xml');
      assert.equal(history?.released, false);
      assert.deepEqual(await world.limits.find({}).project({ _id: 1 }).sort({ _id: 1 }).toArray().then((docs) => docs.map((doc) => doc._id)), ['account:fake:upload', 'ip:fake:upload']);
      assert.equal(rig.adapter.statuses.length, 0, 'the first status check is two minutes away');
      const names = (await world.queue.indexes()).map((index) => index.name);
      assert.ok(names.includes('einvoicingWorker_upload') && names.includes('einvoicingWorker_status'), 'the queue indexes exist once a hub is enabled');
    });

    it('never writes the password, the XML or a personal datum in the log', async () => {
      const rig = await setup();
      await seedRecord(world, 'fake');
      await rig.round();
      const text = rig.log.lines.join('\n');
      assert.doesNotMatch(text, /platform-secret|<p:Fattura|Rossi|Caff|rssmra80a01h501u|Via Milano/);
    });

    it('sends the oldest first, one per account interval, and the interval survives a new engine instance', async () => {
      const rig = await setup();
      const first = await seedRecord(world, 'fake');
      const second = await seedRecord(world, 'fake', { number: 43 });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1);
      assert.equal((await queueRecordOf(world, first))?.['sent'], true);
      assert.equal((await queueRecordOf(world, second))?.['worker'], undefined);

      rig.clock.advance(64 * 1000);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1, 'the minimum interval is 65 seconds');

      const restarted = createRig(world, { hubs: ['fake'], clock: rig.clock, adapter: rig.adapter });
      rig.clock.advance(1000);
      await restarted.round(2);
      assert.equal(rig.adapter.uploads.length, 2);
      assert.equal((await queueRecordOf(world, second))?.['sent'], true);
    });

    it('spaces the accounts of one provider on the shared IP and keeps them inside the round budget', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const rig = createRig(world, { hubs: ['fake', dealer] });
      await seedRecord(world, 'fake');
      await seedRecord(world, dealer, { number: 50 });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 2);
      assert.deepEqual(rig.clock.waits, [3000], 'the second account waits the IP spacing, nothing else sleeps');
    });

    it('leaves a hub for the next round when its IP wait does not fit the budget', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const rig = createRig(world, { hubs: ['fake', dealer], budgetMs: 4000 });
      await seedRecord(world, dealer);
      const waiting = await seedRecord(world, 'fake', { number: 50 });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1, 'round 1 starts with the second hub of the allowlist');
      assert.equal((await queueRecordOf(world, waiting))?.['worker'], undefined, 'not even claimed');
      assert.deepEqual(rig.clock.waits, []);
    });

    it('takes turns: the hub that went first goes last in the next round', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const rig = createRig(world, { hubs: ['fake', dealer] });
      for (const [index, hub] of ['fake', 'fake', dealer, dealer].entries()) {
        await seedRecord(world, hub, { number: 60 + index });
      }
      await rig.round();
      rig.clock.advance(70_000);
      await rig.round();
      assert.deepEqual(rig.adapter.uploads.map((upload) => upload.account.hub), [dealer, 'fake', 'fake', dealer]);
    });
  });

  describe('records that must be left alone', () => {
    it('does nothing at all when WORKER_HUBS is empty', async () => {
      await seedPlatformAccount(world, 'fake');
      await world.limits.drop().catch(() => undefined);
      await world.sent.drop().catch(() => undefined);
      await world.queue.dropIndexes().catch(() => undefined);
      const rig = createRig(world, { hubs: [] });
      const record = await seedRecord(world, 'fake');
      await rig.round();
      await rig.round();
      assert.equal((await queueRecordOf(world, record))?.['worker'], undefined);
      assert.equal(rig.adapter.uploads.length, 0);
      assert.equal(await world.limits.countDocuments(), 0);
      assert.equal(await world.sent.countDocuments(), 0);
      const collections = (await world.client.db(world.limits.dbName).listCollections().toArray()).map((entry) => entry.name);
      assert.deepEqual(collections.filter((name) => name.startsWith('einvoicing')), [], 'not even an index was created');
      assert.deepEqual((await world.queue.indexes()).map((index) => index.name), ['_id_'], 'no index on the queue either');
      assert.equal(rig.log.messages().filter((message) => message.startsWith('no hubs enabled')).length, 1, 'said once');
    });

    it('leaves the records of a hub outside the allowlist, or with a missing, disabled or unusable account', async () => {
      const dealerOff = await seedDealerAccount(world, 'fake', { enabled: false, username: 'off' });
      const dealerNone = `fake__${new ObjectId().toHexString()}`;
      const dealerBroken = await seedDealerAccount(world, 'fake', { storedPassword: 'garbage', username: 'broken' });
      const outside = await seedDealerAccount(world, 'fake', { username: 'outside' });
      await seedPlatformAccount(world, 'fake', { username: 'platform' });
      const rig = createRig(world, { hubs: [dealerOff, dealerNone, dealerBroken] });
      const records = [];
      for (const hub of [dealerOff, dealerNone, dealerBroken, outside, 'fake', 'unrelated']) {
        records.push(await seedRecord(world, hub));
      }
      await rig.round();
      for (const record of records) {
        assert.equal((await queueRecordOf(world, record))?.['worker'], undefined);
      }
      assert.equal(rig.adapter.uploads.length, 0);
      assert.equal(await world.limits.countDocuments(), 0);
    });

    it('skips the hubs of a provider that has no adapter, saying so once', async () => {
      await seedPlatformAccount(world, 'fake');
      const rig = createRig(world, { hubs: ['fake'], adapters: new Map() });
      const record = await seedRecord(world, 'fake');
      await rig.round();
      await rig.round();
      assert.equal((await queueRecordOf(world, record))?.['worker'], undefined);
      assert.equal(rig.log.messages('warn').filter((message) => message.startsWith('no adapter for the provider')).length, 1);
    });

    it('does not upload a record that already has a result: sent, uploaded (the status job adopts it) or in error', async () => {
      const rig = await setup();
      const sent = await seedRecord(world, 'fake', { sent: true });
      const uploaded = await seedRecord(world, 'fake', { hubId: 'x.xml' });
      const failed = await seedRecord(world, 'fake', { error: { errorCode: '0034' } });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 0);
      for (const record of [sent, failed]) {
        assert.equal((await queueRecordOf(world, record))?.['worker'], undefined);
      }
      assert.equal((await workerOf(uploaded))['state'], 'uploaded');
      assert.deepEqual(rig.adapter.statuses.map((status) => status.providerId), ['x.xml']);
    });

    it('lets the account be disabled between two refreshes: it is re-read right before the call and the adapter forgets it', async () => {
      const rig = await setup();
      await rig.round();
      const record = await seedRecord(world, 'fake');
      await world.settings.updateOne({ key: 'INTEGRATIONS' }, { $set: { 'value.fake.enabled': false } });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 0);
      assert.deepEqual(rig.adapter.forgotten, ['fake']);
      const worker = await workerOf(record);
      assert.equal(worker['state'], 'claimed');
      assert.deepEqual(worker['nextAttemptAt'], new Date(T0 + MINUTE));
      assert.ok(rig.log.messages('warn').includes('the account is no longer usable: the record waits'));
    });
  });

  describe('an account that becomes unusable during the round', () => {
    it('is skipped for the rest of the round while the other accounts go on', async () => {
      const x = await seedDealerAccount(world, 'fake', { username: 'x-user' });
      const y = await seedDealerAccount(world, 'fake', { username: 'y-user' });
      const adapter = createFakeAdapter('fake', true);
      const rig = createRig(world, { hubs: [x, y], adapter });
      adapter.onUpload = async (account) => {
        if (account.hub === x) {
          await world.dealers.updateOne({ _id: new ObjectId(x.split('__')[1] as string) }, { $set: { 'integrations.fake.enabled': false } });
        }
        return { kind: 'accepted', providerId: `${account.hub.slice(-4)}-${adapter.uploads.length}.xml` };
      };
      for (let number = 1; number <= 2; number += 1) {
        await seedRecord(world, x, { number });
      }
      for (let number = 11; number <= 14; number += 1) {
        await seedRecord(world, y, { number });
      }
      await rig.round();
      assert.equal(adapter.uploads.filter((upload) => upload.account.hub === x).length, 1);
      assert.equal(adapter.uploads.filter((upload) => upload.account.hub === y).length, 4);
    });
  });

  describe('validation', () => {
    it('does not send an invoice with errors: it writes the list for "Documenti in errore" and the status of the group', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake', { date: '2027-01-15T10:00:00.000Z' });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 0);
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['error'].errorCode, 'VALIDATION');
      assert.equal(stored['error'].errorDescription, '1 errore di validazione');
      assert.deepEqual(stored['error'].issues, [{ code: '00403', path: 'FatturaElettronicaBody[0].DatiGenerali.DatiGeneraliDocumento.Data', message: stored['error'].issues[0].message }]);
      assert.equal(stored['sendStatus'], 'validationError');
      assert.equal(stored['worker'].state, 'failed');
      assert.equal(stored['worker'].lastCode, 'VALIDATION');
      assert.equal(stored['worker'].validation[0].severity, 'error');
      assert.equal(await groupStatusOf(world, record), 'validationError');
      assert.equal(await world.limits.countDocuments(), 0, 'no quota consumed');
      rig.clock.advance(10 * 60_000);
      await rig.round();
      assert.equal((await workerOf(record))['attempts'], 1, 'it is not claimed again');
    });

    it('is retried by hand: removing the error makes the corrected record claimable again', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake', { date: '2027-01-15T10:00:00.000Z' });
      await rig.round();
      await world.queue.updateOne({ _id: record['_id'] }, { $unset: { error: '' }, $set: { date: '2026-11-20T10:00:00.000Z' } });
      rig.clock.advance(MINUTE);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1);
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['sent'], true);
      assert.equal(stored['worker'].validation, undefined, 'the old list is gone');
      assert.equal(stored['worker'].lastCode, undefined);
      assert.equal(stored['worker'].attempts, 2);
    });

    it('reports a mapping problem as an error, and many issues in plural, keeping only the first 50', async () => {
      const rig = await setup();
      const base = baseRecord();
      const line = (base['records'] as Document[])[0] as Document;
      const noName = { ...line, name: undefined };
      const record = await seedRecord(world, 'fake', { records: Array.from({ length: 60 }, () => noName) });
      await rig.round();
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['error'].errorDescription, '60 errori di validazione');
      assert.equal(stored['error'].issues.length, 50);
      assert.equal(stored['worker'].validation.length, 50);
      assert.equal(stored['error'].issues[0].code, 'MAPPING');
      assert.equal(stored['error'].issues[0].message, 'Dato obbligatorio mancante');
      assert.equal(rig.adapter.uploads.length, 0);
    });

    it('refuses an invoice whose number the SdI already has (history), and sends it again once that one is released', async () => {
      const rig = await setup();
      const first = await seedRecord(world, 'fake');
      await rig.round();
      rig.clock.advance(2 * MINUTE);
      const duplicate = await seedRecord(world, 'fake');
      await rig.round();
      const stored = (await queueRecordOf(world, duplicate)) as Document;
      assert.equal(stored['error'].issues[0].code, '00404');
      assert.equal(rig.adapter.uploads.length, 1);

      await world.sent.updateOne({ queueId: first['_id'] as ObjectId }, { $set: { released: true } });
      await world.queue.updateOne({ _id: duplicate['_id'] }, { $unset: { error: '' } });
      rig.clock.advance(MINUTE);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 2);
    });

    it('does not mistake a record for its own duplicate', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      await world.sent.insertOne({ key: `["IT${SELLER_A}","42","2026","other"]`, queueId: record['_id'] as ObjectId, hub: 'fake', providerId: 'old.xml', sentAt: new Date(T0), released: false });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1);
    });

    it('cites the original of a credit note read from the group database, and warns when it is missing', async () => {
      const rig = await setup();
      const group = new ObjectId();
      const original = new ObjectId();
      await world.group(group).insertOne({ _id: original, number: 12, prefixSuffix: '', date: new Date('2026-11-20T10:00:00.000Z'), counterpart: { name: 'private' } });
      const note = await seedRecord(world, 'fake', { type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: original, groupId: group, number: 43 });
      await world.queue.updateOne({ _id: note['_id'] }, { $set: { groupId: group } });
      await rig.round();
      assert.match(rig.adapter.uploads[0]?.file.xml ?? '', /<DatiFattureCollegate>\s*<IdDocumento>12<\/IdDocumento>\s*<Data>2026-11-20<\/Data>/);

      rig.clock.advance(66_000);
      const orphan = await seedRecord(world, 'fake', { type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: new ObjectId(), number: 44 });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 2);
      assert.doesNotMatch(rig.adapter.uploads[1]?.file.xml ?? '', /DatiFattureCollegate/);
      assert.equal((await queueRecordOf(world, orphan))?.['sent'], true);
    });

    it('lists the missing original as a warning when the invoice fails for another reason', async () => {
      const rig = await setup();
      const note = await seedRecord(world, 'fake', { type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: 'not-an-id', date: '2027-01-15T10:00:00.000Z' });
      await rig.round();
      const issues = ((await queueRecordOf(world, note)) as Document)['worker'].validation as Array<{ code: string; severity: string }>;
      assert.deepEqual(issues.map((issue) => `${issue.code}:${issue.severity}`), ['00403:error', 'LINKED:warning']);
    });

    it('writes the failure even when the group document does not exist, or the group id is not an ObjectId', async () => {
      const rig = await setup();
      const noGroupDoc = await seedRecord(world, 'fake', { date: '2027-01-15T10:00:00.000Z' }, { group: false });
      await rig.round();
      assert.equal((await queueRecordOf(world, noGroupDoc))?.['sendStatus'], 'validationError');
      assert.ok(rig.log.messages('warn').includes('the group document was not updated'));
      const badGroup = await seedRecord(world, 'fake', { date: '2027-01-15T10:00:00.000Z', groupId: 'text' }, { group: false });
      await world.queue.updateOne({ _id: badGroup['_id'] }, { $set: { groupId: 'text' } });
      await rig.round();
      assert.equal((await queueRecordOf(world, badGroup))?.['sendStatus'], 'validationError');
    });
  });

  describe('every outcome of the provider', () => {
    const outcome = async (rig: Rig, result: UploadOutcome): Promise<void> => {
      rig.adapter.onUpload = () => result;
      await rig.round();
    };

    it('rejected: the error is stored for good, the group says processingError, the record is not tried again', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      await outcome(rig, { kind: 'rejected', code: '0034', description: 'x'.repeat(900) });
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['error'].errorCode, '0034');
      assert.equal(stored['error'].errorDescription.length, 500);
      assert.equal(stored['sendStatus'], 'processingError');
      assert.equal(stored['worker'].state, 'failed');
      assert.equal(stored['worker'].lastCode, '0034');
      assert.equal(stored['sent'], undefined);
      assert.equal(await groupStatusOf(world, record), 'processingError');
      assert.equal(await world.sent.countDocuments(), 0);
      rig.clock.advance(10 * MINUTE);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1);
    });

    it('maybeSent: stays uploading and is looked up, after five minutes, before any new upload', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      await outcome(rig, { kind: 'maybeSent' });
      let worker = await workerOf(record);
      assert.equal(worker['state'], 'uploading');
      assert.equal(worker['lastCode'], 'MAYBE_SENT');
      assert.deepEqual(worker['nextAttemptAt'], new Date(T0 + 5 * MINUTE));
      rig.clock.advance(4 * MINUTE);
      await rig.round();
      assert.equal(rig.adapter.finds.length, 0);

      rig.adapter.onFind = () => ({ kind: 'notFound' });
      rig.adapter.onUpload = () => ({ kind: 'accepted', providerId: 'second-try.xml' });
      rig.clock.advance(2 * MINUTE);
      await rig.round();
      assert.equal(rig.adapter.finds.length, 1);
      assert.equal(rig.adapter.finds[0]?.ref.number, '42');
      assert.equal(rig.adapter.uploads.length, 2);
      worker = await workerOf(record);
      assert.equal(worker['state'], 'uploaded');
      assert.equal((await queueRecordOf(world, record))?.['hubId'], 'second-try.xml');
    });

    it('maybeSent then found: the file is recorded as sent without a second upload', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      await outcome(rig, { kind: 'maybeSent' });
      rig.adapter.onFind = () => ({ kind: 'found', providerId: 'already-there.xml' });
      rig.clock.advance(6 * MINUTE);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1, 'never uploaded twice');
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['hubId'], 'already-there.xml');
      assert.equal(stored['sent'], true);
      assert.equal(stored['worker'].state, 'uploaded');
      assert.equal((await world.sent.findOne({ queueId: record['_id'] as ObjectId }))?.providerId, 'already-there.xml');
      assert.ok(rig.log.messages('warn').includes('an interrupted upload had been accepted: recorded'));
    });

    it('a lookup that must wait keeps the record uploading and tries again later', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      await outcome(rig, { kind: 'maybeSent' });
      rig.adapter.onFind = () => ({ kind: 'retry', afterMs: 3 * MINUTE, code: 'SEARCH_LIMIT' });
      rig.clock.advance(6 * MINUTE);
      await rig.round();
      const worker = await workerOf(record);
      assert.equal(worker['state'], 'uploading');
      assert.equal(worker['lastCode'], 'SEARCH_LIMIT');
      assert.deepEqual(worker['nextAttemptAt'], new Date(T0 + 6 * MINUTE + 3 * MINUTE));
      assert.equal(rig.adapter.uploads.length, 1);
    });

    it('recovers a crash: a record found `uploading` with an expired lease is looked up first (found, then not found)', async () => {
      const rig = await setup();
      const crashed = await seedRecord(world, 'fake', { worker: { state: 'uploading', epoch: 1, firstUploadAt: new Date(T0 - 5 * MINUTE), leaseUntil: new Date(T0 - 1), attempts: 1, nextAttemptAt: new Date(T0 - MINUTE) } });
      rig.adapter.onFind = () => ({ kind: 'found', providerId: 'sent-before-the-crash.xml' });
      await rig.round(2);
      assert.equal(rig.adapter.uploads.length, 0);
      assert.equal((await queueRecordOf(world, crashed))?.['hubId'], 'sent-before-the-crash.xml');
      assert.equal((await workerOf(crashed))['epoch'], 2);

      const crashed2 = await seedRecord(world, 'fake', { number: 43, worker: { state: 'uploading', epoch: 1, firstUploadAt: new Date(T0 - 5 * MINUTE), leaseUntil: new Date(T0 - 1), attempts: 1, nextAttemptAt: new Date(T0 - MINUTE) } });
      rig.adapter.onFind = () => ({ kind: 'notFound' });
      rig.clock.advance(2 * MINUTE);
      await rig.round(2);
      assert.equal(rig.adapter.uploads.length, 1);
      assert.equal((await queueRecordOf(world, crashed2))?.['sent'], true);
    });

    const crashedRecord = (values: Record<string, unknown> = {}) =>
      seedRecord(world, 'fake', { worker: { state: 'uploading', epoch: 1, firstUploadAt: new Date(T0 - 5 * MINUTE), leaseUntil: new Date(T0 - 1), attempts: 1, nextAttemptAt: new Date(T0 - MINUTE), ...values } });

    it('an incomplete search stops the record for a person: review, FIND_INCOMPLETE, never uploaded, never looked up again', async () => {
      const rig = await setup();
      const crashed = await crashedRecord();
      rig.adapter.onFind = () => ({ kind: 'unknown' });
      await rig.round(2);
      const worker = await workerOf(crashed);
      assert.deepEqual([worker['state'], worker['lastCode']], ['review', 'FIND_INCOMPLETE']);
      assert.equal(rig.adapter.uploads.length, 0);
      rig.clock.advance(HOUR);
      await rig.round(2);
      assert.equal(rig.adapter.finds.length, 1);
      assert.equal(rig.adapter.uploads.length, 0);
      assert.ok(rig.log.messages('warn').includes('the search at the provider could not be completed: the invoice needs a manual check'));
    });

    it('a retry that carries a resume point stores it, and the next search is handed it; a retry without one keeps the stored point', async () => {
      const rig = await setup();
      const crashed = await crashedRecord();
      rig.adapter.onFind = () => ({ kind: 'retry', afterMs: MINUTE, code: 'FIND_BUDGET', resume: { slice: 1, page: 3 } });
      await rig.round(2);
      assert.deepEqual((await workerOf(crashed))['findFrom'], { slice: 1, page: 3 });
      rig.adapter.onFind = () => ({ kind: 'retry', afterMs: MINUTE, code: 'HTTP_503' });
      rig.clock.advance(2 * MINUTE);
      await rig.round(2);
      assert.deepEqual(rig.adapter.finds[1]?.ref.resume, { slice: 1, page: 3 });
      assert.deepEqual((await workerOf(crashed))['findFrom'], { slice: 1, page: 3 });
      rig.adapter.onFind = () => ({ kind: 'notFound' });
      rig.clock.advance(2 * MINUTE);
      await rig.round(2);
      assert.deepEqual(rig.adapter.finds[2]?.ref.resume, { slice: 1, page: 3 });
    });

    it('a complete search that found nothing is remembered up to an hour ago: the resume point goes and the next search starts there', async () => {
      const rig = await setup();
      const crashed = await crashedRecord({ findFrom: { slice: 1, page: 3 }, firstUploadAt: new Date(T0 - 3 * HOUR) });
      rig.adapter.onFind = () => ({ kind: 'notFound' });
      rig.adapter.onUpload = () => ({ kind: 'maybeSent' });
      await rig.round(2);
      const worker = await workerOf(crashed);
      assert.deepEqual(worker['searchedUntil'], new Date(T0 - HOUR));
      assert.equal(worker['findFrom'], undefined);
      assert.equal(rig.adapter.uploads.length, 1);
      rig.clock.advance(6 * MINUTE);
      await rig.round(2);
      assert.equal(rig.adapter.finds[0]?.ref.since, T0 - 3 * HOUR);
      assert.equal(rig.adapter.finds[1]?.ref.since, T0 - HOUR, 'later than the first upload');
    });

    it('counts the maybe-sent answers of a record and, after three, stops it for a person instead of uploading again', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      rig.adapter.onUpload = () => ({ kind: 'maybeSent' });
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await rig.round(2);
        assert.equal((await workerOf(record))['maybeSentCycles'], cycle);
        assert.equal((await workerOf(record))['state'], 'uploading');
        rig.clock.advance(6 * MINUTE);
      }
      await rig.round(2);
      assert.equal(rig.adapter.uploads.length, 4, 'three answers were tolerated; the fourth stops the record');
      const worker = await workerOf(record);
      assert.deepEqual([worker['state'], worker['lastCode'], worker['maybeSentCycles']], ['review', 'MAYBE_SENT_LOOP', 3]);
      rig.clock.advance(HOUR);
      await rig.round(2);
      assert.equal(rig.adapter.uploads.length, 4);
    });

    it('hands a crashed record back when the lookup cannot fit the round, without looking or uploading', async () => {
      const rig = await setup({ budgetMs: 20_000 });
      const crashed = await seedRecord(world, 'fake', { worker: { state: 'uploading', epoch: 1, firstUploadAt: new Date(T0 - 5 * MINUTE), leaseUntil: new Date(T0 - 1), attempts: 1, nextAttemptAt: new Date(T0 - MINUTE) } });
      await world.limits.insertOne({ _id: 'ip:fake:status', epoch: 1, nextAt: new Date(T0 + 12_000), until: new Date(0), step: 0, recent: [], year: 0, yearCount: 0 });
      await rig.round(2);
      assert.equal(rig.adapter.finds.length, 0);
      assert.equal(rig.adapter.uploads.length, 0);
      const worker = await workerOf(crashed);
      assert.equal(worker['state'], 'uploading');
      assert.deepEqual(worker['nextAttemptAt'], new Date(T0));
    });

    it('does not take a record whose previous holder may still be working on it (lease not expired)', async () => {
      const rig = await setup();
      const busy = await seedRecord(world, 'fake', { worker: { state: 'uploading', epoch: 1, firstUploadAt: new Date(T0 - 5 * MINUTE), leaseUntil: new Date(T0 + MINUTE), attempts: 1, nextAttemptAt: new Date(T0 - MINUTE) } });
      await rig.round(2);
      assert.equal(rig.adapter.uploads.length, 0);
      assert.equal(rig.adapter.finds.length, 0);
      assert.equal((await workerOf(busy))['epoch'], 1);
    });

    it('retry of one document: only that document waits', async () => {
      const rig = await setup();
      const blocked = await seedRecord(world, 'fake');
      const other = await seedRecord(world, 'fake', { number: 43 });
      await outcome(rig, { kind: 'retry', scope: 'document', afterMs: 15 * MINUTE, code: '0001' });
      const worker = await workerOf(blocked);
      assert.equal(worker['state'], 'claimed');
      assert.equal(worker['lastCode'], '0001');
      assert.deepEqual(worker['nextAttemptAt'], new Date(T0 + 15 * MINUTE));
      assert.equal(await world.limits.countDocuments({ _id: /^seller:/ }), 0);
      rig.adapter.onUpload = () => ({ kind: 'accepted', providerId: 'next.xml' });
      rig.clock.advance(MINUTE + 5000);
      await rig.round();
      assert.equal((await queueRecordOf(world, other))?.['sent'], true, 'the next document goes first');
      assert.equal((await queueRecordOf(world, blocked))?.['sent'], undefined);
      rig.clock.advance(15 * MINUTE);
      await rig.round();
      assert.equal((await queueRecordOf(world, blocked))?.['sent'], true);
    });

    it('retry of a seller: the other sellers of the hub keep flowing, this one waits until its cooldown ends', async () => {
      const rig = await setup();
      const first = await seedRecord(world, 'fake');
      const sameSeller = await seedRecord(world, 'fake', { number: 43 });
      const otherSeller = await seedRecord(world, 'fake', { number: 44, ...sellerFields(SELLER_B) });
      await outcome(rig, { kind: 'retry', scope: 'seller', afterMs: 62 * MINUTE, code: '0093' });
      assert.deepEqual((await workerOf(first))['nextAttemptAt'], new Date(T0 + 62 * MINUTE));
      assert.equal((await world.limits.findOne({ _id: `seller:fake:IT${SELLER_A}` }))?.until.getTime(), T0 + 62 * MINUTE);

      rig.adapter.onUpload = () => ({ kind: 'accepted', providerId: 'other-seller.xml' });
      rig.clock.advance(MINUTE + 5000);
      await rig.round();
      assert.equal((await queueRecordOf(world, otherSeller))?.['sent'], true);
      assert.equal((await queueRecordOf(world, sameSeller))?.['worker'], undefined, 'not even claimed while the seller cools down');
      assert.equal((await queueRecordOf(world, first))?.['sent'], undefined);

      rig.clock.advance(62 * MINUTE);
      await rig.round();
      assert.equal((await queueRecordOf(world, first))?.['sent'], true, 'the oldest of the seller first');
    });

    it('retry of the account: stepped backoff, nothing is claimed meanwhile, and a success resets the steps', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      await outcome(rig, { kind: 'retry', scope: 'account', afterMs: 1000, code: '0099' });
      assert.deepEqual((await workerOf(record))['nextAttemptAt'], new Date(T0 + 10 * MINUTE), 'first step: ten minutes');
      assert.equal((await workerOf(record))['attempts'], 1);
      rig.clock.advance(9 * MINUTE);
      await rig.round();
      assert.equal((await workerOf(record))['attempts'], 1, 'no claim during the backoff');

      rig.clock.advance(MINUTE + 1000);
      await rig.round();
      assert.equal((await workerOf(record))['attempts'], 2);
      assert.deepEqual((await workerOf(record))['nextAttemptAt'], new Date(T0 + 10 * MINUTE + 1000 + 25 * MINUTE), 'second step: 25 minutes');

      rig.clock.advance(26 * MINUTE);
      rig.adapter.onUpload = () => ({ kind: 'accepted', providerId: 'ok.xml' });
      await rig.round();
      assert.equal((await queueRecordOf(world, record))?.['sent'], true);
      assert.equal((await world.limits.findOne({ _id: 'account:fake:upload' }))?.step, 0, 'reset after the success');
    });

    it('retry of the IP: every account of the provider waits, not only this one', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const rig = createRig(world, { hubs: ['fake', dealer] });
      await seedRecord(world, dealer);
      const other = await seedRecord(world, 'fake', { number: 50 });
      rig.adapter.onUpload = () => ({ kind: 'retry', scope: 'ip', afterMs: 20 * MINUTE, code: '429' });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1, 'the second account does not even try');
      assert.equal((await queueRecordOf(world, other))?.['worker'], undefined);
      assert.equal((await world.limits.findOne({ _id: 'ip:fake:upload' }))?.until.getTime(), T0 + 20 * MINUTE);
    });

    it('an unexpected error never loses the record: it waits a minute, stays uploading and is looked up', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      rig.adapter.onUpload = () => {
        throw new Error('socket hang up with platform-secret inside');
      };
      await rig.round();
      const worker = await workerOf(record);
      assert.equal(worker['state'], 'uploading');
      assert.equal(worker['lastCode'], 'ERROR');
      assert.deepEqual(worker['nextAttemptAt'], new Date(T0 + MINUTE));
      assert.ok(rig.log.messages('error').includes('upload failed: the record will be tried again'));
      assert.doesNotMatch(rig.log.lines.join('\n'), /socket hang up|platform-secret/, 'the message of an adapter error is never logged');
      assert.equal(rig.log.entries().find((entry) => entry['message'] === 'upload failed: the record will be tried again')?.['errorName'], 'Error');
      rig.adapter.onUpload = () => ({ kind: 'accepted', providerId: 'again.xml' });
      rig.clock.advance(2 * MINUTE);
      await rig.round();
      assert.equal(rig.adapter.finds.length, 1, 'looked up before uploading again');
      assert.equal((await queueRecordOf(world, record))?.['sent'], true);
    });

    it('logs only the name of something that is not an error object', async () => {
      const rig = await setup();
      await seedRecord(world, 'fake');
      rig.adapter.onUpload = () => {
        throw 'plain text with platform-secret';
      };
      await rig.round();
      assert.equal(rig.log.entries().find((entry) => entry['message'] === 'upload failed: the record will be tried again')?.['errorName'], 'string');
      assert.doesNotMatch(rig.log.lines.join('\n'), /platform-secret/);
    });

    it('an error before the provider is called leaves the record claimed and retries it in a minute', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      const real = rig.context.history.lookupFor;
      (rig.context.history as { lookupFor: typeof real }).lookupFor = () => async () => {
        throw new Error('history unavailable');
      };
      await rig.round();
      const worker = await workerOf(record);
      assert.equal(worker['state'], 'claimed');
      assert.equal(rig.adapter.uploads.length, 0);
      assert.deepEqual(worker['nextAttemptAt'], new Date(T0 + MINUTE));
    });
  });

  describe('a record that may have been sent is looked up BEFORE it is prepared', () => {
    const crashed = (values: Record<string, unknown> = {}) => seedRecord(world, 'fake', { worker: { state: 'uploading', epoch: 1, firstUploadAt: new Date(T0 - 5 * MINUTE), leaseUntil: new Date(T0 - 1), attempts: 1, nextAttemptAt: new Date(T0 - MINUTE) }, ...values });

    it('found: recorded as sent even if the record would no longer validate (no history entry, no upload)', async () => {
      const rig = await setup();
      const record = await crashed({ date: '2027-01-15T10:00:00.000Z', 'company.invoicesPS': 'prefix', prefixSuffix: 'A/' });
      rig.adapter.onFind = () => ({ kind: 'found', providerId: 'there.xml' });
      await rig.round(2);
      assert.equal(rig.adapter.uploads.length, 0);
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['sent'], true);
      assert.equal(stored['hubId'], 'there.xml');
      assert.equal(stored['error'], undefined, 'not marked as a validation failure');
      assert.equal(stored['worker'].state, 'uploaded');
      assert.equal(stored['worker'].historyPending, undefined);
      assert.equal(await world.sent.countDocuments(), 0);
      assert.deepEqual(rig.adapter.finds[0]?.ref, { queueId: (record['_id'] as ObjectId).toHexString(), sellerVat: `IT${SELLER_A}`, number: 'A/42', date: '2027-01-15', progressive: '7', documentType: 'TD01', since: T0 - 5 * MINUTE });
      assert.ok(rig.log.messages('warn').includes('the recovered invoice no longer validates: no history entry is written'));
    });

    it('notFound and the preparation fails: it is a validation failure as usual, never uploaded', async () => {
      const rig = await setup();
      const record = await crashed({ date: '2027-01-15T10:00:00.000Z' });
      await rig.round(2);
      assert.equal(rig.adapter.finds.length, 1);
      assert.equal(rig.adapter.uploads.length, 0);
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['error'].errorCode, 'VALIDATION');
      assert.equal(stored['worker'].state, 'failed');
    });

    it('with no usable reference it goes to review: never failed, never uploaded, not looked at again', async () => {
      const rig = await setup();
      const record = await crashed({ number: undefined });
      await rig.round(2);
      assert.equal(rig.adapter.finds.length, 0);
      assert.equal(rig.adapter.uploads.length, 0);
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['worker'].state, 'review');
      assert.equal(stored['worker'].lastCode, 'NO_REF');
      assert.equal(stored['error'], undefined);
      assert.ok(rig.log.messages('warn').includes('a record that may have been sent cannot be looked up: it needs a manual check'));
      rig.clock.advance(10 * MINUTE);
      await rig.round(2);
      assert.equal((await workerOf(record))['attempts'], 2, 'claimed once, never again');
    });
  });

  describe('a seller without a text code', () => {
    it('cannot be keyed for a cooldown: the whole account backs off instead', async () => {
      const rig = await setup();
      const ten = '1234567890';
      const record = await seedRecord(world, 'fake', { 'company.code': Number(vatWithCheck(ten)), 'company.code2': vatWithCheck(ten) });
      await world.queue.updateOne({ _id: record['_id'] }, { $set: { 'company.code': Number(vatWithCheck(ten)) } });
      rig.adapter.onUpload = () => ({ kind: 'retry', scope: 'seller', afterMs: 62 * MINUTE, code: '0093' });
      await rig.round();
      assert.equal(await world.limits.countDocuments({ _id: /^seller:/ }), 0);
      const account = await world.limits.findOne({ _id: 'account:fake:upload' });
      assert.equal(account?.step, 1);
      assert.equal(account?.until.getTime(), T0 + 62 * MINUTE, 'the provider asked for more than the first step');
    });
  });

  describe('the history entry is best effort and never causes a second upload', () => {
    const failing = (rig: Rig, error: Error) => {
      const history = rig.context.history as { recordAccepted: unknown };
      const real = history.recordAccepted;
      let calls = 0;
      history.recordAccepted = async () => {
        calls += 1;
        throw error;
      };
      return { restore: () => void (history.recordAccepted = real), calls: () => calls };
    };

    it('a generic failure: sent and hubId are stored, the entry is pending and written at the next status check', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      const broken = failing(rig, Object.assign(new Error('socket hang up with secret-text'), { code: 'ECONNRESET' }));
      await rig.round();
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['sent'], true);
      assert.equal(stored['hubId'], 'fake-file-1.xml');
      assert.equal(stored['worker'].state, 'uploaded');
      assert.equal(stored['worker'].historyPending, true);
      assert.equal(stored['worker'].historyKey, `["IT${SELLER_A}","42","2026","other"]`);
      assert.equal(await world.sent.countDocuments(), 0);
      const warn = rig.log.entries().find((entry) => entry['message'] === 'the history entry could not be written: it will be tried again');
      assert.equal(warn?.['errorName'], 'Error');
      assert.equal(warn?.['errorCode'], 'ECONNRESET');
      assert.doesNotMatch(rig.log.lines.join('\n'), /secret-text|socket hang up/);

      rig.clock.advance(66_000);
      await seedRecord(world, 'fake', { number: 43 });
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 2, 'only the new record went out: the first is never uploaded again');
      broken.restore();
      rig.clock.advance(3 * MINUTE);
      await rig.round();
      const entry = await world.sent.findOne({ queueId: record['_id'] as ObjectId });
      assert.equal(entry?.providerId, 'fake-file-1.xml');
      assert.deepEqual(entry?.sentAt, new Date(T0));
      assert.equal(((await workerOf(record)) as Document)['historyPending'], undefined);
      assert.equal(((await workerOf(record)) as Document)['historyKey'], undefined);
    });

    it('a failure that persists keeps the entry pending after every status check', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      const broken = failing(rig, new Error('down'));
      await rig.round();
      rig.clock.advance(3 * MINUTE);
      await rig.round();
      assert.equal(broken.calls(), 2);
      assert.equal(((await workerOf(record)) as Document)['historyPending'], true);
      assert.equal(rig.adapter.statuses.length, 1, 'the status is still asked');
    });

    it('a duplicate key: logged, marked as a conflict, never retried', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      const broken = failing(rig, Object.assign(new Error('E11000'), { code: 11000 }));
      await rig.round();
      const worker = await workerOf(record);
      assert.equal(worker['historyPending'], false);
      assert.equal(worker['historyConflict'], true);
      assert.equal(((await queueRecordOf(world, record)) as Document)['sent'], true);
      assert.ok(rig.log.messages('warn').includes('the invoice number is already in the history: no entry written'));
      rig.clock.advance(3 * MINUTE);
      await rig.round();
      assert.equal(broken.calls(), 1, 'not tried again');
      assert.equal(rig.adapter.uploads.length, 1);
    });
  });

  describe('limits of the account', () => {
    it('stops at the yearly cap until 1 January and warns once a day', async () => {
      const rig = await setup({}, { maxPerYear: 1 });
      await seedRecord(world, 'fake');
      const waiting = await seedRecord(world, 'fake', { number: 43 });
      await rig.round();
      rig.clock.advance(2 * MINUTE);
      await rig.round();
      rig.clock.advance(2 * MINUTE);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 1);
      assert.equal((await queueRecordOf(world, waiting))?.['worker'], undefined);
      assert.equal(rig.log.messages('warn').filter((message) => message.startsWith('the yearly cap')).length, 1);

      rig.clock.set(Date.UTC(2026, 11, 30, 12, 0, 0));
      await rig.round();
      assert.equal(rig.log.messages('warn').filter((message) => message.startsWith('the yearly cap')).length, 2, 'a new day, a new warning');
      assert.equal(rig.adapter.uploads.length, 1);

      rig.clock.set(Date.UTC(2026, 11, 31, 23, 0, 0));
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 2, 'free again from 1 January in Rome');
    });

    it('holds the hourly cap over a sliding hour', async () => {
      const rig = await setup({}, { maxPerHour: 2 });
      for (let number = 42; number < 45; number += 1) {
        await seedRecord(world, 'fake', { number });
      }
      await rig.round();
      rig.clock.advance(66_000);
      await rig.round();
      rig.clock.advance(66_000);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 2);
      rig.clock.set(T0 + 59 * MINUTE);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 2);
      rig.clock.set(T0 + 60 * MINUTE + 1);
      await rig.round();
      assert.equal(rig.adapter.uploads.length, 3);
    });
  });

  describe('fencing and races', () => {
    it('two engines on one record: exactly one uploads it', async () => {
      await seedPlatformAccount(world, 'fake');
      const a = createRig(world, { hubs: ['fake'] });
      const b = createRig(world, { hubs: ['fake'], clock: a.clock });
      await seedRecord(world, 'fake');
      await Promise.all([a.round(1), b.round(1)]);
      assert.equal(a.adapter.uploads.length + b.adapter.uploads.length, 1);
    });

    it('a holder that lost the lease while the provider answered still stores sent and hubId, and the new holder never uploads it again', async () => {
      const rig = await setup();
      const record = await seedRecord(world, 'fake');
      rig.adapter.onUpload = async () => {
        await world.queue.updateOne({ _id: record['_id'] }, { $set: { 'worker.epoch': 2 } });
        return { kind: 'accepted', providerId: 'late.xml' };
      };
      await rig.round(1);
      const stored = (await queueRecordOf(world, record)) as Document;
      assert.equal(stored['sent'], true, 'the file is at the provider: recorded whatever the lease');
      assert.equal(stored['hubId'], 'late.xml');
      assert.equal(stored['worker'].state, 'uploading', 'the worker state is left to the new holder: fenced');
      assert.ok(rig.log.messages('warn').includes('upload stopped: a newer lease epoch owns the data'));

      rig.clock.advance(3 * MINUTE);
      rig.adapter.onUpload = () => ({ kind: 'accepted', providerId: 'never.xml' });
      await rig.round(2);
      assert.equal(rig.adapter.uploads.length, 1, 'no second upload');
      assert.equal(rig.adapter.statuses.length, 1, 'adopted by the status job');
      assert.equal((await world.sent.findOne({ queueId: record['_id'] as ObjectId }))?.providerId, 'late.xml', 'the pending history entry was written');
      assert.equal(((await workerOf(record)) as Document)['historyPending'], undefined);
    });

    it('a holder that lost the lease cannot spend the limiters of the new one', async () => {
      const rig = await setup();
      await world.limits.insertOne({ _id: 'ip:fake:upload', epoch: 5, nextAt: new Date(0), until: new Date(0), step: 0, recent: [], year: 0, yearCount: 0 });
      await seedRecord(world, 'fake');
      await rig.round(1);
      assert.equal(rig.adapter.uploads.length, 0);
      assert.ok(rig.log.messages('warn').includes('upload stopped: a newer lease epoch owns the data'));
    });

    it('stops promptly when the signal is aborted, and hands the claimed record back', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const clock = createClock();
      const controller = new AbortController();
      const original = clock.sleep;
      clock.sleep = async (ms, signal) => {
        controller.abort();
        await original(ms, signal);
      };
      const rig = createRig(world, { hubs: ['fake', dealer], clock });
      await seedRecord(world, dealer);
      const second = await seedRecord(world, 'fake', { number: 50 });
      await rig.round(1, controller.signal);
      assert.equal(rig.adapter.uploads.length, 1, 'the second wait was interrupted: nothing more is sent');
      const worker = await workerOf(second);
      assert.equal(worker['state'], 'claimed');
      assert.deepEqual(worker['nextAttemptAt'], new Date(clock.now()));
      assert.equal((await queueRecordOf(world, second))?.['sent'], undefined);
    });

    it('does not start another hub once the signal fired during an upload', async () => {
      const dealer = await seedDealerAccount(world, 'fake', { username: 'dealer-user' });
      await seedPlatformAccount(world, 'fake', { username: 'platform-user' });
      const controller = new AbortController();
      const rig = createRig(world, { hubs: ['fake', dealer] });
      rig.adapter.onUpload = () => {
        controller.abort();
        return { kind: 'accepted', providerId: 'one.xml' };
      };
      await seedRecord(world, dealer);
      const other = await seedRecord(world, 'fake');
      await rig.round(1, controller.signal);
      assert.equal(rig.adapter.uploads.length, 1);
      assert.equal((await queueRecordOf(world, other))?.['worker'], undefined);
    });

    it('rethrows an unexpected error of the claim for the runner to log', async () => {
      const rig = await setup();
      await seedRecord(world, 'fake');
      (rig.context.queue as { claimForUpload: unknown }).claimForUpload = async () => {
        throw new Error('database down');
      };
      await assert.rejects(rig.round(), /database down/);
    });
  });
});
void createFakeAdapter;
