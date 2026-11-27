import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { createStoreContactsAudit } from '../../src/modules/store-contacts/store-contacts.audit.ts';
import { memoryLogger } from '../helpers/app.ts';
import { accessFor } from '../helpers/group-access.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { SALES_WAREHOUSE_RULES, saleBody, saleLine } from '../helpers/store-sales.ts';
import { createNumberingIndexGuard } from '../../src/modules/document-numbering/numbering.indexes.ts';
import { createNumberingService } from '../../src/modules/document-numbering/numbering.service.ts';
import { createInvoiceGuard } from '../../src/modules/sales/sales.invoice.guard.ts';
import { createLoyaltyService } from '../../src/modules/loyalty/loyalty.service.ts';
import { createSalesKeyIndexGuard } from '../../src/modules/sales/sales.key-index.ts';
import { createSalesWriteRepository } from '../../src/modules/sales/sales.write.repository.ts';
import type { SalesWriteRepository } from '../../src/modules/sales/sales.write.repository.ts';
import { createSalesWriteService } from '../../src/modules/sales/sales.write.service.ts';
import type { SaleCreated, SalesWriteContext, SalesWriteDeps } from '../../src/modules/sales/sales.write.service.ts';
import { createStockIndexGuard } from '../../src/modules/stock/stock.indexes.ts';
import { createStockService } from '../../src/modules/stock/stock.service.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import { cancelSaleBody, createSaleBody, patchSaleBody, refundSaleBody } from '../../src/modules/sales/sales.write.schemas.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');

