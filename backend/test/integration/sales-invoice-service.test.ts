import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { accessFor } from '../helpers/group-access.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { SALES_WAREHOUSE_RULES, saleBody, saleLine } from '../helpers/store-sales.ts';
import { createStoreContactsAudit } from '../../src/modules/store-contacts/store-contacts.audit.ts';
import { createNumberingIndexGuard } from '../../src/modules/document-numbering/numbering.indexes.ts';
import { createNumberingService } from '../../src/modules/document-numbering/numbering.service.ts';
import { createInvoiceGuard } from '../../src/modules/sales/sales.invoice.guard.ts';
import { createLoyaltyService } from '../../src/modules/loyalty/loyalty.service.ts';
import { createInvoiceRepository } from '../../src/modules/sales/sales.invoice.repository.ts';
import type { InvoiceRepository } from '../../src/modules/sales/sales.invoice.repository.ts';
import { createSalesWriteRepository } from '../../src/modules/sales/sales.write.repository.ts';
import { createSalesWriteRepository as createRealSalesRepository } from '../../src/modules/sales/sales.write.repository.ts';
import { MongoServerError } from 'mongodb';
import { createSalesKeyIndexGuard } from '../../src/modules/sales/sales.key-index.ts';
import { createSalesWriteService } from '../../src/modules/sales/sales.write.service.ts';
import type { SaleCreated, SalesWriteContext, SalesWriteDeps } from '../../src/modules/sales/sales.write.service.ts';
import { createStockIndexGuard } from '../../src/modules/stock/stock.indexes.ts';
import { createStockService } from '../../src/modules/stock/stock.service.ts';
import type { Request, Response } from 'express';
import { storeCallerOf } from '../../src/modules/store-catalog/store-catalog.service.ts';
import { requireStoreGroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { StorePrincipal } from '../../src/shared/security/scope/principal.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import { createSaleBody } from '../../src/modules/sales/sales.write.schemas.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');

/** The invoice of a sale driven through the service, with fakes where a failure must be made (step VS5): the branches the HTTP tests cannot reach. */
describe('the invoice of a sale in the service', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  async function world(options: { overrides?: Partial<SalesWriteDeps>; place?: Document; company?: Document | null; groups?: Document } = {}) {
    const groupId = new ObjectId();
    const placeId = new ObjectId();
    const companyId = new ObjectId();
    const cash = new ObjectId();
    const common = ctx.databases.common();
    await common.collection('groups').insertOne({ _id: groupId, settings: { warehouse: false }, warehouseRules: SALES_WAREHOUSE_RULES, ...options.groups });
    if (options.company !== null) {
      await common.collection('companies').insertOne({ _id: companyId, groupId, name: 'Acme', code: 'IT01234567890', fattura_elettronica: { hub: 'aruba' }, ...options.company });
    }
    await common.collection('places').insertOne({ _id: placeId, groupId, companyId, timezone: 'Europe/Rome', storages: [{ id: cash, cash: true }], ...options.place });
    const db = ctx.databases.group(groupId, 'cluster0');
    const caller = principalOf('SA', { groupId });
    const access = (await accessFor(caller, groupId))! as GroupAccess;
    const logs = memoryLogger();
    const activity = memoryActivityLog();
    const stockIndexes = createStockIndexGuard(ctx.databases, logs.logger);
    const numberingIndexes = createNumberingIndexGuard(ctx.databases, logs.logger);
    const service = createSalesWriteService({
      databases: ctx.databases,
      keyIndex: createSalesKeyIndexGuard(ctx.databases, logs.logger),
      stock: createStockService({ databases: ctx.databases, indexes: stockIndexes, now: () => NOW }),
      stockOver: (joined) => createStockService({ databases: joined, nested: true, indexes: stockIndexes, now: () => NOW }),
      loyaltyOver: (joined) => createLoyaltyService({ databases: joined, nested: true }),
      invoiceGuard: createInvoiceGuard({ rateLimiter: memoryRateLimiter(), activityLog: activity, logger: logs.logger, limits: { perMinute: 1000, perDay: 1000 } }),
      numbering: createNumberingService({ databases: ctx.databases, indexes: numberingIndexes, now: () => NOW }),
      numberingOver: (joined) => createNumberingService({ databases: joined, nested: true, indexes: numberingIndexes, now: () => NOW }),
      activityLog: activity,
      audit: createStoreContactsAudit({ activityLog: activity, rateLimiter: memoryRateLimiter(), logger: logs.logger, now: () => NOW, limits: { perOperation: 100, perDay: 1000 } }),
      storeUsers: { findUser: async () => null },
      logger: logs.logger,
      now: () => NOW,
      ...options.overrides,
    });
    const context: SalesWriteContext = { caller, access, companyId, placeId, request: { requestId: 'req-1', ip: null, userAgent: null }, store: null };
    const contact = new ObjectId();
    await db.collection('contacts').insertOne({ _id: contact, companyName: 'Buyer', fattura_elettronica: { formato_trasmissione: 'FPR12' }, account: { password: 'x' } });
    const body = (overrides: Document = {}) => validate(createSaleBody, JSON.parse(JSON.stringify(saleBody([saleLine(null)], { receiptType: 'invoice', customer: { contactId: contact.toHexString() }, ...overrides }))), '(body)');
    const queue = () => ctx.client.db(`${ctx.prefix}development_queue`).collection('documents');
    // The records of this group only (every world of the file shares the queue database).
    const queued = () => queue().countDocuments({ groupId });
    /** The same group, company and point of sale reached by a store key: a store caller with its principal and its verified access. */
    const keyId = new ObjectId();
    const principal: StorePrincipal = { kind: 'store', keyId, groupId, companyId, placeId, activatedAt: new Date(NOW), permissions: new Set(), scope: { kind: 'store', groupId, companyId, placeId } } as unknown as StorePrincipal;
    const storeRes = { locals: { store: principal } } as unknown as Response;
    await requireStoreGroupAccess({ findAccess: async (id) => ({ availability: 'available', group: { _id: id, dataCluster: 'cluster0' } }), resolveCluster: () => 'cluster0' })({} as Request, storeRes, () => undefined);
    const storeContext: SalesWriteContext = { caller: storeCallerOf(principal, null), access: storeRes.locals['groupAccess'] as GroupAccess, companyId, placeId, request: { requestId: 'req-2', ip: null, userAgent: null }, store: principal };
    return { db, caller, access, context, storeContext, service, logs, activity, body, queue, queued, groupId, placeId, companyId, contact };
  }

  it('keeps the sale and marks the document `notQueued` when the queue refuses the record, with a log that carries no data', async () => {
    const attempts: Document[] = [];
    const w = await world({
      overrides: { databases: { ...ctx.databases, queueInbox: () => ({ enqueue: async (record) => { attempts.push(record); throw new Error('queue down'); } }) } },
    });
    const created = await w.service.create(w.context, w.body());
    assert.equal(created.created, true);
    const result = created.result as SaleCreated;
    assert.deepEqual([result.invoice!.sendStatus, result.invoice!.number], ['notQueued', 1]);
    assert.deepEqual([(await w.db.collection('documents').findOne({}))!['sendStatus'], await w.db.collection('sales').countDocuments(), await w.queued(), attempts.length], ['notQueued', 1, 0, 1]);
    const line = w.logs.lines.find((entry) => /handing an invoice to the send queue failed/.test(entry))!;
    assert.ok(line);
    assert.equal(line.includes('Buyer'), false);
  });

  it('answers `queued` even when marking the document fails afterwards, and logs it', async () => {
    const w = await world({ overrides: { invoicesOver: (databases) => ({ ...createInvoiceRepository(databases), moveSendStatus: async () => Promise.reject(new Error('mark failed')) }) as InvoiceRepository } });
    const created = await w.service.create(w.context, w.body());
    assert.equal((created.result as SaleCreated).invoice!.sendStatus, 'queued');
    assert.equal(await w.queued(), 1);
    assert.ok(w.logs.lines.some((entry) => /marking an invoice as queued failed/.test(entry)));
  });

  it('answers 503 and saves nothing when the indexes of the numbering are not there, and makes no invoice number from a missing unique index', async () => {
    const w = await world({ overrides: { numbering: { ensureIndexes: () => Promise.reject(new Error('no index')) } } });
    await assert.rejects(() => w.service.create(w.context, w.body()), { code: 'SERVICE_UNAVAILABLE' });
    assert.deepEqual([await w.db.collection('sales').countDocuments(), await w.db.collection('documents').countDocuments()], [0, 0]);
    assert.ok(w.logs.lines.some((entry) => /indexes of the numbering of the invoices are not available/.test(entry)));
    // A sale that is not an invoice does not ask for them.
    const receipt = await w.service.create(w.context, w.body({ receiptType: 'receipt', timestampId: 'T-r' }));
    assert.equal((receipt.result as SaleCreated).invoice, null);
  });

  it('numbers nothing for a date outside the window of the invoices (from the 1st of January of the previous year to tomorrow) and tells the backoffice (422); reports a sectional the company no longer has', async () => {
    const w = await world({ company: { invoicesPS: 'suffix', invoicesPSValues: [{ name: 'W', cash: true }], fattura_elettronica: { hub: '' } }, place: { invoicePS: 'GONE', timezone: 'Not/AZone' } });
    for (const date of ['0001-01-01T00:00:00.000Z', '2024-12-31T22:59:00.000Z', '2026-11-29T13:00:00.000Z']) {
      await assert.rejects(
        () => w.service.create(w.context, w.body({ date, timestampId: `T-${date}` })),
        (error: { code: string; details: Document[] }) => error.code === 'VALIDATION_ERROR' && JSON.stringify(error.details) === JSON.stringify([{ field: 'date', issue: 'outOfRange' }]),
        date,
      );
    }
    assert.deepEqual([await w.db.collection('sales').countDocuments(), await w.db.collection('documents').countDocuments(), await w.db.collection('document_counters').countDocuments()], [0, 0, 0]);
    // The edges are inside: the 1st of January of the previous year (the time zone of the place is not valid: Europe/Rome is used) and tomorrow at this hour.
    for (const [index, date] of ['2024-12-31T23:00:00.000Z', '2026-11-28T11:59:00.000Z'].entries()) {
      const created = await w.service.create(w.context, w.body({ date, timestampId: `T-ok-${String(index)}` }));
      const result = created.result as SaleCreated;
      assert.deepEqual([result.invoice!.number, result.invoice!.prefixSuffix, result.invoice!.prefixSuffixPosition, result.invoice!.sendStatus], [1, 'W', 'suffix', null], `the first of its year (${String(index)})`);
    }
    const sale = (await w.db.collection('sales').findOne({ timestampId: 'T-ok-0' }))!;
    assert.deepEqual((sale['floodCloud'].anomalies as Document[]).map((anomaly) => anomaly['code']).sort(), ['prefixSuffixMissing', 'timezoneInvalid']);
  });

  it('numbers nothing for an invoice with no customer: the sale is saved with the anomaly and has no invoice; the backoffice is refused (422)', async () => {
    const w = await world();
    await assert.rejects(() => w.service.create(w.context, w.body({ customer: undefined })), (error: { details: Document[] }) => JSON.stringify(error.details) === JSON.stringify([{ field: 'customer', issue: 'incorrect' }]));
    const created = await w.service.create(w.storeContext, w.body({ customer: undefined, timestampId: 'T-s' }));
    assert.deepEqual([created.created, (created.result as SaleCreated).invoice], [true, null]);
    assert.deepEqual([await w.db.collection('documents').countDocuments(), await w.db.collection('document_counters').countDocuments(), await w.queued()], [0, 0, 0]);
    assert.deepEqual(((await w.db.collection('sales').findOne({}))!['floodCloud'].anomalies as Document[]).map((anomaly) => anomaly['code']), ['invoiceCounterpartMissing']);
  });

  it('copes with a group with no dealer, a point of sale with no storage of the cash desks and a place that has odd storages', async () => {
    const w = await world({ place: { storages: [null, { id: 'not-an-id', cash: true }, { id: new ObjectId(), cash: false }] } });
    const created = await w.service.create(w.context, w.body());
    assert.equal((created.result as SaleCreated).invoice!.sendStatus, 'queued');
    const document = (await w.db.collection('documents').findOne({}))!;
    assert.equal(document['storageId'], null);
    assert.equal((await w.queue().findOne({ _id: document['_id'] }))!['dealerId'], null);
    const none = await world({ place: { storages: undefined } });
    assert.equal((await none.service.create(none.context, none.body())).created, true);
    assert.equal((await none.db.collection('documents').findOne({}))!['storageId'], null);
  });

  it('puts a document in the queue again after the first attempt failed, once the queue works', async () => {
    let working = false;
    const real = ctx.databases;
    const w = await world({
      overrides: {
        databases: { ...real, queueInbox: () => (working ? real.queueInbox() : { enqueue: () => Promise.reject(new Error('queue down')) }) },
      },
    });
    const first = await w.service.create(w.context, w.body());
    assert.equal((first.result as SaleCreated).invoice!.sendStatus, 'notQueued');
    working = true;
    const again = await w.service.create(w.context, w.body());
    assert.deepEqual([again.created, (again.result as SaleCreated).invoice!.sendStatus, (again.result as SaleCreated).invoice!.number], [false, 'queued', 1]);
    assert.deepEqual([await w.queued(), await w.db.collection('documents').countDocuments(), (await w.db.collection('documents').findOne({}))!['sendStatus']], [1, 1, 'queued']);
  });

  it('starts again when a deferred invoice finds fewer unpaid sales to gather than it read, and then gathers them', async () => {
    let calls = 0;
    const w = await world({
      overrides: {
        repositoryOver: (databases) => ({
          ...createSalesWriteRepository(databases),
          gather: async (caller, access, ids, criteria, at) => {
            calls += 1;
            // The first attempt loses the race: someone gathered one of them between the read and the write.
            return calls === 1 ? ids.length - 1 : createSalesWriteRepository(databases).gather(caller, access, ids, criteria, at);
          },
        }),
      },
    });
    const buyer = (await w.db.collection('contacts').findOne({}))!['_id'] as ObjectId;
    const unpaid = new ObjectId();
    await w.db.collection('sales').insertOne({ _id: unpaid, timestampId: 'U-1', companyId: w.companyId, placeId: w.placeId, customer: { _id: buyer }, unpaid: 10, status: '', fiscalState: '', receiptType: 'charge', date: new Date(NOW) });
    const created = await w.service.create(w.context, w.body({ unpaidSaleIds: [unpaid.toHexString()] }));
    assert.deepEqual([created.created, calls, (await w.db.collection('sales').findOne({ _id: unpaid }))!['status']], [true, 2, 'invoiced']);
    assert.equal(await w.db.collection('documents').countDocuments(), 1);
    assert.equal((created.result as SaleCreated).invoice!.number, 1, 'the first attempt consumed no number');
  });

  it('keeps a sale whose company copy is missing, without a document and without a number, and says so', async () => {
    const w = await world({ company: null });
    const created = await w.service.create(w.context, w.body());
    assert.equal(created.created, true);
    assert.equal((created.result as SaleCreated).invoice, null);
    assert.deepEqual([await w.db.collection('documents').countDocuments(), await w.db.collection('document_counters').countDocuments(), await w.queued()], [0, 0, 0]);
    assert.deepEqual(((await w.db.collection('sales').findOne({}))!['floodCloud'].anomalies as Document[]).map((anomaly) => anomaly['code']), ['invoiceCompanyMissing']);
  });

  it('gives up the unpaid sales after three lost races: the backoffice is told (409), the till saves the invoice without them and says so', async () => {
    let calls = 0;
    const racy = { repositoryOver: (databases: Parameters<NonNullable<SalesWriteDeps['repositoryOver']>>[0]) => ({ ...createRealSalesRepository(databases), gather: async (_c: unknown, _a: unknown, ids: readonly ObjectId[]) => { calls += 1; return ids.length - 1; } }) as never };
    const w = await world({ overrides: racy });
    const unpaid = new ObjectId();
    await w.db.collection('sales').insertOne({ _id: unpaid, timestampId: 'U-1', companyId: w.companyId, placeId: w.placeId, customer: { _id: w.contact }, unpaid: 10, status: '', fiscalState: '', receiptType: 'charge', date: new Date(NOW) });
    const ids = [unpaid.toHexString()];
    await assert.rejects(() => w.service.create(w.context, w.body({ unpaidSaleIds: ids })), (error: { code: string; details: Document[] }) => error.code === 'CONFLICT' && JSON.stringify(error.details) === JSON.stringify([{ field: 'unpaidSaleIds', issue: 'race' }]));
    assert.deepEqual([calls, await w.db.collection('documents').countDocuments(), await w.db.collection('document_counters').countDocuments()], [3, 0, 0]);
    calls = 0;
    const created = await w.service.create(w.storeContext, w.body({ unpaidSaleIds: ids, timestampId: 'T-store' }));
    assert.deepEqual([created.created, calls, (created.result as SaleCreated).invoice!.number], [true, 3, 1]);
    assert.equal((await w.db.collection('sales').findOne({ _id: unpaid }))!['status'], '');
    const anomaly = ((await w.db.collection('sales').findOne({ timestampId: 'T-store' }))!['floodCloud'].anomalies as Document[]).find((entry) => entry['code'] === 'unpaidSaleRace')!;
    assert.deepEqual(anomaly['ids'], ids);
    const document = (await w.db.collection('documents').findOne({}))!;
    assert.equal('metadata' in document, false, 'nothing was gathered');
    assert.equal(document['fattura_elettronica'].tipo, 'TD24');
  });

  it('retries a key taken a moment ago once and then lets the second failure through', async () => {
    let inserts = 0;
    const w = await world({
      overrides: {
        repositoryOver: (databases) => ({
          ...createRealSalesRepository(databases),
          insert: async () => {
            inserts += 1;
            throw new MongoServerError({ message: 'duplicate key', code: 11000 });
          },
        }),
      },
    });
    await assert.rejects(() => w.service.create(w.context, w.body()), (error: unknown) => error instanceof MongoServerError && error.code === 11000);
    assert.equal(inserts, 2);
  });

  it('never queues an invoice twice: the mark of the attempt stays unless the queue refused, and a failure to mark or to take it back keeps the document `notQueued`', async () => {
    let queueWorks = false;
    let releaseFails = false;
    let markFails = false;
    const attempts: string[] = [];
    const real = ctx.databases;
    const w = await world({
      overrides: {
        databases: { ...real, queueInbox: () => ({ enqueue: async (record) => { attempts.push(String(record._id)); if (!queueWorks) { throw new Error('queue down'); } return real.queueInbox().enqueue(record); } }) },
        repositoryOver: (databases) => ({
          ...createRealSalesRepository(databases),
          markQueued: async (caller, access, id, at) => (markFails ? Promise.reject(new Error('mark down')) : createRealSalesRepository(databases).markQueued(caller, access, id, at)),
          unmarkQueued: async (caller, access, id) => (releaseFails ? Promise.reject(new Error('unmark down')) : createRealSalesRepository(databases).unmarkQueued(caller, access, id)),
        }),
      },
    });
    const sale = () => w.db.collection('sales').findOne({ timestampId: 'T-1' });
    // The queue refuses: the mark is taken back, the document waits, a repetition tries again.
    assert.equal((await w.service.create(w.context, w.body())).created, true);
    assert.equal(((await sale())!['floodCloud'].invoice as Document)['queuedAt'], undefined);
    // The queue refuses again and the mark cannot be taken back: it stays, and a repetition does not queue it.
    releaseFails = true;
    assert.equal(((await w.service.create(w.context, w.body())).result as SaleCreated).invoice!.sendStatus, 'notQueued');
    assert.ok(((await sale())!['floodCloud'].invoice as Document)['queuedAt'] instanceof Date);
    assert.ok(w.logs.lines.some((entry) => /taking back the mark of an invoice/.test(entry)));
    queueWorks = true;
    const before = attempts.length;
    assert.equal(((await w.service.create(w.context, w.body())).result as SaleCreated).invoice!.sendStatus, 'notQueued');
    assert.equal(attempts.length, before, 'the mark of the attempt is checked before any new queueing');
    assert.equal(await w.queued(), 0);
    // A mark that cannot be written is a failure to queue, logged, with the document waiting.
    await w.db.collection('sales').updateOne({ timestampId: 'T-1' }, { $unset: { 'floodCloud.invoice.queuedAt': '' } });
    markFails = true;
    assert.equal(((await w.service.create(w.context, w.body())).result as SaleCreated).invoice!.sendStatus, 'notQueued');
    assert.ok(w.logs.lines.some((entry) => /marking an invoice for the send queue failed/.test(entry)));
    markFails = false;
    // Two requests at once: one wins the mark and queues, the other leaves it to it; the record is written once.
    const [first, second] = await Promise.all([w.service.create(w.context, w.body()), w.service.create(w.context, w.body())]);
    assert.deepEqual([first, second].map((reply) => (reply.result as SaleCreated).invoice!.sendStatus).sort(), ['notQueued', 'queued']);
    assert.equal(await w.queued(), 1);
    assert.equal((await w.db.collection('documents').findOne({}))!['sendStatus'], 'queued');
  });

  it('refuses the document of a company that is not of the group', async () => {
    const w = await world();
    const repository = createInvoiceRepository(ctx.databases);
    assert.equal(await repository.findCompany(w.caller, w.access, new ObjectId()), null);
    assert.equal(await repository.findCounterpart(w.caller, w.access, new ObjectId()), null);
    // The company of another group is not found, and an id that is not an ObjectId is a bug of the caller.
    const other = await world();
    assert.equal(await repository.findCompany(w.caller, w.access, other.companyId), null);
    assert.equal((await repository.findCompany(w.caller, w.access, w.companyId))!['name'], 'Acme');
    await assert.rejects(() => repository.findCompany(w.caller, w.access, 'x' as never), /needs its id/);
    await assert.rejects(() => repository.insert(w.caller, w.access, { _id: new ObjectId(), sneaky: 1 }), /does not own the field sneaky/);
    assert.equal(await w.db.collection('documents').countDocuments(), 0);
  });
});

