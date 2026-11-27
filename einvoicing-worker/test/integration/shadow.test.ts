import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import { commonDatabaseName, queueDatabaseName } from '../../src/db/names.ts';
import { createGroupStore } from '../../src/engine/groups.ts';
import { createSentHistory } from '../../src/engine/history.ts';
import { analyseRecord, failedReport, hubOf, SHADOW_TRANSMITTERS } from '../../src/shadow/analyse.ts';
import { createShadowJob, MAX_ANALYSIS_ATTEMPTS } from '../../src/shadow/job.ts';
import type { ShadowJobOptions } from '../../src/shadow/job.ts';
import { createShadowQueue } from '../../src/shadow/queue.ts';
import { createShadowReports, SHADOW_COLLECTION } from '../../src/shadow/reports.ts';
import type { ShadowReport, ShadowReports } from '../../src/shadow/reports.ts';
import { baseRecord, withValues } from '../fixtures/records.ts';
import { assertSafeTestDatabaseName, testMongoUri } from '../helpers/mongo.ts';
import { createClock, createLogSink, createWorld, SELLER_A, seedRecord, sellerFields, T0 } from '../helpers/world.ts';
import type { World } from '../helpers/world.ts';

const ARUBA = 'aruba';
const WRITES = new Set(['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'drop', 'dropIndexes', 'dropDatabase', 'create', 'renameCollection', 'bulkWrite']);

describe('the shadow mode', () => {
  let world: World;
  let monitored: MongoClient;
  const commands: Array<{ name: string; db: string; collection: string }> = [];
  let reportsCollection: Collection<ShadowReport>;
  let reports: ShadowReports;

  before(async () => {
    world = await createWorld();
    // A second client that records every command it sends: the proof of what the shadow mode may touch.
    monitored = new MongoClient(testMongoUri(), { monitorCommands: true });
    monitored.on('commandStarted', (event) => {
      const target: unknown = (event.command as Document)[event.commandName];
      commands.push({ name: event.commandName, db: event.databaseName, collection: typeof target === 'string' ? target : '' });
    });
    await monitored.connect();
  });
  after(async () => {
    await monitored.close();
    await world.drop();
  });
  beforeEach(async () => {
    await world.reset();
    await world.client.db(commonDatabaseName(world.names)).collection(SHADOW_COLLECTION).drop().catch(() => undefined);
    reportsCollection = monitored.db(commonDatabaseName(world.names)).collection<ShadowReport>(SHADOW_COLLECTION);
    reports = createShadowReports(reportsCollection);
    commands.length = 0;
  });

  const queueCollection = (): Collection<Document> => monitored.db(queueDatabaseName(world.names)).collection('documents');

  function build(overrides: Partial<ShadowJobOptions> = {}) {
    const log = createLogSink();
    const clock = createClock();
    const queue = createShadowQueue(queueCollection());
    const reads: string[] = [];
    const counting = { idsAfter: queue.idsAfter, read: async (id: ObjectId) => (reads.push(id.toHexString()), await queue.read(id)) };
    const history = createSentHistory(monitored.db(commonDatabaseName(world.names)).collection('einvoicingSentInvoices'));
    const store = createGroupStore(monitored, world.names);
    const job = createShadowJob({
      queue: counting,
      reports,
      groups: { readOriginal: store.readOriginal },
      lookupFor: history.lookupFor,
      hubs: [ARUBA],
      batch: 50,
      lookbackDays: 30,
      codeVersion: '0.1.0+test',
      budgetMs: 30_000,
      logger: log.logger,
      clock: clock.now,
      ...overrides,
    });
    const run = async (signal = new AbortController().signal): Promise<void> => await job.run({ epoch: 1, signal });
    return { job, run, log, clock, reads };
  }

  const reportsOf = async (): Promise<ShadowReport[]> => await world.client.db(commonDatabaseName(world.names)).collection<ShadowReport>(SHADOW_COLLECTION).find({}).sort({ queueId: 1 }).toArray();

  /** Counts of every document of every collection the shadow mode must leave alone. */
  async function snapshot(): Promise<unknown> {
    const dump = async (collection: Collection<Document>): Promise<Document[]> => await collection.find({}).sort({ _id: 1 }).toArray();
    const groups = await world.client.db().admin().listDatabases({ nameOnly: true });
    const mine = groups.databases.map((entry) => entry.name).filter((name) => name.startsWith(world.names.prefix) && name !== commonDatabaseName(world.names));
    const out: Record<string, unknown> = { queue: await dump(world.queue), sent: await dump(world.sent as unknown as Collection<Document>), limits: await dump(world.limits as unknown as Collection<Document>), dealers: await dump(world.dealers), settings: await dump(world.settings) };
    for (const name of mine) {
      out[name] = await dump(world.client.db(name).collection('documents'));
    }
    out['queueIndexes'] = (await world.queue.indexes()).map((index) => index.name);
    return out;
  }

  it('does nothing, not even create the indexes, when no hub is selected, and says so once', async () => {
    await seedRecord(world, ARUBA);
    const { run, log } = build({ hubs: [] });
    await run();
    await run();
    assert.deepEqual(log.messages('info'), ['no hubs selected (SHADOW_HUBS is empty): the shadow mode analyses nothing']);
    assert.deepEqual(commands.filter((entry) => !['hello', 'isMaster', 'ping'].includes(entry.name)), []);
  });

  it('analyses a record into a report without the XML, and writes nothing but the reports and their indexes', async () => {
    const record = await seedRecord(world, ARUBA);
    await seedRecord(world, `${ARUBA}__${new ObjectId().toHexString()}`);
    const before = await snapshot();
    const { run, log } = build({ hubs: '*' });
    await run();
    assert.deepEqual(await snapshot(), before, 'queue, history, limiters, accounts and group documents are untouched');
    const written = commands.filter((entry) => WRITES.has(entry.name));
    assert.ok(written.length > 0);
    for (const entry of written) {
      assert.deepEqual([entry.db, entry.collection], [commonDatabaseName(world.names), SHADOW_COLLECTION], `${entry.name} on ${entry.db}.${entry.collection}`);
    }
    const [report] = await reportsOf();
    assert.ok(report !== undefined);
    assert.equal((await reportsOf()).length, 2);
    const mine = (await reportsOf()).find((entry) => entry.queueId.equals(record['_id'] as ObjectId)) as ShadowReport;
    assert.deepEqual(
      { ...mine, queueId: undefined, groupId: undefined, analysedAt: undefined, xmlBytes: undefined, xmlSha256: undefined, _id: undefined },
      { hub: ARUBA, documentType: 'TD01', number: '42', date: '2026-11-27', outcome: 'ok', issues: [], codeVersion: '0.1.0+test', queueId: undefined, groupId: undefined, analysedAt: undefined, xmlBytes: undefined, xmlSha256: undefined, _id: undefined },
    );
    assert.equal(mine.groupId, (record['groupId'] as ObjectId).toHexString());
    assert.equal(mine.analysedAt.getTime(), T0);
    assert.ok((mine.xmlBytes ?? 0) > 1_000);
    assert.match(mine.xmlSha256 ?? '', /^[0-9a-f]{64}$/);
    const text = JSON.stringify(mine);
    assert.doesNotMatch(text, /Caff|Rossi|Mario|Bar Esempio|Via Roma|<\?xml/, 'no buyer, seller or file content in the report');
    assert.deepEqual(Object.keys(mine).sort(), ['_id', 'analysedAt', 'codeVersion', 'date', 'documentType', 'groupId', 'hub', 'issues', 'number', 'outcome', 'queueId', 'xmlBytes', 'xmlSha256']);
    assert.deepEqual(log.messages('info'), ['shadow round']);
    const indexes = (await reportsCollection.indexes()).map((index) => `${index.name}:${index.expireAfterSeconds ?? ''}:${index.unique === true}`);
    assert.deepEqual(indexes.sort(), ['_id_::false', 'shadow_queue_version::true', 'shadow_ttl:2592000:false']);
    assert.equal(world.queue.collectionName, 'documents');
    assert.ok(!(await world.queue.indexes()).some((index) => String(index.name).startsWith('einvoicingWorker')), 'no queue index was created');
  });

  it('hashes the file that the upload would send', async () => {
    const record = await seedRecord(world, ARUBA);
    const { run } = build();
    await run();
    const [report] = await reportsOf();
    const { prepareInvoice } = await import('../../src/engine/prepare.ts');
    const store = createGroupStore(world.client, world.names);
    const prepared = await prepareInvoice(record, { transmitter: SHADOW_TRANSMITTERS.get(ARUBA) as { IdPaese: string; IdCodice: string }, groups: store, lookup: async () => 'unique', now: T0 });
    assert.ok(prepared.ok);
    assert.equal(report?.xmlSha256, createHash('sha256').update(prepared.file.xml, 'utf8').digest('hex'));
    assert.equal(report?.xmlBytes, Buffer.byteLength(prepared.file.xml, 'utf8'));
  });

  it('looks at what the legacy has not sent and at what it has uploaded, never at what it refused or marked sent without a file id', async () => {
    const pending = await seedRecord(world, ARUBA);
    const uploaded = await seedRecord(world, ARUBA, { sent: true, hubId: 'legacy-file.xml' });
    await seedRecord(world, ARUBA, { error: { errorCode: 'X' } });
    await seedRecord(world, ARUBA, { sent: true });
    await seedRecord(world, 'other', {});
    await world.queue.insertOne({ _id: 'text-id' as unknown as ObjectId, company: { fattura_elettronica: { hub: ARUBA } } });
    const { run } = build();
    await run();
    assert.deepEqual((await reportsOf()).map((entry) => entry.queueId.toHexString()).sort(), [pending['_id'], uploaded['_id']].map((id) => (id as ObjectId).toHexString()).sort());
  });

  it('follows SHADOW_HUBS: a list, a dealer hub, or every hub, and skips a provider without transmitter once', async () => {
    const dealerHub = `${ARUBA}__${new ObjectId().toHexString()}`;
    await seedRecord(world, ARUBA);
    await seedRecord(world, dealerHub);
    await seedRecord(world, 'other');
    await seedRecord(world, 'Bad Hub!');
    await world.queue.insertOne({ _id: new ObjectId(), company: { fattura_elettronica: {} } });
    const only = build({ hubs: [dealerHub] });
    await only.run();
    assert.deepEqual((await reportsOf()).map((entry) => entry.hub), [dealerHub]);
    const all = build({ hubs: '*', codeVersion: 'all' });
    await all.run();
    await all.run();
    assert.equal((await reportsOf()).filter((entry) => entry.codeVersion === 'all').length, 2, 'the provider without transmitter and the malformed hubs have no report');
    assert.deepEqual(all.log.messages('warn'), ['shadow: records skipped', 'shadow: records skipped']);
    const reasons = all.log.entries().filter((entry) => entry['message'] === 'shadow: records skipped').map((entry) => `${entry['reason']}:${entry['hub'] ?? ''}`);
    assert.deepEqual(reasons.sort(), ['hub:', 'provider:other']);
  });

  it('is idempotent per code version: a second round reads nothing again, a new version analyses everything again', async () => {
    await seedRecord(world, ARUBA);
    await seedRecord(world, ARUBA);
    const first = build();
    await first.run();
    assert.equal(first.reads.length, 2);
    const again = build();
    await again.run();
    assert.deepEqual(again.reads, [], 'already reported records are not read');
    assert.equal((await reportsOf()).length, 2);
    await first.run();
    assert.equal(first.reads.length, 2, 'the watermark already passed them');
    const next = build({ codeVersion: '0.1.1+test' });
    await next.run();
    assert.equal(next.reads.length, 2);
    assert.equal((await reportsOf()).length, 4);
    await reports.save({ ...(await reportsOf())[0] as ShadowReport, outcome: 'blocked' });
    assert.equal((await reportsOf()).length, 4);
    assert.ok((await reportsOf()).every((entry) => entry.outcome === 'ok'), 'an existing report is left untouched');
  });

  it('analyses at most the batch per round, oldest first, and picks up where it stopped; new records are seen later', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(((await seedRecord(world, ARUBA)) as { _id: ObjectId })._id.toHexString());
    }
    const { run, log } = build({ batch: 2 });
    const counts: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      await run();
      counts.push((await reportsOf()).length);
    }
    assert.deepEqual(counts, [2, 4, 5]);
    assert.deepEqual((await reportsOf()).map((entry) => entry.queueId.toHexString()), ids);
    await run();
    assert.equal((await reportsOf()).length, 5);
    await seedRecord(world, ARUBA);
    await run();
    assert.equal((await reportsOf()).length, 6);
    assert.equal(log.messages('info').filter((message) => message === 'shadow round').length, 4);
  });

  it('ignores records older than the look-back, and a watermark that fell behind it', async () => {
    const old = await seedRecord(world, ARUBA);
    const oldId = ObjectId.createFromTime(Math.floor(T0 / 1000) - 60 * 86_400);
    await world.queue.deleteOne({ _id: old['_id'] });
    await world.queue.insertOne({ ...old, _id: oldId });
    const recent = await seedRecord(world, ARUBA);
    const clock = createClock(Date.now());
    const { run } = build({ clock: clock.now, lookbackDays: 30 });
    await run();
    assert.deepEqual((await reportsOf()).map((entry) => entry.queueId.toHexString()), [(recent['_id'] as ObjectId).toHexString()]);
    clock.advance(40 * 86_400_000);
    const again = await seedRecord(world, ARUBA);
    await run();
    assert.equal((await reportsOf()).length, 1, 'now every record is older than the look-back');
    assert.ok(again !== undefined);
  });

  it('stops at the round budget and when aborted', async () => {
    await seedRecord(world, ARUBA);
    await seedRecord(world, ARUBA);
    let now = 0;
    const slow = build({ budgetMs: 1_000, clock: () => (now += 300) });
    await slow.run();
    assert.equal((await reportsOf()).length, 1, 'the second record is left for the next round');
    const controller = new AbortController();
    controller.abort();
    await slow.run(controller.signal);
    assert.equal((await reportsOf()).length, 1);
    now = 0;
    await slow.run();
    assert.equal((await reportsOf()).length, 2);
  });

  it('reports every outcome: warnings, blocked by a validation error or a duplicate or the size, and a record that cannot be mapped', async () => {
    const warned = await seedRecord(world, ARUBA, { type: 'credit-note', 'fattura_elettronica.tipo': 'TD04', fromDocumentId: new ObjectId() });
    const future = await seedRecord(world, ARUBA, { date: '2027-01-15T10:00:00.000Z' });
    const duplicate = await seedRecord(world, ARUBA, { number: 99 });
    await world.sent.insertOne({ key: `["IT${SELLER_A}","99","2026","other"]`, queueId: new ObjectId(), hub: ARUBA, providerId: 'p', sentAt: new Date(T0), released: false });
    const huge = await seedRecord(world, ARUBA, { note: 'causale '.repeat(700_000), number: 100 });
    const broken = await seedRecord(world, ARUBA, { records: 'not-a-list', 'fattura_elettronica.tipo': 'TD01' });
    const { run } = build();
    await run();
    const by = new Map((await reportsOf()).map((entry) => [entry.queueId.toHexString(), entry]));
    const of = (record: Document): ShadowReport => by.get((record['_id'] as ObjectId).toHexString()) as ShadowReport;
    assert.deepEqual([of(warned).outcome, of(warned).issues], ['warnings', [{ code: 'LINKED', path: 'FatturaElettronicaBody[0].DatiGenerali.DatiFattureCollegate', severity: 'warning' }]]);
    assert.ok((of(warned).xmlBytes ?? 0) > 0);
    assert.equal(of(future).outcome, 'blocked');
    assert.ok(of(future).issues.some((entry) => entry.code === '00403' && entry.severity === 'error'));
    assert.equal(of(future).xmlBytes, null);
    assert.equal(of(future).number, '42');
    assert.deepEqual([of(duplicate).outcome, of(duplicate).issues.map((entry) => entry.code)], ['blocked', ['00404']]);
    assert.deepEqual([of(huge).outcome, of(huge).issues.map((entry) => entry.code)], ['blocked', ['SIZE']]);
    assert.ok((of(huge).xmlBytes ?? 0) > 5_000_000);
    assert.match(of(huge).xmlSha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(of(broken).outcome, 'mappingFailed');
    assert.equal(of(broken).documentType, 'TD01');
    assert.deepEqual([of(broken).number, of(broken).date, of(broken).xmlBytes, of(broken).xmlSha256], [null, null, null, null]);
    assert.ok(of(broken).issues.length > 0 && of(broken).issues.every((entry) => entry.code === 'MAPPING'));
    for (const report of by.values()) {
      assert.deepEqual(Object.keys(report.issues[0] ?? { code: 0, path: 0, severity: 0 }).sort(), ['code', 'path', 'severity']);
    }
  });

  it('keeps a bounded number of issues per report', async () => {
    await seedRecord(world, ARUBA, { records: Array.from({ length: 80 }, () => ({ name: 'x' })) });
    const { run } = build();
    await run();
    const [report] = await reportsOf();
    assert.equal(report?.outcome, 'mappingFailed');
    assert.equal(report?.issues.length, 50);
  });

  it('retries a record whose analysis failed, then reports it as ANALYSIS_ERROR and goes on', async () => {
    const first = await seedRecord(world, ARUBA);
    await seedRecord(world, ARUBA);
    let failing = true;
    const { run, log } = build({
      lookupFor: () => async () => {
        if (failing) {
          throw Object.assign(new Error('secret detail'), { code: 11 });
        }
        return 'unique';
      },
    });
    for (let attempt = 1; attempt < MAX_ANALYSIS_ATTEMPTS; attempt += 1) {
      await run();
      assert.equal((await reportsOf()).length, 0, 'the round stopped at the record, which stays to retry');
    }
    await run();
    const reached = await reportsOf();
    assert.equal(reached.length, 1, 'the third failure leaves a report and the walk goes on, then the next record fails once');
    assert.deepEqual([reached[0]?.queueId.toHexString(), reached[0]?.outcome, reached[0]?.issues], [(first['_id'] as ObjectId).toHexString(), 'blocked', [{ code: 'ANALYSIS_ERROR', path: '', severity: 'error' }]]);
    failing = false;
    await run();
    assert.equal((await reportsOf()).length, 2);
    const errors = log.entries().filter((entry) => entry['level'] === 'error');
    assert.equal(errors.length, MAX_ANALYSIS_ATTEMPTS + 1);
    assert.doesNotMatch(log.lines.join(''), /secret detail/);
    assert.equal(errors[0]?.['errorCode'], 11);
  });

  it('skips a record that disappears between the scan and the read', async () => {
    const record = await seedRecord(world, ARUBA);
    const { job, log } = build();
    const store = createShadowQueue(queueCollection());
    const vanishing = createShadowJob({
      queue: { idsAfter: store.idsAfter, read: async () => null },
      reports,
      groups: { readOriginal: async () => null },
      lookupFor: () => async () => 'unique',
      hubs: [ARUBA],
      batch: 5,
      lookbackDays: 30,
      codeVersion: 'v',
      budgetMs: 1_000,
      logger: log.logger,
      clock: Date.now,
    });
    await vanishing.run({ epoch: 1, signal: new AbortController().signal });
    assert.equal((await reportsOf()).length, 0);
    assert.ok(job.name === 'shadow' && record !== undefined);
  });

  describe('the helpers', () => {
    it('builds the report of a record that kept failing, from what the record says', () => {
      const id = new ObjectId();
      const report = failedReport({ _id: id, groupId: 'a'.repeat(24), fattura_elettronica: { tipo: 'TD04' } }, ARUBA, { codeVersion: 'v', now: T0 });
      assert.deepEqual([report.documentType, report.groupId, report.outcome], ['TD04', 'a'.repeat(24), 'blocked']);
      const bare = failedReport({ _id: id, groupId: 'nope' }, ARUBA, { codeVersion: 'v', now: T0 });
      assert.deepEqual([bare.documentType, bare.groupId], [null, null]);
    });

    it('reads the hub of a record only when it is well formed', () => {
      assert.equal(hubOf({ company: { fattura_elettronica: { hub: 'aruba' } } }), 'aruba');
      for (const record of [{}, { company: {} }, { company: { fattura_elettronica: { hub: 'Bad' } } }, { company: { fattura_elettronica: { hub: 3 } } }]) {
        assert.equal(hubOf(record), undefined);
      }
    });

    it('takes the group of a record as an ObjectId or as text', async () => {
      const groupId = new ObjectId();
      const record: Document = { ...withValues(baseRecord(), { 'company.fattura_elettronica.hub': ARUBA, ...sellerFields(SELLER_A) }), _id: new ObjectId(), groupId };
      const options = { transmitters: SHADOW_TRANSMITTERS, groups: { readOriginal: async () => null }, lookupFor: () => async () => 'unique' as const, now: T0, codeVersion: 'v' };
      const asObject = await analyseRecord(record, options);
      const asText = await analyseRecord({ ...record, groupId: groupId.toHexString() }, options);
      assert.ok(asObject.kind === 'report' && asText.kind === 'report');
      assert.equal(asObject.report.groupId, groupId.toHexString());
      assert.equal(asText.report.groupId, groupId.toHexString());
    });
  });
});