/** The service of the sales driven directly, with a backoffice caller and fakes where a failure must be made (step VS4a): the branches the HTTP tests of the store cannot reach. */
describe('the service of the sales writes', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  async function world(overrides: Partial<SalesWriteDeps> = {}) {
    const groupId = new ObjectId();
    const placeId = new ObjectId();
    const companyId = new ObjectId();
    const cash = new ObjectId();
    await ctx.databases.common().collection('groups').insertOne({ _id: groupId, settings: { warehouse: true }, warehouseRules: SALES_WAREHOUSE_RULES });
    await ctx.databases.common().collection('places').insertOne({ _id: placeId, groupId, storages: [{ id: cash, cash: true }] });
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
      ...overrides,
    });
    const context: SalesWriteContext = { caller, access, companyId, placeId, request: { requestId: 'req-1', ip: null, userAgent: null }, store: null };
    const product = async (): Promise<ObjectId> => {
      const _id = new ObjectId();
      await db.collection('products').insertOne({ _id, code: 'P', name: { it: 'P' }, type: 'product', availability: { warehouse: true }, measureConversionRatio: 1, quantity: { [`__${placeId.toHexString()}`]: { [`__${cash.toHexString()}`]: { value: 10 } } } });
      return _id;
    };
    const stock = async (productId: ObjectId): Promise<number> => (((await db.collection('products').findOne({ _id: productId }))!['quantity'] as Document)[`__${placeId.toHexString()}`][`__${cash.toHexString()}`] as Document)['value'] as number;
    const body = (productId: ObjectId, overrides: Document = {}) => validate(createSaleBody, JSON.parse(JSON.stringify(saleBody([saleLine(productId)], overrides))), '(body)');
    return { db, caller, context, service, activity, logs, product, stock, body, placeId, groupId };
  }

  const wrapped = (changes: Partial<SalesWriteRepository>) => (databases: Parameters<NonNullable<SalesWriteDeps['repositoryOver']>>[0]): SalesWriteRepository => ({ ...createSalesWriteRepository(databases), ...changes });

  it('writes as a backoffice user: the user is the operator and the actor, and every operation works from the point of sale of the context', async () => {
    const w = await world();
    const item = await w.product();
    const created = await w.service.create(w.context, w.body(item));
    assert.equal(created.created, true);
    const sale = (await w.db.collection('sales').findOne({}))!;
    assert.deepEqual([sale['userId'], sale['floodCloud'].createdBy, sale['floodCloud'].operations[0].by], [w.caller.userId, { kind: 'user', userId: w.caller.userId }, { kind: 'user', userId: w.caller.userId }]);
    assert.equal((await w.db.collection('warehouse').findOne({}))!['storeKeyId'], undefined);
    const id = new ObjectId((created.result as SaleCreated).id);
    const amended = await w.service.amend(w.context, id, validate(patchSaleBody, { lotteryCode: 'ABCD1234' }, '(body)'), null);
    assert.equal(amended.lotteryCode, 'ABCD1234');
    const refunded = await w.service.refund(w.context, id, validate(refundSaleBody, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] }, '(body)'), null);
    assert.equal(refunded.created, true);
    assert.equal(await w.stock(item), 9);
    assert.equal((await w.service.cancel(w.context, id, validate(cancelSaleBody, { date: '2026-11-28T10:00:00.000Z' }, '(body)'), null)).created, true);
    assert.equal(await w.stock(item), 10);
    assert.deepEqual(w.activity.entries.map((entry) => [entry.action, entry.actor.kind, entry.ip, entry.metadata?.['operatorId']]), [['sale.created', 'user', undefined, undefined], ['sale.amended', 'user', undefined, undefined], ['sale.refunded', 'user', undefined, undefined], ['sale.canceled', 'user', undefined, undefined]]);
    const quote = await w.service.create(w.context, w.body(item, { timestampId: 'T-q', nonFiscal: true, fiscalReceiptInfo: null }));
    await w.service.remove(w.context, new ObjectId((quote.result as SaleCreated).id), null);
    assert.equal(await w.stock(item), 10);
    await assert.rejects(() => w.service.get(w.context, new ObjectId((quote.result as SaleCreated).id)), { code: 'NOT_FOUND' });
  });

  it('answers 503 and saves nothing when the unique index of the key could not be created', async () => {
    const w = await world({ keyIndex: { ensure: async () => false } });
    const item = await w.product();
    await assert.rejects(() => w.service.create(w.context, w.body(item)), { code: 'SERVICE_UNAVAILABLE' });
    assert.equal(await w.db.collection('sales').countDocuments(), 0);
  });

  it('tries again when the key was taken a moment ago by another request, and lets any other failure through', async () => {
    let calls = 0;
    const racy = await world({
      repositoryOver: (databases) => ({
        ...createSalesWriteRepository(databases),
        insert: async (caller, access, sale) => {
          calls += 1;
          if (calls === 1) {
            // The winner of the race commits its sale outside the transaction of this attempt, and the unique key refuses this one.
            await ctx.databases.group(access.groupId, access.clusterId).collection('sales').insertOne({ ...sale, _id: new ObjectId() });
            throw new MongoServerError({ message: 'duplicate key', code: 11000 });
          }
          await createSalesWriteRepository(databases).insert(caller, access, sale);
        },
      }),
    });
    const outcome = await racy.service.create(racy.context, racy.body(await racy.product()));
    assert.deepEqual([outcome.created, calls, await racy.db.collection('sales').countDocuments()], [false, 1, 1], 'the second attempt finds the winner');
    const broken = await world({ repositoryOver: wrapped({ insert: async () => Promise.reject(new Error('disk full')) }) });
    const item = await broken.product();
    await assert.rejects(async () => broken.service.create(broken.context, broken.body(item)), /disk full/);
    assert.equal(await broken.db.collection('sales').countDocuments(), 0);
  });

  it('says a sale is not there when it disappears between the read and the write', async () => {
    const w = await world();
    const item = await w.product();
    const created = await w.service.create(w.context, w.body(item, { nonFiscal: true, fiscalReceiptInfo: null }));
    const gone = await world({ repositoryOver: wrapped({ update: async () => false, remove: async () => false }) });
    await gone.db.collection('sales').insertOne({ ...(await w.db.collection('sales').findOne({}))!, placeId: gone.placeId });
    const id = new ObjectId((created.result as SaleCreated).id);
    await assert.rejects(() => gone.service.amend(gone.context, id, validate(patchSaleBody, { lotteryCode: 'ABCD1234' }, '(body)'), null), { code: 'NOT_FOUND' });
    await assert.rejects(() => gone.service.remove(gone.context, id, null), { code: 'NOT_FOUND' });
  });

  it('keeps a sale that is saved when the activity log fails, and says so in the log of the server', async () => {
    const w = await world({
      activityLog: { record: () => Promise.reject(new Error('log down')) },
    });
    const item = await w.product();
    const created = await w.service.create(w.context, w.body(item));
    assert.equal(created.created, true);
    assert.equal(await w.db.collection('sales').countDocuments(), 1);
    assert.ok(w.logs.lines.some((line) => /recording the activity of a sale failed/.test(line)));
  });

  it('keeps a sale that is saved when the credit alert fails', async () => {
    const w = await world({ audit: { creditAdded: () => Promise.reject(new Error('alert down')), creditAddedByUser: () => Promise.reject(new Error('alert down')) } });
    await ctx.databases.common().collection('groups').updateOne({ _id: w.groupId }, { $set: { 'fidelity.cardsTypes': [{ id: 't', status: true, prepaid: { status: true, type: 'multi' }, pointsCollect: { status: false, collectionIds: [] }, placesAvailability: [] }], 'fidelity.pointsCollections': [] } });
    await w.db.collection('fidelity_cards').insertOne({ _id: new ObjectId(), code: 'C1', cardTypeId: 't', status: true, balance: 0, pointsCollections: {}, insertDate: new Date(NOW), updateDate: new Date(NOW) });
    const refill = new ObjectId();
    await w.db.collection('products').insertOne({ _id: refill, code: '000-r-multi-1', name: { it: 'R' }, type: 'product', availability: { warehouse: false }, categories: [] });
    const body = validate(createSaleBody, JSON.parse(JSON.stringify(saleBody([saleLine(refill, { qt: 1, price: { price: 10, taxed: 12.2, tax: 22 } })], { fidelityCardCode: 'C1', totals: { taxable: 10, tax: 2.2, total: 12.2 }, payments: { cash: 12.2 } }))), '(body)');
    const created = await w.service.create({ ...w.context, store: {} as never }, body);
    assert.equal(created.created, true);
    assert.equal(await w.db.collection('sales').countDocuments(), 1);
    assert.ok(w.logs.lines.some((line) => /credit alert of a sale failed/.test(line)));
  });

});