describe('the queue inbox', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  it('inserts a record once with its own id, never overwrites what the consumer added, and refuses a field it does not own', async () => {
    const inbox = ctx.databases.queueInbox();
    const documents = ctx.client.db(`${ctx.prefix}development_queue`).collection('documents');
    const _id = new ObjectId();
    assert.deepEqual(Object.keys(inbox), ['enqueue']);
    assert.equal(await inbox.enqueue({ _id, number: 1, dealerId: null, sale: { _id: new ObjectId(), fullMeal: null }, sendStatus: null }), true);
    await documents.updateOne({ _id }, { $set: { sent: true, hubId: 'h-1' } });
    assert.equal(await inbox.enqueue({ _id, number: 2, sendStatus: null }), false);
    const stored = (await documents.findOne({ _id }))!;
    assert.deepEqual([stored['number'], stored['sent'], stored['hubId'], await documents.countDocuments()], [1, true, 'h-1', 1]);
    await assert.rejects(() => inbox.enqueue({ _id: new ObjectId(), hubId: 'x' }), /does not accept the field hubId/);
    await assert.rejects(() => inbox.enqueue({ _id: new ObjectId(), worker: { state: 'claimed' } }), /does not accept the field worker/);
    assert.equal(await documents.countDocuments(), 1);
  });
});
