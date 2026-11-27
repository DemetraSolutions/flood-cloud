import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryLogger } from '../helpers/app.ts';
import { accessFor } from '../helpers/group-access.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { inGroupTransaction, sessionDatabases } from '../../src/db/session-databases.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { readNumberingSetup } from '../../src/shared/security/scope/group-mirror.ts';
import { createNumberingIndexGuard, createNumberingIndexes, DOCUMENTS_DATE_INDEX, DOCUMENTS_NUMBER_INDEX, NUMBERING_COUNTERS_INDEX } from '../../src/modules/document-numbering/numbering.indexes.ts';
import { createNumberingRepository } from '../../src/modules/document-numbering/numbering.repository.ts';
import { createNumberingService } from '../../src/modules/document-numbering/numbering.service.ts';
import type { NumberingService, ReserveNumberInput } from '../../src/modules/document-numbering/numbering.service.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const D2026 = new Date('2026-06-15T10:00:00Z');
const D2025 = new Date('2025-06-15T10:00:00Z');

describe('the numbering of the fiscal documents on a real database', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  /** A group with a company and a point of sale (copies in the common database), the guard of the indexes and the service; every test has its own. */
  async function world(options: { company?: Document; place?: Document } = {}) {
    const groupId = new ObjectId();
    const companyId = new ObjectId();
    const placeId = new ObjectId();
    await ctx.databases.common().collection('groups').insertOne({ _id: groupId });
    await ctx.databases.common().collection('companies').insertOne({ _id: companyId, groupId, name: 'Acme', ...options.company });
    await ctx.databases.common().collection('places').insertOne({ _id: placeId, groupId, companyId, name: 'Shop', timezone: 'Europe/Rome', ...options.place });
    const db = ctx.databases.group(groupId, 'cluster0');
    const principal = principalOf('SA', { groupId });
    const access = (await accessFor(principal, groupId))! as GroupAccess;
    const logs = memoryLogger();
    const indexes = createNumberingIndexGuard(ctx.databases, logs.logger);
    const service = createNumberingService({ databases: ctx.databases, indexes, now: () => NOW });
    const documents = (rows: Document[]) => db.collection('documents').insertMany(rows.map((row) => ({ companyId, type: 'invoice', prefixSuffix: '', date: D2026, ...row })));
    const counters = (filter: Document = {}) => db.collection('document_counters').find(filter).toArray();
    const input = (extra: Partial<ReserveNumberInput> = {}): ReserveNumberInput => ({ companyId, placeId, series: 'invoice', date: D2026, ...extra });
    const reserve = (extra: Partial<ReserveNumberInput> = {}) => service.reserveNumber(principal, access, input(extra));
    const progressive = (date = D2026) => service.reserveSendProgressive(principal, access, { companyId, placeId, date });
    return { groupId, companyId, placeId, db, principal, access, logs, indexes, service, documents, counters, input, reserve, progressive };
  }

  it('starts the first year from the last invoice number issued outside Flood, only for the invoices without a sectional, and goes on from there', async () => {
    const w = await world({ company: { settings: { global: { lastInvoiceNumber: 41 } } } });
    const first = await w.reserve();
    assert.deepEqual(first, { number: 42, prefixSuffix: '', prefixSuffixPosition: null, year: 2026, anomalies: [] });
    assert.equal((await w.reserve()).number, 43);
    // The credit notes are another series: no base.
    assert.equal((await w.reserve({ series: 'credit-note' })).number, 1);
    const [counter] = await w.counters({ series: 'invoice' });
    assert.deepEqual([counter!['companyId'], counter!['prefixSuffix'], counter!['year'], counter!['last'], counter!['insertDate'], counter!['updateDate']], [w.companyId, '', 2026, 43, new Date(NOW), new Date(NOW)]);
  });

  it('gives no base to an invoice with a sectional, and prints the sectional of the point of sale where the company says', async () => {
    const w = await world({ company: { invoicesPS: 'prefix', invoicesPSValues: [{ name: 'A', cash: false }, { name: 'WEB', cash: true }], settings: { global: { lastInvoiceNumber: 41 } } }, place: { invoicePS: 'A' } });
    assert.deepEqual(await w.reserve(), { number: 1, prefixSuffix: 'A', prefixSuffixPosition: 'prefix', year: 2026, anomalies: [] });
    // Another point of sale of the company, with no choice, uses the sectional of the cash desks, which is another counter.
    const other = new ObjectId();
    await ctx.databases.common().collection('places').insertOne({ _id: other, groupId: w.groupId, companyId: w.companyId, timezone: 'Europe/Rome' });
    assert.equal((await w.service.reserveNumber(w.principal, w.access, w.input({ placeId: other }))).prefixSuffix, 'WEB');
    assert.equal((await w.reserve()).number, 2);
    // A sectional the company does not have goes around to the one of the cash desks, with the anomaly, and the sale is not refused.
    await ctx.databases.common().collection('places').updateOne({ _id: w.placeId }, { $set: { invoicePS: 'GONE', timezone: 'Not/AZone' } });
    const gone = await w.reserve();
    assert.deepEqual([gone.number, gone.prefixSuffix, gone.anomalies], [2, 'WEB', [{ code: 'prefixSuffixMissing' }, { code: 'timezoneInvalid' }]]);
  });

  it('aligns the counter with the highest number the legacy wrote in the year, with the sectional stored as an empty text, missing or null', async () => {
    const w = await world({ company: { settings: { global: { lastInvoiceNumber: 3 } } } });
    await w.documents([
      { number: 7 },
      { number: 12, prefixSuffix: undefined },
      { number: 9, prefixSuffix: null },
      // Not counted: another year, another company, another type, another sectional, a text number.
      { number: 500, date: D2025 },
      { number: 501, companyId: new ObjectId() },
      { number: 502, type: 'credit-note' },
      { number: 503, prefixSuffix: 'A' },
      { number: '600' },
    ]);
    // `prefixSuffix: undefined` is not stored by the driver by default; a document with the field really missing is the legacy's.
    await w.db.collection('documents').insertOne({ companyId: w.companyId, type: 'invoice', date: D2026, number: 20 });
    const next = await w.reserve();
    // The year has documents, so the base is not used.
    assert.equal(next.number, 21);
    // The legacy goes on in between: the next number follows its document.
    await w.documents([{ number: 30 }]);
    assert.equal((await w.reserve()).number, 31);
    await w.documents([{ number: 3, prefixSuffix: 'A' }, { number: 40, prefixSuffix: 'A' }]);
    assert.equal((await w.reserve()).number, 32);
  });

  it('keeps the series, the sectionals and the companies apart, and restarts every year', async () => {
    const w = await world({ company: { invoicesPS: 'suffix', invoicesPSValues: [{ name: 'A', cash: false }, { name: 'B', cash: false }] } });
    await ctx.databases.common().collection('places').updateOne({ _id: w.placeId }, { $set: { invoicePS: 'A' } });
    assert.deepEqual([(await w.reserve()).number, (await w.reserve()).number, (await w.reserve({ series: 'credit-note' })).number], [1, 2, 1]);
    await ctx.databases.common().collection('places').updateOne({ _id: w.placeId }, { $set: { invoicePS: 'B' } });
    assert.deepEqual([(await w.reserve()).number, (await w.reserve({ date: D2025 })).number, (await w.reserve({ date: D2025 })).number, (await w.reserve()).number], [1, 1, 2, 2]);
    const other = new ObjectId();
    const otherPlace = new ObjectId();
    await ctx.databases.common().collection('companies').insertOne({ _id: other, groupId: w.groupId, name: 'Other' });
    await ctx.databases.common().collection('places').insertOne({ _id: otherPlace, groupId: w.groupId, companyId: other });
    assert.equal((await w.service.reserveNumber(w.principal, w.access, { companyId: other, placeId: otherPlace, series: 'invoice', date: D2026 })).number, 1);
    assert.equal((await w.counters()).length, 5);
  });

  it('reads the year in the time zone of the point of sale: 23:30 and 00:30 on New Year in Rome are two years', async () => {
    const w = await world();
    const before = await w.reserve({ date: new Date('2026-12-31T22:30:00Z') });
    const after = await w.reserve({ date: new Date('2026-12-31T23:30:00Z') });
    assert.deepEqual([before.year, before.number, after.year, after.number], [2026, 1, 2027, 1]);
    // A document the legacy dated in the first minutes of the new year in Rome belongs to the new year.
    await w.documents([{ number: 8, date: new Date('2026-12-31T23:10:00Z') }]);
    assert.equal((await w.reserve({ date: new Date('2027-03-01T10:00:00Z') })).number, 9);
    // With no time zone the same hour is read in Rome, with the anomaly.
    await ctx.databases.common().collection('places').updateOne({ _id: w.placeId }, { $unset: { timezone: '' } });
    assert.deepEqual((await w.reserve({ date: new Date('2026-12-31T23:30:00Z') })).anomalies, [{ code: 'timezoneInvalid' }]);
    // In New York the same instant is still in the year that ends.
    await ctx.databases.common().collection('places').updateOne({ _id: w.placeId }, { $set: { timezone: 'America/New_York' } });
    assert.equal((await w.reserve({ date: new Date('2026-12-31T23:30:00Z') })).year, 2026);
  });

  it('uses the last invoice number of the company only the first year it numbers: the years after restart from 1', async () => {
    const w = await world({ company: { settings: { global: { lastInvoiceNumber: 100 } } } });
    assert.equal((await w.reserve({ date: D2025 })).number, 101);
    assert.equal((await w.reserve()).number, 1);
    // A company that has only the documents of the legacy of an earlier year is in the same case.
    const legacy = await world({ company: { settings: { global: { lastInvoiceNumber: 100 } } } });
    await legacy.documents([{ number: 150, date: D2025 }]);
    assert.equal((await legacy.reserve()).number, 1);
    // The sectional of a document other than the invoice ones does not matter: a legacy document with a sectional is another series of numbers.
    const sectional = await world({ company: { settings: { global: { lastInvoiceNumber: 100 } } } });
    await sectional.documents([{ number: 150, date: D2025, prefixSuffix: 'A' }]);
    assert.equal((await sectional.reserve()).number, 101);
  });

  it('ignores a last invoice number that is not a number', async () => {
    const w = await world({ company: { settings: { global: { lastInvoiceNumber: 'many' } } } });
    assert.equal((await w.reserve()).number, 1);
    const none = await world({ company: { settings: {} } });
    assert.equal((await none.reserve()).number, 1);
  });

  it('gives different and consecutive numbers to twenty concurrent reservations, each in its own transaction', async () => {
    const w = await world({ company: { settings: { global: { lastInvoiceNumber: 10 } } } });
    const numbers = (await Promise.all(Array.from({ length: 20 }, () => w.reserve()))).map((result) => result.number);
    assert.deepEqual([...numbers].sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => 11 + index));
    assert.equal((await w.counters()).length, 1);
    assert.equal((await w.counters())[0]!['last'], 30);
  });

  it('serializes the concurrent reservations with a document of the legacy written in the middle', async () => {
    const w = await world();
    const batch = (size: number) => Array.from({ length: size }, () => w.reserve());
    const first = await Promise.all(batch(10));
    // The legacy emits number 50 now; a batch reserved while it is written goes on from it, never repeating one.
    const [, ...second] = await Promise.all([w.documents([{ number: 50 }]), ...batch(10)]);
    const numbers = [...first, ...second.flat()].map((result) => result.number);
    assert.equal(new Set(numbers).size, 20);
    const after = await w.reserve();
    assert.ok(after.number > 50, String(after.number));
    assert.ok(!numbers.includes(50));
  });

  it('numbers the sending of the electronic invoices once for the company and the year, across every type and sectional, aligned with the legacy', async () => {
    const w = await world();
    assert.deepEqual(await w.progressive(), { progressive: 1, year: 2026, anomalies: [] });
    await w.documents([
      { number: 1, fattura_elettronica: { progressivo_invio: 14 } },
      { number: 1, type: 'credit-note', prefixSuffix: 'A', fattura_elettronica: { progressivo_invio: 20 } },
      // Not counted: another year, another company, a text, a document with no sending.
      { number: 2, date: D2025, fattura_elettronica: { progressivo_invio: 900 } },
      { number: 3, companyId: new ObjectId(), fattura_elettronica: { progressivo_invio: 901 } },
      { number: 4, fattura_elettronica: { progressivo_invio: '902' } },
      { number: 5, fattura_elettronica: {} },
    ]);
    assert.equal((await w.progressive()).progressive, 21);
    // It is not the number of the invoice, and the number of the invoice is not consumed by it.
    assert.equal((await w.reserve()).number, 6);
    assert.equal((await w.progressive()).progressive, 22);
    assert.equal((await w.progressive(D2025)).progressive, 901);
    const numbers = (await Promise.all(Array.from({ length: 20 }, () => w.progressive()))).map((result) => result.progressive);
    assert.deepEqual([...numbers].sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => 23 + index));
    // The progressive of the sending has its own series and an empty sectional.
    assert.deepEqual((await w.counters({ series: '_sendProgressive' })).map((counter) => [counter['prefixSuffix'], counter['year']]).sort(), [['', 2025], ['', 2026]]);
    // And it follows the time zone of the point of sale.
    await ctx.databases.common().collection('places').updateOne({ _id: w.placeId }, { $set: { timezone: 'Mars/Phobos' } });
    assert.deepEqual((await w.progressive(new Date('2026-12-31T23:30:00Z'))).anomalies, [{ code: 'timezoneInvalid' }]);
  });

  it('joins the transaction of the caller when nested, and the number is not consumed when the caller aborts', async () => {
    const w = await world();
    const abort = new Error('the sale failed');
    await w.service.ensureIndexes(w.principal, w.access);
    const nestedIn = (session: Parameters<Parameters<typeof inGroupTransaction>[3]>[0]): NumberingService => createNumberingService({ databases: sessionDatabases(ctx.databases, session, w.groupId), nested: true, indexes: w.indexes, now: () => NOW });
    await assert.rejects(
      inGroupTransaction(w.principal, w.access, ctx.databases, async (session) => {
        const nested = nestedIn(session);
        assert.equal((await nested.reserveNumber(w.principal, w.access, w.input())).number, 1);
        assert.equal((await nested.reserveSendProgressive(w.principal, w.access, { companyId: w.companyId, placeId: w.placeId, date: D2026 })).progressive, 1);
        // What the transaction wrote is read back inside it: the next reservation follows.
        assert.equal((await nested.reserveNumber(w.principal, w.access, w.input())).number, 2);
        throw abort;
      }),
      (error: unknown) => error === abort,
    );
    assert.deepEqual(await w.counters(), []);
    // Nothing was consumed: the first number is still the first, and a committed transaction keeps it.
    await inGroupTransaction(w.principal, w.access, ctx.databases, async (session) => {
      assert.equal((await nestedIn(session).reserveNumber(w.principal, w.access, w.input())).number, 1);
    });
    assert.equal((await w.reserve()).number, 2);
  });

  it('refuses to run in a transaction of the caller before the indexes were confirmed, and when they cannot be created', async () => {
    const w = await world();
    await assert.rejects(
      inGroupTransaction(w.principal, w.access, ctx.databases, async (session) => {
        await createNumberingService({ databases: sessionDatabases(ctx.databases, session, w.groupId), nested: true, indexes: w.indexes, now: () => NOW }).reserveNumber(w.principal, w.access, w.input());
      }),
      /unique index of the counters/,
    );
    const broken = createNumberingService({ databases: ctx.databases, indexes: { ensure: async () => false, confirmed: () => false }, now: () => NOW });
    await assert.rejects(broken.ensureIndexes(w.principal, w.access), /unique index of the counters/);
    await assert.rejects(broken.reserveNumber(w.principal, w.access, w.input()), /unique index of the counters/);
    await assert.rejects(broken.reserveSendProgressive(w.principal, w.access, { companyId: w.companyId, placeId: w.placeId, date: D2026 }), /unique index of the counters/);
    assert.deepEqual(await w.counters(), []);
  });

  it('has a unique index on the counters, and the two supporting indexes on the documents, created by the guard', async () => {
    const w = await world();
    await w.reserve();
    const counters = await w.db.collection('document_counters').indexes();
    const unique = counters.find((entry) => entry.name === NUMBERING_COUNTERS_INDEX.options.name)!;
    assert.deepEqual([unique.key, unique.unique], [{ companyId: 1, series: 1, prefixSuffix: 1, year: 1 }, true]);
    const [counter] = await w.counters();
    await assert.rejects(w.db.collection('document_counters').insertOne({ ...counter!, _id: new ObjectId() }), (error: unknown) => (error as { code?: number }).code === 11000);
    const documents = await w.db.collection('documents').indexes();
    const support = (name: string) => documents.find((entry) => entry.name === name)!;
    assert.deepEqual([support(DOCUMENTS_NUMBER_INDEX.options.name).key, support(DOCUMENTS_NUMBER_INDEX.options.name).unique], [{ companyId: 1, type: 1, prefixSuffix: 1, date: -1 }, undefined]);
    assert.deepEqual([support(DOCUMENTS_DATE_INDEX.options.name).key, support(DOCUMENTS_DATE_INDEX.options.name).unique], [{ companyId: 1, date: -1 }, undefined]);
  });

  it('never reaches the company or the point of sale of another group, or a point of sale of another company', async () => {
    const mine = await world();
    const theirs = await world();
    await assert.rejects(mine.service.reserveNumber(mine.principal, mine.access, mine.input({ companyId: theirs.companyId })), /not of the group/);
    await assert.rejects(mine.service.reserveNumber(mine.principal, mine.access, mine.input({ placeId: theirs.placeId })), /not of the group/);
    await assert.rejects(mine.service.reserveSendProgressive(mine.principal, mine.access, { companyId: theirs.companyId, placeId: mine.placeId, date: D2026 }), /not of the group/);
    // A point of sale of the group that belongs to another company of the group, or has no company.
    const stranger = new ObjectId();
    await ctx.databases.common().collection('companies').insertOne({ _id: stranger, groupId: mine.groupId, name: 'Stranger' });
    await assert.rejects(mine.service.reserveNumber(mine.principal, mine.access, mine.input({ companyId: stranger })), /not of the group/);
    const orphan = new ObjectId();
    await ctx.databases.common().collection('places').insertOne({ _id: orphan, groupId: mine.groupId, name: 'Orphan' });
    await assert.rejects(mine.service.reserveNumber(mine.principal, mine.access, mine.input({ placeId: orphan })), /not of the group/);
    assert.deepEqual([await mine.counters(), await theirs.counters()], [[], []]);
    // The two groups number on their own.
    assert.deepEqual([(await mine.reserve()).number, (await theirs.reserve()).number], [1, 1]);
  });

  it('refuses what a caller must have guaranteed: ids, series and date', async () => {
    const w = await world();
    const bad = (extra: object) => w.service.reserveNumber(w.principal, w.access, { ...w.input(), ...extra } as ReserveNumberInput);
    await assert.rejects(bad({ companyId: w.companyId.toHexString() }), RangeError);
    await assert.rejects(bad({ placeId: 'x' }), RangeError);
    await assert.rejects(bad({ series: 'receipt' }), RangeError);
    await assert.rejects(bad({ date: new Date(NaN) }), RangeError);
    await assert.rejects(w.service.reserveSendProgressive(w.principal, w.access, { companyId: w.companyId, placeId: 'x' as never, date: D2026 }), RangeError);
    assert.deepEqual(await w.counters(), []);
  });

  it('reads only the fields the numbering needs, of a company and a place of the group, and refuses what is not an id', async () => {
    const w = await world({ company: { invoicesPS: 'prefix', iban: 'SECRET' }, place: { invoicePS: 'A', integrations: { secret: 1 } } });
    const read = await readNumberingSetup(w.principal, w.access, ctx.databases, w.companyId, w.placeId);
    assert.deepEqual(Object.keys(read.company!).sort(), ['_id', 'invoicesPS']);
    assert.deepEqual(Object.keys(read.place!).sort(), ['_id', 'companyId', 'invoicePS', 'timezone']);
    await assert.rejects(readNumberingSetup(w.principal, w.access, ctx.databases, 'x' as never, w.placeId), /needs the ids/);
    await assert.rejects(readNumberingSetup(w.principal, w.access, ctx.databases, w.companyId, 'x' as never), /needs the ids/);
  });

  it('reads with a time limit', async () => {
    const w = await world();
    const repository = createNumberingRepository(ctx.databases);
    assert.equal(await repository.maxNumber(w.principal, w.access, { companyId: w.companyId, type: 'invoice', prefixSuffix: 'Z', start: D2025, end: D2026 }), null);
    assert.equal(await repository.maxSendProgressive(w.principal, w.access, { companyId: w.companyId, start: D2025, end: D2026 }), null);
  });
});

describe('the indexes of the numbering', () => {
  const fakeDb = (fails: Record<string, unknown>, created: string[] = []) =>
    ({
      collection: (name: string) => ({
        createIndex: (key: object, options: { name: string }) => {
          created.push(`${name}:${options.name}`);
          return fails[name] === undefined ? Promise.resolve('name') : Promise.reject(fails[name]);
        },
      }),
    }) as never;

  it('creates the three indexes once per group and process, shares a creation in progress, and tries again after a failure', async () => {
    const logs = memoryLogger();
    const groupId = new ObjectId();
    const created: string[] = [];
    let fails: Record<string, unknown> = { document_counters: Object.assign(new Error('secret server text'), { code: 11000, codeName: 'DuplicateKey' }) };
    const databases = { group: () => fakeDb(fails, created) } as never;
    const principal = principalOf('SA', { groupId });
    const access = (await accessFor(principal, groupId))!;
    const guard = createNumberingIndexGuard(databases, logs.logger);
    assert.equal(guard.confirmed(access), false);
    assert.deepEqual(await Promise.all([guard.ensure(principal, access), guard.ensure(principal, access)]), [false, false]);
    assert.equal(created.length, 3);
    assert.equal(guard.confirmed(access), false);
    // A failure is not kept: the next call tries again, and once the unique index is there nothing is created again.
    fails = {};
    assert.equal(await guard.ensure(principal, access), true);
    assert.equal(created.length, 6);
    assert.equal(guard.confirmed(access), true);
    assert.equal(await guard.ensure(principal, access), true);
    assert.equal(created.length, 6);
    const errors = logs.events.filter((event) => event['level'] === 'error');
    assert.deepEqual([errors.length, errors[0]!['groupId'], errors[0]!['index'], errors[0]!['errorCode']], [1, groupId.toHexString(), NUMBERING_COUNTERS_INDEX.options.name, 11000]);
    assert.ok(!logs.lines.join('\n').includes('secret'));
  });

  it('treats an index that exists already or is being built as there, and a failure of a supporting index as not stopping the numbering', async () => {
    const logs = memoryLogger();
    const groupId = new ObjectId();
    const conflict = Object.assign(new Error('secret'), { codeName: 'IndexOptionsConflict', code: 85 });
    assert.equal(await createNumberingIndexes(fakeDb({ document_counters: conflict }), groupId, logs.logger), true);
    assert.equal(logs.events.filter((event) => event['level'] === 'info').length, 1);
    assert.equal(await createNumberingIndexes(fakeDb({ documents: 'plain text' }), groupId, logs.logger), true);
    const errors = logs.events.filter((event) => event['level'] === 'error');
    assert.deepEqual([errors.length, errors[0]!['errorCode']], [2, null]);
  });
});
