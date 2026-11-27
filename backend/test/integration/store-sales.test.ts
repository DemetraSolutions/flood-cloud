import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { legacyContact } from '../helpers/contacts.ts';
import { legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { LINE_TAX, SALES_WAREHOUSE_RULES, saleBody, saleLine } from '../helpers/store-sales.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';

/** The sales of the store (step VS4a): every behaviour goes through `/v1/store-context/sales` with a store key, over a real MongoDB. */
let ctx: TestDatabases;
let world: StoreWorld;
let store: ActivatedKey;
const limiter = memoryRateLimiter();
const hex = (id: ObjectId) => id.toHexString();
const gid = () => world.group(0).groupId;
const own = () => world.group(0).ownPlaceId;
const db = (index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0');
const salesOf = (index = 0) => db(index).collection('sales');
const SALES = '/store-context/sales';
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = store.key) => world.asStore(key, method, path, body, headers);
const post = (body: unknown) => send('POST', SALES, body);
const at = (n: number) => new Date(Date.UTC(2026, 10, n));
let cashStorage: ObjectId;
let counter = 0;

/** A product of the catalog, kept in stock (10 pieces in the storage of the cash desks). */
async function product(fields: Document = {}, stock = 10): Promise<ObjectId> {
  const _id = new ObjectId();
  await db().collection('products').insertOne({
    _id,
    type: 'product',
    code: `P-${String((counter += 1))}`,
    name: { it: 'Prodotto', en: 'Product' },
    categories: ['cat-1'],
    availability: { pos: true, warehouse: true },
    measureLoad: 'pz',
    measureDownload: 'pz',
    measureConversionRatio: 1,
    bundleProducts: [],
    barcode: [],
    simpleCost: 3,
    lastAveragePrice: { total: { averagePrice: 4, weightedAveragePrice: 4 } },
    quantity: { [`__${hex(own())}`]: { [`__${hex(cashStorage)}`]: { value: stock, min: 1 } } },
    insertDate: at(1),
    updateDate: at(1),
    ...fields,
  });
  return _id;
}
const stockOf = async (productId: ObjectId): Promise<number> => (((await db().collection('products').findOne({ _id: productId }))!['quantity'] as Document)[`__${hex(own())}`][`__${hex(cashStorage)}`] as Document)['value'] as number;
const saleOf = async (id: string): Promise<Document> => (await salesOf().findOne({ _id: new ObjectId(id) }))!;
const anomalyCodes = (sale: Document): string[] => (sale['floodCloud'].anomalies as Document[]).map((anomaly) => `${anomaly['source']}:${anomaly['code']}`);
const movementsOf = (saleId: string) => db().collection('warehouse').find({ 'origin.id': new ObjectId(saleId) }).sort({ 'origin.seq': 1 }).toArray();
const contacts = () => db().collection('contacts');
const cards = () => db().collection('fidelity_cards');
const cardMovements = () => db().collection('fidelity_cards_movements');

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter, env: { RATE_LIMIT_STORE_SALES_WRITE_PER_STORE: '40', STORE_CREDIT_ALERT_PER_OPERATION: '50' } });
  store = await world.activate(own());
  cashStorage = new ObjectId();
  const common = ctx.databases.common();
  await common.collection('groups').updateOne({ _id: gid() }, { $set: { 'settings.warehouse': true, warehouseRules: SALES_WAREHOUSE_RULES } });
  await common.collection('places').updateOne({ _id: own() }, { $set: { storages: [{ id: new ObjectId(), name: 'Back', cash: false }, { id: cashStorage, name: 'Shop', cash: true }] } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  await Promise.all([salesOf().deleteMany({}), db().collection('sales_tombstones').deleteMany({}), salesOf(1).deleteMany({}), db().collection('products').deleteMany({}), db().collection('warehouse').deleteMany({}), contacts().deleteMany({}), cards().deleteMany({}), cardMovements().deleteMany({})]);
  await ctx.databases.common().collection('groups').updateOne({ _id: gid() }, { $set: { 'settings.warehouse': true, warehouseRules: SALES_WAREHOUSE_RULES } });
});

describe('the creation of a sale', () => {
  it('saves the sale in the shape of the legacy, moves the warehouse and answers 201 with its link, version and checks', async () => {
    const pizza = await product();
    const mark = world.office.activity.entries.length;
    const created = await post(saleBody([saleLine(pizza, { sent: true, sentBy: hex(new ObjectId()), barcodeRead: '8001' })]));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const data = created.body.data;
    assert.match(created.headers.get('location')!, new RegExp(`/store-context/sales/${data.id}$`));
    assert.equal(created.headers.get('etag'), `"${data.version}"`);
    assert.deepEqual({ ...data, id: 'x', version: 'v' }, { id: 'x', timestampId: 'T-1', date: '2026-11-27T10:00:00.000Z', receiptType: 'receipt', nonFiscal: false, fiscalState: null, number: { report: 101, number: 12 }, total: 24.4, checks: { status: 'ok', anomalies: 0 }, fidelity: null, invoice: null, version: 'v' });
    const sale = await saleOf(data.id);
    assert.equal(sale['_id'] instanceof ObjectId && sale['companyId'] instanceof ObjectId && sale['placeId'] instanceof ObjectId, true);
    assert.deepEqual([sale['companyId'], sale['placeId']], [new ObjectId(store.companyId), own()], 'the company and the point of sale come from the key');
    assert.deepEqual([sale['date'], sale['insertDate']].map((value) => value instanceof Date), [true, true]);
    assert.equal(sale['updateDate'], null);
    assert.deepEqual([sale['timestampId'], sale['receiptType'], sale['sType'], sale['fiscalState'], sale['userId'], sale['customer'], sale['customerType'], sale['refund']], ['T-1', 'receipt', false, '', null, null, null, []]);
    assert.deepEqual([sale['cashAmount'], sale['electronicAmount'], sale['finalTotalCheckout'], sale['finalTotalTaxable'], sale['finalTotalTax'], sale['finalTotalCheckoutWithoutDiscount'], sale['finalTotalTaxWithoutDiscount']], [24.4, 0, 24.4, 20, 4.4, 24.4, 4.4]);
    assert.deepEqual(sale['fiscalReceiptInfo'], { date: new Date('2026-11-27T10:00:04.000Z'), number: 12, amount: 24.4, reportNumber: 101 });
    assert.deepEqual(sale['hotel'], { roomId: null, roomName: null });
    // The line: the identity, the stock flag and the costs come from the catalog, the facts of the line from the till.
    const [line] = sale['products'] as Document[];
    assert.deepEqual(Object.keys(line!).sort(), ['_id', 'availability', 'barcodeRead', 'bundleProducts', 'categories', 'code', 'freeProduct', 'lastAveragePrice', 'name', 'price', 'qt', 'sent', 'sentBy', 'simpleCost', 'timestampId', 'type']);
    assert.deepEqual([line!['_id'], line!['freeProduct'], line!['categories'], line!['availability'], line!['simpleCost'], line!['lastAveragePrice'], line!['name'], line!['type']], [pizza, false, ['cat-1'], { warehouse: true }, 3, { total: { averagePrice: 4 } }, { it: 'Prodotto', en: 'Product' }, 'product']);
    assert.deepEqual(line!['price'], { price: 10, taxed: 12.2, discount: 0, tax: 22, listId: 'list-1', currency: 'EUR', taxData: { id: 'tax-001', value: 22, description: 'Ordinaria', department: 1 } });
    // The state of this backend, in one container.
    const cloud = sale['floodCloud'] as Document;
    assert.deepEqual([cloud['v'], cloud['key'], cloud['createdBy'], cloud['serverCheck'].status, cloud['anomalies'], cloud['legacy'], cloud['cancellation']], [1, `${hex(own())}|T-1`, { kind: 'store', storeKeyId: new ObjectId(store.keyId) }, 'ok', [], null, null]);
    assert.deepEqual(cloud['operations'].map((operation: Document) => [operation['kind'], operation['by']]), [['create', { kind: 'store', storeKeyId: new ObjectId(store.keyId) }]]);
    // The warehouse: one unload of the two pieces, with the origin of the sale.
    assert.equal(await stockOf(pizza), 8);
    const [movement] = await movementsOf(data.id);
    assert.deepEqual([movement!['type'], movement!['saleId'], movement!['storeKeyId'], movement!['userId'], (movement!['records'] as Document[])[0]!['quantity']], ['D', sale['_id'], new ObjectId(store.keyId), null, 2]);
    // The activity log: the store is the actor, with the metadata and no personal datum.
    const entry = world.office.activity.entries.slice(mark).find((candidate) => candidate.action === 'sale.created')!;
    assert.deepEqual([entry.actor, entry.resource, entry.metadata], [{ kind: 'store', id: new ObjectId(store.keyId) }, { type: 'sale', id: data.id }, { timestampId: 'T-1', receiptType: 'receipt', total: 24.4, anomalies: 0, duplicate: false }]);
    // The detail: the position of each line, the version of the sale and the checks.
    const detail = await send('GET', `${SALES}/${data.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get('etag'), created.headers.get('etag'));
    assert.deepEqual([detail.body.data.products[0].index, detail.body.data.products[0].productId, detail.body.data.products[0].unitPrice, detail.body.data.payments.cash, detail.body.data.refunds], [0, hex(pizza), { net: 10, gross: 12.2 }, 24.4, []]);
    assert.equal(JSON.stringify(detail.body).includes('floodCloud'), false);
  });

  it('answers a repeated sale with 200 and the original one, without writing, and records a different body as an anomaly once', async () => {
    const pizza = await product();
    const body = saleBody([saleLine(pizza)]);
    const first = await post(body);
    const again = await post(body);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.data, first.body.data);
    assert.equal(await salesOf().countDocuments(), 1);
    assert.equal(await stockOf(pizza), 8, 'the warehouse moved once');
    const different = await post({ ...body, totals: { taxable: 21, tax: 4.4, total: 25.4 } });
    assert.equal(different.status, 200);
    assert.equal(different.body.data.id, first.body.data.id);
    await post({ ...body, note: 'again' });
    assert.deepEqual(anomalyCodes(await saleOf(first.body.data.id)), ['sale:duplicateDiffers'], 'once');
    assert.equal(await stockOf(pizza), 8);
  });

  it('finds the sale the legacy wrote with the same point of sale and timestampId, as an ObjectId or as text, and writes nothing', async () => {
    const pizza = await product();
    const legacyId = new ObjectId();
    await salesOf().insertOne({ _id: legacyId, timestampId: 'T-1', placeId: hex(own()), companyId: new ObjectId(store.companyId), date: at(20), finalTotalCheckout: 5, products: [], refund: [], sType: false, fiscalState: '', receiptType: 'receipt' });
    const first = await post(saleBody([saleLine(pizza)]));
    assert.equal(first.status, 200);
    assert.equal(first.body.data.id, hex(legacyId));
    assert.equal(first.body.data.total, 5);
    assert.equal(await salesOf().countDocuments(), 1);
    assert.equal(await stockOf(pizza), 10);
    const other = await post(saleBody([saleLine(pizza)], { timestampId: 'T-2' }));
    assert.equal(other.status, 201);
    await salesOf().insertOne({ _id: new ObjectId(), timestampId: 'T-3', placeId: new ObjectId(), date: at(20) });
    assert.equal((await post(saleBody([saleLine(pizza)], { timestampId: 'T-3' }))).status, 201, 'the same timestampId of another point of sale is another sale');
  });

  it('keeps one sale when the same one arrives twice at the same moment', async () => {
    const pizza = await product();
    const replies = await Promise.all(Array.from({ length: 6 }, () => post(saleBody([saleLine(pizza)], { timestampId: 'T-race' }))));
    assert.ok(replies.every((reply) => reply.status === 201 || reply.status === 200), replies.map((reply) => reply.status).join());
    assert.equal(replies.filter((reply) => reply.status === 201).length, 1);
    assert.equal(new Set(replies.map((reply) => reply.body.data.id)).size, 1);
    assert.equal(await salesOf().countDocuments(), 1);
    assert.equal(await stockOf(pizza), 8);
  });

  it('never refuses a sale for a rule of the business: it records the anomalies', async () => {
    const pizza = await product({}, 1);
    const ghost = new ObjectId();
    const created = await post(
      saleBody([saleLine(pizza, { qt: 5 }), saleLine(ghost, { timestampId: 'line-2' })], {
        receiptType: 'invoice',
        date: '2031-01-01T00:00:00.000Z',
        operatorId: hex(new ObjectId()),
        customer: { contactId: hex(new ObjectId()) },
        fidelityCardCode: 'NOBODY',
        totals: { taxable: 70, tax: 4, total: 80 },
      }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sale = await saleOf(created.body.data.id);
    assert.deepEqual(anomalyCodes(sale).sort(), ['loyalty:simpleCardNotFound', 'loyalty:simpleRuleMissing', 'sale:customerMissing', 'sale:dateInFuture', 'sale:invoiceCounterpartMissing', 'sale:operatorUnknown', 'stock:productMissing']);
    assert.equal(await stockOf(pizza), -4, 'negative stock is allowed');
    assert.equal(sale['userId'], null, 'an operator who is not of the group is never saved');
    assert.equal(sale['customer'], null);
    assert.equal(created.body.data.checks.status, 'differences');
    assert.deepEqual(sale['floodCloud'].serverCheck.lines.map((line: Document) => [line['index'], line['code']]), [[1, 'productMissing']]);
    assert.ok(sale['floodCloud'].serverCheck.totals.some((total: Document) => total['field'] === 'total'));
    assert.equal(created.body.data.fidelity.balance, null);
  });

  it('saves an operator who is a user of the group, and flags one who is not active', async () => {
    const pizza = await product();
    const users = ctx.databases.common().collection('users');
    const active = legacyUser(901, { groupId: gid(), dealerId: world.group(0).dealerId, role: 'E', placeId: own(), placesId: [own()] });
    const gone = legacyUser(902, { groupId: gid(), dealerId: world.group(0).dealerId, role: 'E', placeId: own(), placesId: [own()], status: false });
    await users.deleteMany({ _id: { $in: [active['_id'], gone['_id']] } });
    await users.insertMany([active, gone]);
    const one = await post(saleBody([saleLine(pizza)], { timestampId: 'T-a', operatorId: hex(active['_id'] as ObjectId) }));
    assert.equal(one.status, 201);
    const sale = await saleOf(one.body.data.id);
    assert.deepEqual([sale['userId'], anomalyCodes(sale)], [active['_id'], []]);
    assert.deepEqual((await movementsOf(one.body.data.id))[0]!['userId'], active['_id']);
    const two = await post(saleBody([saleLine(pizza)], { timestampId: 'T-b', operatorId: hex(gone['_id'] as ObjectId) }));
    const flagged = await saleOf(two.body.data.id);
    assert.deepEqual([flagged['userId'], anomalyCodes(flagged)], [gone['_id'], ['sale:operatorInactive']]);
    const entry = world.office.activity.entries.filter((candidate) => candidate.action === 'sale.created').at(-1)!;
    assert.equal(entry.metadata!['operatorId'], hex(gone['_id'] as ObjectId));
  });

  it('builds the customer from the contact in the database with an allowlist, and never from the client', async () => {
    const pizza = await product();
    const mario = legacyContact({ companyName: '', fidelities: [{ code: 'CARD-1', points: 120 }] });
    const firm = legacyContact({ companyName: 'Rossi Srl', companyCode: '01234567890' });
    const trashed = legacyContact({ trash: true });
    await contacts().insertMany([mario, firm, trashed]);
    const one = await post(saleBody([saleLine(pizza)], { timestampId: 'T-1', customer: { contactId: hex(mario['_id'] as ObjectId) } }));
    const sale = await saleOf(one.body.data.id);
    const customer = sale['customer'] as Document;
    assert.deepEqual([customer['_id'], customer['name'], customer['surname'], sale['customerType'], customer['fidelities']], [mario['_id'], 'Mario', 'Rossi', 1, [{ code: 'CARD-1' }]]);
    for (const secret of ['account', 'cGroup', 'associatedCompany', 'services', 'notes', 'companyLists', 'trash', 'discount', 'listId', 'birthDate']) {
      assert.equal(secret in customer, false, secret);
    }
    assert.equal((await saleOf((await post(saleBody([saleLine(pizza)], { timestampId: 'T-2', customer: { contactId: hex(firm['_id'] as ObjectId) } }))).body.data.id))['customerType'], 2);
    const copy = await saleOf((await post(saleBody([saleLine(pizza)], { timestampId: 'T-3', customer: { contactId: hex(trashed['_id'] as ObjectId) } }))).body.data.id);
    assert.deepEqual([copy['customer']['_id'], anomalyCodes(copy)], [trashed['_id'], ['sale:customerTrashed']]);
    const found = await send('GET', `${SALES}?contactId=${hex(mario['_id'] as ObjectId)}`);
    assert.deepEqual(found.body.data.map((item: Document) => item['id']), [one.body.data.id]);
    assert.equal(found.body.data[0].customer.contactId, hex(mario['_id'] as ObjectId));
    assert.equal(JSON.stringify(found.body).includes('Mario'), false, 'the customer of a sale is only the id');
  });
});

/** The loyalty setup of the group: a prepaid card type that collects points, and a rule of one point for 5 euros for the simple cards. */
async function loyaltySetup(): Promise<void> {
  await ctx.databases.common().collection('groups').updateOne(
    { _id: gid() },
    {
      $set: {
        'fidelity.cardsTypes': [{ id: 'ct-prepaid', status: true, prepaid: { status: true, type: 'multi' }, pointsCollect: { status: true, collectionIds: ['pc-1'] }, placesAvailability: [] }],
        'fidelity.pointsCollections': [{ id: 'pc-1', status: true, pointConversion: 2, minAmount: 0 }],
        fidelityCardRules: { EUR: { value: 5 } },
      },
    },
  );
}
const advancedCard = async (overrides: Document = {}): Promise<ObjectId> => {
  const _id = new ObjectId();
  await cards().insertOne({ _id, code: 'ADV-1', cardTypeId: 'ct-prepaid', status: true, balance: new Double(10), pointsCollections: { 'pc-1': 5 }, insertDate: at(1), updateDate: at(1), ...overrides });
  return _id;
};
const balanceOf = async (id: ObjectId): Promise<[number, number]> => {
  const card = (await cards().findOne({ _id: id }))!;
  return [Math.round((card['balance'] as number) * 100) / 100, (card['pointsCollections'] as Document)['pc-1']];
};

describe('the loyalty of a sale', () => {
  it('applies the credit used and the points of an advanced card, answers with the card after the sale and reverses it with the cancellation, once', async () => {
    await loyaltySetup();
    const card = await advancedCard();
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza)], { fidelityCardCode: 'ADV-1', payments: { cash: 20, fidelityCredit: 4.4 } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // 24.40 paid, 4.40 of credit: the base of the points is 20, one point for 2 euros.
    assert.deepEqual(created.body.data.fidelity, { cardCode: 'ADV-1', balance: 5.6, points: [{ collectionId: 'pc-1', points: 15 }] });
    assert.deepEqual(await balanceOf(card), [5.6, 15]);
    const sale = await saleOf(created.body.data.id);
    assert.deepEqual([sale['fidelityCard'], sale['paymentDiscountAmount']], [{ code: 'ADV-1' }, 4.4]);
    assert.equal(sale['floodCloud'].loyalty.applied.advanced.cardId.equals(card), true);
    assert.deepEqual((await cardMovements().find({ saleId: sale['_id'] }).toArray()).map((movement) => [movement['type'], movement['balance'], movement['points'], movement['storeKeyId']]).sort(), [['sale', -4.4, 0, new ObjectId(store.keyId)], ['sale', 0, 10, new ObjectId(store.keyId)]].sort());
    const canceled = await send('POST', `${SALES}/${created.body.data.id}/cancellation`, { date: '2026-11-27T11:00:00.000Z' });
    assert.equal(canceled.status, 201, JSON.stringify(canceled.body));
    assert.deepEqual(await balanceOf(card), [10, 5]);
    assert.equal((await send('POST', `${SALES}/${created.body.data.id}/cancellation`, { date: '2026-11-27T11:05:00.000Z' })).status, 200);
    assert.deepEqual(await balanceOf(card), [10, 5], 'a second cancellation reverses nothing');
    assert.deepEqual((await cardMovements().find({ saleId: sale['_id'], type: 'canceled_sale' }).toArray()).map((movement) => movement['points'] + movement['balance']).sort(), [-10, 4.4]);
  });

  it('never refuses a sale for the card: inactive card, credit beyond the balance, a refill on a card of another kind', async () => {
    await loyaltySetup();
    const card = await advancedCard({ status: false, balance: new Double(1) });
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza)], { fidelityCardCode: 'ADV-1', payments: { cash: 0, fidelityCredit: 24.4 } }));
    assert.equal(created.status, 201);
    assert.deepEqual(await balanceOf(card), [-23.4, 5], 'the credit goes below zero only because of a sale, and an inactive card gets no points');
    const sale = await saleOf(created.body.data.id);
    assert.deepEqual(anomalyCodes(sale).sort(), ['loyalty:cardInactive', 'loyalty:negativeBalance']);
    assert.deepEqual(created.body.data.fidelity.balance, -23.4);
  });

  it('gives the points of a simple card to its contact and takes them away in proportion with a partial refund and all with the cancellation', async () => {
    await loyaltySetup();
    const pizza = await product();
    const mario = legacyContact({ fidelities: [{ code: 'SIMPLE-1', points: 3 }] });
    await contacts().insertOne(mario);
    const created = await post(saleBody([saleLine(pizza, { qt: 4, price: { price: 10, taxed: 12.5, discount: 0, tax: 25 } })], { fidelityCardCode: 'SIMPLE-1', customer: { contactId: hex(mario['_id'] as ObjectId) }, totals: { taxable: 40, tax: 10, total: 50 }, payments: { cash: 50 } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const points = async () => ((await contacts().findOne({ _id: mario['_id'] }))!['fidelities'] as Document[])[0]!['points'];
    assert.equal(await points(), 13, 'the base is 50, one point for 5');
    assert.deepEqual(created.body.data.fidelity, { cardCode: 'SIMPLE-1', balance: null, points: [{ collectionId: null, points: 13 }] });
    const refund = await send('POST', `${SALES}/${created.body.data.id}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 2 }] });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    assert.equal(await points(), 3 + 5, 'half returned: half of the 10 points stay');
    assert.equal((await send('POST', `${SALES}/${created.body.data.id}/cancellation`, { date: '2026-11-29T09:00:00.000Z' })).status, 201);
    assert.equal(await points(), 3);
  });
});

describe('the refund of a sale', () => {
  const refundBody = (timestampId: string, index: number, quantity: number, extra: Document = {}) => ({ timestampId, date: '2026-11-28T09:00:00.000Z', products: [{ index, quantity }], ...extra });

  it('registers partial and repeated refunds, loads the stock back, and answers the same refund with 200', async () => {
    const pizza = await product();
    const beer = await product();
    const created = await post(saleBody([saleLine(pizza, { qt: 4 }), saleLine(beer, { qt: 1, timestampId: 'line-2' })], { totals: { taxable: 50, tax: 11, total: 61 }, payments: { cash: 61 } }));
    const id = created.body.data.id as string;
    assert.deepEqual([await stockOf(pizza), await stockOf(beer)], [6, 9]);
    const first = await send('POST', `${SALES}/${id}/refunds`, refundBody('R-1', 0, 1, { operatorId: hex(new ObjectId()), fiscalReceiptInfo: { date: '2026-11-28T09:00:03.000Z', report: 102, number: 3, amount: 12.2 } }));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.match(first.headers.get('location')!, new RegExp(`/store-context/sales/${id}/refunds/R-1$`));
    assert.equal(first.headers.get('etag'), `"${first.body.data.sale.version}"`);
    assert.deepEqual([first.body.data.sale.fiscalState, first.body.data.refund.timestampId, first.body.data.refund.products, first.body.data.refund.value, first.body.data.refund.fiscalReceiptInfo.number], ['refunded', 'R-1', [{ index: 0, productId: hex(pizza), quantity: 1 }], { taxable: 10, tax: 2.2, total: 12.2 }, 3]);
    assert.deepEqual([await stockOf(pizza), await stockOf(beer)], [7, 9]);
    const second = await send('POST', `${SALES}/${id}/refunds`, refundBody('R-2', 0, 2));
    assert.equal(second.status, 201);
    assert.equal(await stockOf(pizza), 9);
    assert.deepEqual(second.body.data.sale.products.map((line: Document) => line['returned']), [3, 0]);
    // The same refund again changes nothing.
    const again = await send('POST', `${SALES}/${id}/refunds`, refundBody('R-1', 0, 1));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.data.refund, first.body.data.refund);
    assert.equal(await stockOf(pizza), 9);
    const sale = await saleOf(id);
    assert.deepEqual([sale['fiscalState'], (sale['refund'] as Document[]).map((entry) => entry['timestampId']), sale['returnedGoodsValue']], ['refunded', ['R-1', 'R-2'], { totalNoTax: 20, taxValue: 4.4, priceTaxed: 24.4 }]);
    assert.equal((sale['updateDate'] as Date) instanceof Date, true);
    const entry = (sale['refund'] as Document[])[0]!;
    assert.deepEqual(Object.keys(entry).sort(), ['date', 'fiscalReceiptInfo', 'returnedGoods', 'returnedGoodsValue', 'timestampId', 'userId']);
    assert.deepEqual(entry['fiscalReceiptInfo'], { date: new Date('2026-11-28T09:00:03.000Z'), number: 3, amount: 12.2, reportNumber: 102 });
    assert.equal((sale['refund'] as Document[])[1]!['returnedGoods'][0]['returnedQt'], 2);
    // The sale is read the way the lists of the legacy read it.
    const list = await world.as.call(world.group(0).sa, 'GET', `/groups/${hex(gid())}/sales/${id}`);
    assert.deepEqual([list.status, list.body.data.fiscalState, list.body.data.refunds.length], [200, 'refunded', 2]);
  });

  it('refuses a refund of a line that does not exist or of another product, and records a refund above what was sold without refusing it', async () => {
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza)]));
    const id = created.body.data.id as string;
    const wrongIndex = await send('POST', `${SALES}/${id}/refunds`, refundBody('R-1', 3, 1));
    assert.deepEqual([wrongIndex.status, wrongIndex.body.error.details], [422, [{ field: 'products.0.index', issue: 'incorrect' }]]);
    const wrongProduct = await send('POST', `${SALES}/${id}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, productId: hex(new ObjectId()), quantity: 1 }] });
    assert.deepEqual([wrongProduct.status, wrongProduct.body.error.details], [422, [{ field: 'products.0.productId', issue: 'incorrect' }]]);
    const right = await send('POST', `${SALES}/${id}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, productId: hex(pizza), quantity: 5 }] });
    assert.equal(right.status, 201);
    assert.deepEqual(anomalyCodes(await saleOf(id)), ['sale:refundExceedsSold']);
    assert.equal(await stockOf(pizza), 10, 'what was never sold is not loaded: the line is returned up to what was sold');
    for (const bad of [{ ...refundBody('R-2', 0, 0) }, { ...refundBody('R-2', 0, -1) }, { timestampId: 'R-2', date: '2026-11-28T09:00:00.000Z', products: [] }, refundBody('R 2', 0, 1), { ...refundBody('R-2', 0, 1), extra: 1 }]) {
      assert.equal((await send('POST', `${SALES}/${id}/refunds`, bad)).status, 422, JSON.stringify(bad));
    }
  });

  it('cancels a sale: the stock and the loyalty come back, a second cancellation answers 200 and a refund after it only adds an anomaly', async () => {
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza)]));
    const id = created.body.data.id as string;
    await send('POST', `${SALES}/${id}/refunds`, refundBody('R-1', 0, 1));
    assert.equal(await stockOf(pizza), 9);
    const canceled = await send('POST', `${SALES}/${id}/cancellation`, { date: '2026-11-28T10:00:00.000Z', operatorId: hex(new ObjectId()), fiscalReceiptInfo: { report: 103, number: 4, amount: 24.4 } });
    assert.equal(canceled.status, 201, JSON.stringify(canceled.body));
    assert.match(canceled.headers.get('location')!, new RegExp(`/store-context/sales/${id}/cancellation$`));
    assert.equal(canceled.body.data.fiscalState, 'canceled');
    assert.equal(await stockOf(pizza), 10);
    const sale = await saleOf(id);
    assert.deepEqual((sale['refund'] as Document[]).map((entry) => [entry['timestampId'], entry['canceled'] ?? false]), [['R-1', false], [null, true]], 'the refunds before it stay');
    assert.equal((sale['refund'] as Document[])[1]!['returnedGoods'][0]['returnedQt'], 1, 'what was left of the line');
    assert.equal(sale['fiscalState'], 'canceled');
    assert.equal(sale['floodCloud'].cancellation.fiscalReceiptInfo.number, 4);
    assert.deepEqual(anomalyCodes(sale), ['sale:operatorUnknown', 'sale:cancelAfterRefund']);
    const again = await send('POST', `${SALES}/${id}/cancellation`, { date: '2026-11-28T10:05:00.000Z' });
    assert.deepEqual([again.status, again.body.data.version], [200, canceled.body.data.version]);
    assert.equal(await stockOf(pizza), 10);
    const late = await send('POST', `${SALES}/${id}/refunds`, refundBody('R-2', 0, 1));
    assert.equal(late.status, 201);
    assert.equal(late.body.data.sale.fiscalState, 'canceled');
    assert.equal(await stockOf(pizza), 10, 'a refund of a canceled sale moves nothing');
    assert.ok(anomalyCodes(await saleOf(id)).includes('sale:refundAfterCancel'));
  });
});

describe('the deletion of a sale that is not fiscal', () => {
  it('reverses the warehouse and the loyalty and deletes it; a fiscal sale or one in an invoice is a 409', async () => {
    await loyaltySetup();
    const card = await advancedCard();
    const pizza = await product();
    const quote = await post(saleBody([saleLine(pizza)], { nonFiscal: true, fidelityCardCode: 'ADV-1', payments: { cash: 24.4 }, fiscalReceiptInfo: null }));
    assert.equal(quote.status, 201);
    assert.equal(quote.body.data.nonFiscal, true);
    assert.deepEqual([await stockOf(pizza), (await balanceOf(card))[1]], [8, 17]);
    const id = quote.body.data.id as string;
    const removed = await send('DELETE', `${SALES}/${id}`);
    assert.equal(removed.status, 204);
    assert.equal(await salesOf().countDocuments({ _id: new ObjectId(id) }), 0);
    assert.deepEqual([await stockOf(pizza), await balanceOf(card)], [10, [10, 5]]);
    assert.equal((await send('DELETE', `${SALES}/${id}`)).status, 404);
    const fiscal = await post(saleBody([saleLine(pizza)], { timestampId: 'T-f' }));
    const refused = await send('DELETE', `${SALES}/${fiscal.body.data.id}`);
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details], [409, 'CONFLICT', [{ field: 'nonFiscal', issue: 'fiscal' }]]);
    const invoiced = await post(saleBody([saleLine(pizza)], { timestampId: 'T-i', nonFiscal: true, fiscalReceiptInfo: null }));
    await salesOf().updateOne({ _id: new ObjectId(invoiced.body.data.id) }, { $set: { status: 'invoiced' } });
    assert.deepEqual([(await send('DELETE', `${SALES}/${invoiced.body.data.id}`)).status, await stockOf(pizza)], [409, 6]);
    assert.ok(world.office.activity.entries.some((entry) => entry.action === 'sale.deleted' && entry.resource!.id === id));
  });
});

describe('the amendment of a sale', () => {
  it('merges the payments, builds the customer again and writes nothing when the same patch comes again', async () => {
    const pizza = await product();
    const mario = legacyContact({});
    await contacts().insertOne(mario);
    const created = await post(saleBody([saleLine(pizza)], { payments: { cash: 24.4, specific: [{ type: 'satispay', name: 'Satispay', amount: 1 }] } }));
    const id = created.body.data.id as string;
    const patch = { payments: { cash: 0, electronic: 24.4 }, customer: { contactId: hex(mario['_id'] as ObjectId) }, lotteryCode: 'ABCD1234', fiscalReceiptInfo: { date: '2026-11-27T10:05:00.000Z', report: 101, number: 13, amount: 24.4 } };
    const patched = await send('PATCH', `${SALES}/${id}`, patch);
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual([patched.body.data.payments.cash, patched.body.data.payments.electronic, patched.body.data.lotteryCode, patched.body.data.customer, patched.body.data.fiscalReceiptInfo.number], [0, 24.4, 'ABCD1234', { contactId: hex(mario['_id'] as ObjectId) }, 13]);
    const sale = await saleOf(id);
    assert.deepEqual([sale['specificPayments'], sale['customerType'], sale['customer']['name']], [[{ type: 'satispay', name: 'Satispay', amount: 1 }], 1, 'Mario'], 'what was not sent stays');
    assert.equal((sale['updateDate'] as Date) instanceof Date, true);
    assert.deepEqual((sale['floodCloud'].operations as Document[]).map((operation) => operation['kind']), ['create', 'amend']);
    const again = await send('PATCH', `${SALES}/${id}`, patch);
    assert.deepEqual([again.status, again.body.data.version, again.headers.get('etag')], [200, patched.body.data.version, patched.headers.get('etag')]);
    assert.equal(((await saleOf(id))['floodCloud'].operations as Document[]).length, 2, 'nothing was written');
    // The customer can be taken away.
    assert.equal((await send('PATCH', `${SALES}/${id}`, { customer: null })).body.data.customer, null);
    assert.deepEqual([(await saleOf(id))['customer'], (await saleOf(id))['customerType']], [null, null]);
    const entry = world.office.activity.entries.filter((candidate) => candidate.action === 'sale.amended').at(-1)!;
    assert.equal(entry.metadata!['fields'], 'customer,customerType');
  });

  it('changes the card and reconciles the loyalty: the points of the old one come back and the new one gets them', async () => {
    await loyaltySetup();
    const first = await advancedCard();
    const second = await advancedCard({ code: 'ADV-2', pointsCollections: { 'pc-1': 0 }, balance: new Double(0) });
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza)], { fidelityCardCode: 'ADV-1' }));
    assert.deepEqual(await balanceOf(first), [10, 17]);
    const patched = await send('PATCH', `${SALES}/${created.body.data.id}`, { fidelityCardCode: 'ADV-2' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.deepEqual([await balanceOf(first), await balanceOf(second)], [[10, 5], [0, 12]]);
    assert.equal((await send('PATCH', `${SALES}/${created.body.data.id}`, { fidelityCardCode: null })).status, 200);
    assert.deepEqual(await balanceOf(second), [0, 0]);
  });

  it('checks the version of If-Match when the till sends one, and an operator that is not of the group is only an anomaly', async () => {
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza)]));
    const id = created.body.data.id as string;
    const stale = await send('PATCH', `${SALES}/${id}`, { lotteryCode: 'AAAA1111' }, { 'if-match': `"${'A'.repeat(43)}"` });
    assert.deepEqual([stale.status, stale.body.error.code], [412, 'PRECONDITION_FAILED']);
    assert.equal((await send('PATCH', `${SALES}/${id}`, { lotteryCode: 'AAAA1111' }, { 'if-match': 'W/"x"' })).status, 422);
    assert.equal((await send('PATCH', `${SALES}/${id}`, { lotteryCode: 'AAAA1111' }, { 'if-match': created.headers.get('etag')! })).status, 200);
    const unknown = await send('PATCH', `${SALES}/${id}`, { operatorId: hex(new ObjectId()), lotteryCode: 'CCCC3333' });
    assert.equal(unknown.status, 200);
    assert.deepEqual(anomalyCodes(await saleOf(id)), ['sale:operatorUnknown']);
    for (const bad of [{}, { products: [] }, { payments: { cash: 'x' } }, { totals: { total: 1 } }, { customer: { contactId: 'x' } }]) {
      assert.equal((await send('PATCH', `${SALES}/${id}`, bad)).status, 422, JSON.stringify(bad));
    }
    assert.equal((await send('DELETE', `${SALES}/${id}`, undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    const sale = await saleOf(id);
    await salesOf().updateOne({ _id: sale['_id'] }, { $set: { status: 'invoiced' } });
    assert.equal((await send('PATCH', `${SALES}/${id}`, { lotteryCode: 'BBBB2222' })).status, 200);
    assert.ok(anomalyCodes(await saleOf(id)).includes('sale:amendAfterInvoiced'));
  });
});

describe('a sale the legacy wrote', () => {
  /** A sale and its movement in the shape the legacy writes them: the movement has the `saleId` and no `origin`. */
  async function legacySale(productId: ObjectId, overrides: Document = {}): Promise<ObjectId> {
    const _id = new ObjectId();
    await salesOf().insertOne({
      _id,
      timestampId: `L-${hex(_id)}`,
      companyId: new ObjectId(store.companyId),
      placeId: own(),
      date: at(10),
      receiptType: 'receipt',
      sType: false,
      fiscalState: '',
      refund: [],
      customer: null,
      fidelityCard: null,
      products: [{ _id: productId, code: 'P', name: { it: 'Prodotto' }, qt: 2, freeProduct: false, price: { price: 10, taxed: 12.2, discount: 0, tax: 22, taxData: { ...LINE_TAX } } }],
      cashAmount: 24.4,
      finalTotalCheckout: 24.4,
      finalTotalTaxable: 20,
      finalTotalTax: 4.4,
      paymentDiscountAmount: 0,
      fiscalReceiptInfo: { date: at(10), number: 5, amount: 24.4, reportNumber: 7 },
      insertDate: at(10),
      updateDate: null,
      ...overrides,
    });
    await db().collection('warehouse').insertOne({ _id: new ObjectId(), type: 'D', rule: SALES_WAREHOUSE_RULES.d1, date: at(10), companyId: new ObjectId(store.companyId), placeId: own(), storageId: cashStorage, saleId: _id, records: [{ product: { _id: productId }, quantity: 2, value: 2 }] });
    await db().collection('products').updateOne({ _id: productId }, { $inc: { [`quantity.__${hex(own())}.__${hex(cashStorage)}.value`]: -2 } });
    return _id;
  }

  it('adopts it with the state it already has, then cancels it: the stock comes back once and the adoption is recorded', async () => {
    const pizza = await product();
    const id = await legacySale(pizza);
    assert.equal(await stockOf(pizza), 8);
    const read = await send('GET', `${SALES}/${hex(id)}`);
    assert.equal(read.status, 200);
    assert.deepEqual([read.body.data.timestampId, read.body.data.products[0].productId, read.body.data.fiscalReceiptInfo.number], [`L-${hex(id)}`, hex(pizza), 5]);
    assert.equal(await salesOf().countDocuments({ _id: id, floodCloud: { $exists: true } }), 0, 'a read adopts nothing');
    const canceled = await send('POST', `${SALES}/${hex(id)}/cancellation`, { date: '2026-11-28T10:00:00.000Z' });
    assert.equal(canceled.status, 201, JSON.stringify(canceled.body));
    assert.equal(await stockOf(pizza), 10);
    const sale = await saleOf(hex(id));
    assert.deepEqual([anomalyCodes(sale), sale['floodCloud'].legacy.stockBaseline.map((row: Document) => [row['productId'], row['value']]), sale['floodCloud'].createdBy], [['sale:legacyStateApproximated'], [[pizza, -2]], { kind: 'legacy' }]);
    assert.equal('key' in sale['floodCloud'], false, 'a sale of the legacy has no key: the legacy may hold duplicates');
    assert.equal((await send('POST', `${SALES}/${hex(id)}/cancellation`, { date: '2026-11-28T10:00:00.000Z' })).status, 200);
    assert.equal(await stockOf(pizza), 10);
  });

  it('refunds it and amends it from its state, with the loyalty rebuilt from the facts saved', async () => {
    await loyaltySetup();
    const card = await advancedCard({ balance: new Double(5.6), pointsCollections: { 'pc-1': 15 } });
    const pizza = await product();
    const id = await legacySale(pizza, { fidelityCard: { code: 'ADV-1' }, paymentDiscountAmount: 4.4, cashAmount: 20 });
    const refund = await send('POST', `${SALES}/${hex(id)}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    assert.equal(await stockOf(pizza), 9);
    assert.deepEqual(await balanceOf(card), [5.6, 9], 'the legacy gave floor(24.4 / 2) = 12 points on the gross total: half of them go; the credit stays');
    const canceled = await send('POST', `${SALES}/${hex(id)}/cancellation`, { date: '2026-11-28T10:00:00.000Z' });
    assert.equal(canceled.status, 201);
    assert.deepEqual([await stockOf(pizza), await balanceOf(card)], [10, [10, 3]], 'the credit used (4.4) and the points left (6) go back');
  });

  it('does not adopt a sale that is already canceled, and deletes a quote with the state it had', async () => {
    const pizza = await product();
    const canceled = await legacySale(pizza, { fiscalState: 'canceled' });
    const again = await send('POST', `${SALES}/${hex(canceled)}/cancellation`, { date: '2026-11-28T10:00:00.000Z' });
    assert.equal(again.status, 200);
    assert.equal(await stockOf(pizza), 8, 'nothing is moved: the legacy has already reversed what it moved');
    const quote = await legacySale(pizza, { sType: true, fiscalReceiptInfo: null });
    assert.equal(await stockOf(pizza), 6);
    assert.equal((await send('DELETE', `${SALES}/${hex(quote)}`)).status, 204);
    assert.equal(await stockOf(pizza), 8);
  });
});

describe('the lines of a sale', () => {
  it('accepts the whole product with fields it does not know, keeps only the allowlist and reads the identity, the costs and the stock flag from the catalog', async () => {
    const pizza = await product({ departmentId: 'dep-9' });
    const component = await product({ code: 'C-1', name: { it: 'Pomodoro' } });
    const noise = { description: 'long text', medias: [{ url: 'x' }], prices: [{ id: 'p' }], quantity: { __x: { __y: { value: 999 } } }, status: true, suppliers: ['a'], unknownField: { deep: [1, 2, { three: 3 }] }, name: { it: 'Nome del cliente' }, code: 'FAKE', type: 'fake', categories: ['fake'], availability: { warehouse: false, scales: true, pos: true }, bundleProducts: [{ _id: hex(component), quantity: 99 }], simpleCost: 999, _id: hex(pizza) };
    const created = await post(saleBody([saleLine(pizza, { ...noise, discountPercentage: 0, halfPortion: true, exit: 2, scaleType: 'kg', variant: { status: true, other: 1 }, modularBundle: { priceRule: 'sum', other: 1 } })]));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const [line] = (await saleOf(created.body.data.id))['products'] as Document[];
    for (const dropped of ['description', 'medias', 'prices', 'quantity', 'status', 'suppliers', 'unknownField']) {
      assert.equal(dropped in line!, false, dropped);
    }
    assert.deepEqual([line!['name'], line!['code'], line!['type'], line!['categories'], line!['departmentId'], line!['simpleCost']], [{ it: 'Prodotto', en: 'Product' }, line!['code'], 'product', ['cat-1'], 'dep-9', 3], 'the catalog says who the product is');
    assert.notEqual(line!['code'], 'FAKE');
    assert.deepEqual(line!['availability'], { warehouse: true, scales: true });
    assert.deepEqual(line!['bundleProducts'], [], 'the components come from the catalog');
    assert.deepEqual([line!['halfPortion'], line!['exit'], line!['scaleType'], line!['variant'], line!['modularBundle'], line!['discountPercentage']], [true, 2, 'kg', { status: true }, { priceRule: 'sum' }, 0]);
  });

  it('refuses a body that is not a body: forbidden keys, depth, size, types and unknown properties of the sale, the limits of 500 entries and 1 MB', async () => {
    const pizza = await product();
    const bad = async (body: Document, expected: Array<[string, string]>, status = 422): Promise<void> => {
      const reply = await post(body);
      assert.equal(reply.status, status, JSON.stringify(reply.body));
      if (status === 422) {
        assert.deepEqual(reply.body.error.details.map((detail: Document) => [detail['field'], detail['issue']]), expected);
      }
    };
    await bad(saleBody([saleLine(pizza, { $where: 'x' })]), [['products.0', 'forbiddenKey']]);
    await bad(saleBody([saleLine(pizza, { nested: { 'a.b': 1 } })]), [['products.0', 'forbiddenKey']]);
    await bad(saleBody([saleLine(pizza, { deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } })]), [['products.0', 'tooDeep']]);
    await bad(saleBody([saleLine(pizza, { text: 'x'.repeat(2001) })]), [['products.0', 'tooMany']]);
    await bad(saleBody([saleLine(pizza, { list: Array.from({ length: 201 }, () => 1) })]), [['products.0', 'tooMany']]);
    await bad(saleBody([saleLine(pizza, { many: Array.from({ length: 2100 }, (_, n) => ({ n })) })]), [['products.0', 'tooMany']]);
    await bad(saleBody([saleLine(pizza, { broken: '\ud800' })]), [['products.0', 'format']]);
    await bad(saleBody([saleLine(pizza)], { products: [1] }), [['products.0', 'type']]);
    await bad(saleBody([saleLine(pizza)], { products: [[1]] }), [['products.0', 'type']]);
    await bad(saleBody([saleLine(pizza)], { products: [] }), [['products', 'minLength']]);
    await bad(saleBody([saleLine(pizza)], { extra: 1 }), [['extra', 'unknown']]);
    await bad(saleBody([saleLine(pizza)], { receiptType: 'other' }), [['receiptType', 'enum']]);
    await bad(saleBody([saleLine(pizza)], { timestampId: 'a b' }), [['timestampId', 'pattern']]);
    await bad(saleBody([saleLine(pizza)], { date: '2026-02-30' }), [['date', 'format']]);
    await bad(saleBody([saleLine(pizza)], { totals: { taxable: 'x', tax: 1, total: 1 } }), [['totals.taxable', 'type']]);
    await bad(saleBody([saleLine(pizza)], { payments: { cash: 1e12 } }), [['payments.cash', 'maximum']]);
    await bad(saleBody([saleLine(pizza)], { unpaidSaleIds: [hex(new ObjectId())] }), [['unpaidSaleIds', 'incorrect']]);
    await bad(saleBody([saleLine(pizza)], { operatorId: 'x' }), [['operatorId', 'format']]);
    const entries = Array.from({ length: 501 }, (_, n) => saleLine(pizza, { timestampId: `l-${String(n)}` }));
    await bad(saleBody(entries), [['products', 'tooMany']]);
    const modifiers = Array.from({ length: 250 }, () => ({ _id: hex(pizza), qt: 1 }));
    await bad(saleBody([saleLine(pizza, { selectedVariants: { plus: modifiers.slice(0, 200), minus: modifiers.slice(0, 200) } }), saleLine(pizza, { modularBundleSelected: { products: modifiers.slice(0, 200) } })]), [['products', 'tooMany']]);
    assert.equal((await post(saleBody(Array.from({ length: 500 }, (_, n) => saleLine(pizza, { timestampId: `l-${String(n)}` })), { totals: { taxable: 0, tax: 0, total: 0 } }))).status, 201, '500 entries are fine');
    const big = await post(saleBody([saleLine(pizza, { padding: 'x'.repeat(1_100_000) })]));
    assert.equal(big.status, 413);
    assert.equal(await salesOf().countDocuments(), 1);
  });

  it('moves the warehouse for the modifiers, the menus and the lines returned inside the receipt, in load units, with the barcode', async () => {
    const cases = await product({ measureConversionRatio: 24, barcode: [{ value: 'BOX', qtLoad: 24 }] }, 10);
    const extra = await product({});
    const pick = await product({});
    const menu = await product({ availability: { pos: true, warehouse: false } });
    const free = saleLine(null, { freeProduct: true, name: { it: 'Varie' }, code: 'FREE', departmentId: 'd', qt: 1, timestampId: 'line-9' });
    const created = await post(
      saleBody(
        [
          saleLine(cases, { qt: 6, barcodeRead: 'BOX', selectedVariants: { plus: [{ _id: hex(extra), qt: 2, price: { price: 1, taxed: 1.22, tax: 22, junk: 1 }, name: { it: 'Falso' } }], minus: [{ _id: hex(pick), qt: 1 }], info: [{ name: { it: 'Senza sale' }, qt: 1 }, 'text'] } }),
          saleLine(menu, { qt: 2, timestampId: 'line-2', modularBundleSelected: { products: [{ _id: hex(pick), qt: 4, name: { it: 'x' } }, { qt: 1 }, 'x'] } }),
          saleLine(extra, { qt: -1, timestampId: 'line-3' }),
          free,
        ],
        { totals: { taxable: 0, tax: 0, total: 0 }, payments: {} },
      ),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // 6 pieces of a case of 24 unload a quarter; two extras unload 2 x 6 pieces of the base unit (1:1)...
    assert.equal(await stockOf(cases), 9.75);
    assert.equal(await stockOf(extra), 10 - 2 * 6 + 1, 'the modifier added unloads as a product (its quantity times the line), the line returned loads');
    assert.equal(await stockOf(pick), 6, 'the selections of the menu unload with the quantity the till scaled');
    const sale = await saleOf(created.body.data.id);
    const [first, second, , freeLine] = sale['products'] as Document[];
    assert.deepEqual(first!['selectedVariants'].plus, [{ _id: extra, code: first!['selectedVariants'].plus[0].code, name: { it: 'Prodotto', en: 'Product' }, type: 'product', qt: 2, price: { price: 1, taxed: 1.22, tax: 22 } }]);
    assert.deepEqual(first!['selectedVariants'].info, [{ name: { it: 'Senza sale' }, qt: 1 }]);
    assert.deepEqual(second!['modularBundleSelected'].products.map((entry: Document) => [entry['_id'], entry['qt']]), [[pick, 4]]);
    assert.deepEqual([freeLine!['freeProduct'], freeLine!['_id'], freeLine!['name'], freeLine!['code'], freeLine!['departmentId']], [true, null, { it: 'Varie' }, 'FREE', 'd']);
    // The cancellation reverses all of it.
    await send('POST', `${SALES}/${created.body.data.id}/cancellation`, { date: '2026-11-28T10:00:00.000Z' });
    assert.deepEqual([await stockOf(cases), await stockOf(extra), await stockOf(pick)], [10, 10, 10]);
  });

  it('records the checks of the server and never refuses for them', async () => {
    const pizza = await product();
    const created = await post(
      saleBody([saleLine(pizza, { price: { price: 10, taxed: 13, tax: 22, taxData: { id: 'tax-001', value: 10 } } }), saleLine(pizza, { qt: 'many', timestampId: 'line-2', price: { price: 1, taxed: 1 } })], {
        totals: { taxable: 30, tax: 1, total: 50, totalBeforeDiscount: 40, discount: { adjustment: 'discount', kind: 'value', value: 5 } },
        payments: { cash: 10 },
      }),
    );
    assert.equal(created.status, 201);
    const check = (await saleOf(created.body.data.id))['floodCloud'].serverCheck as Document;
    assert.equal(check['status'], 'differences');
    assert.deepEqual((check['lines'] as Document[]).map((line) => [line['index'], line['code']]).sort(), [[0, 'lineTotalMismatch'], [0, 'taxRateDiffers'], [1, 'quantityMissing'], [1, 'taxMissing']].sort());
    assert.deepEqual((check['totals'] as Document[]).map((total) => total['field']).sort(), ['payments', 'tax', 'taxable', 'total', 'totalBeforeDiscount']);
    assert.equal(check['linesTruncated'], false);
    // A cash drawer that gives the change back is not a difference: the payments are only compared with the total.
    const ok = await post(saleBody([saleLine(pizza)], { timestampId: 'T-ok', totals: { taxable: 20, tax: 4.4, total: 24.4 } }));
    assert.equal(ok.body.data.checks.status, 'ok');
  });
});

describe('the perimeter, the search and the limits of the sales of a store', () => {
  it('lets only the store key in, and only to its own point of sale: a sale of another point of sale or group is 404 everywhere', async () => {
    const pizza = await product();
    const mine = await post(saleBody([saleLine(pizza)], { timestampId: 'T-mine' }));
    const otherPlace = new ObjectId();
    const elsewhere = new ObjectId();
    const anotherGroup = new ObjectId();
    const base = { companyId: new ObjectId(store.companyId), date: at(5), sType: true, fiscalState: '', refund: [], products: [{ _id: pizza, qt: 1, price: {} }], finalTotalCheckout: 1, customer: null };
    await salesOf().insertMany([{ ...base, _id: elsewhere, placeId: otherPlace, timestampId: 'T-elsewhere' }]);
    await salesOf(1).insertOne({ ...base, _id: anotherGroup, placeId: own(), timestampId: 'T-other-group' });
    for (const id of [elsewhere, anotherGroup, new ObjectId()]) {
      for (const [method, path, body] of [
        ['GET', `${SALES}/${hex(id)}`, undefined],
        ['PATCH', `${SALES}/${hex(id)}`, { lotteryCode: 'AAAA1111' }],
        ['DELETE', `${SALES}/${hex(id)}`, undefined],
        ['POST', `${SALES}/${hex(id)}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] }],
        ['POST', `${SALES}/${hex(id)}/cancellation`, { date: '2026-11-28T09:00:00.000Z' }],
      ] as const) {
        assert.equal((await send(method, path, body)).status, 404, `${method} ${path}`);
      }
    }
    assert.deepEqual(await salesOf().countDocuments({ _id: elsewhere, floodCloud: { $exists: true } }), 0);
    assert.equal(await stockOf(pizza), 8);
    assert.deepEqual((await send('GET', `${SALES}?timestampId=T-elsewhere`)).body.data, [], 'a search finds only the sales of the point of sale of the key');
    assert.deepEqual((await send('GET', `${SALES}?timestampId=T-mine`)).body.data.map((item: Document) => item['id']), [mine.body.data.id]);
    // The same `timestampId` of another point of sale is no duplicate of this one's.
    assert.equal((await post(saleBody([saleLine(pizza)], { timestampId: 'T-elsewhere' }))).status, 201);
    // A backoffice user, no credential and a bad id.
    assert.equal((await world.as.call(world.group(0).sa, 'GET', `${SALES}`)).status, 403);
    assert.equal((await world.as.call(world.group(0).sa, 'POST', SALES, saleBody([saleLine(pizza)]))).status, 403);
    assert.equal((await send('GET', `${SALES}/${mine.body.data.id}`, undefined, {}, 'fc_sk_nope')).status, 401);
    assert.equal((await world.office.call('GET', `${SALES}/${mine.body.data.id}`, undefined)).status, 401);
    assert.equal((await send('GET', `${SALES}/nope`)).status, 422);
    const put = await send('PUT', `${SALES}/${mine.body.data.id}`, {});
    assert.equal(put.status, 405);
    assert.match(put.headers.get('allow')!, /GET/);
  });

  it('searches by timestampId, by the numbers of the fiscal receipt and by customer, the newest first, at most 10', async () => {
    const pizza = await product();
    const mario = legacyContact({});
    await contacts().insertOne(mario);
    const customer = { contactId: hex(mario['_id'] as ObjectId) };
    const ids: string[] = [];
    for (let n = 1; n <= 12; n += 1) {
      const created = await post(saleBody([saleLine(pizza, { qt: 1, price: { price: 10, taxed: 12.2, tax: 22 } })], { timestampId: `S-${String(n)}`, date: `2026-11-${String(n).padStart(2, '0')}T10:00:00.000Z`, customer, totals: { taxable: 10, tax: 2.2, total: 12.2 }, payments: { cash: 12.2 }, fiscalReceiptInfo: { report: n % 2, number: n, amount: 12.2 } }));
      assert.equal(created.status, 201);
      ids.push(created.body.data.id);
    }
    const last = await send('GET', `${SALES}?contactId=${customer.contactId}`);
    assert.deepEqual([last.body.data.length, last.body.data[0].id, last.body.page], [10, ids[11], { limit: 10, next: null }]);
    assert.deepEqual((await send('GET', `${SALES}?contactId=${customer.contactId}&limit=2`)).body.data.map((item: Document) => item['id']), [ids[11], ids[10]]);
    assert.deepEqual((await send('GET', `${SALES}?receiptNumber=5&reportNumber=1`)).body.data.map((item: Document) => item['id']), [ids[4]]);
    assert.deepEqual((await send('GET', `${SALES}?receiptNumber=5&reportNumber=0`)).body.data, []);
    assert.deepEqual((await send('GET', `${SALES}?reportNumber=1`)).body.data.length, 6);
    await salesOf().updateOne({ timestampId: 'S-5' }, { $set: { device: { settings: { serialNumber: 'SN-1' } } } });
    assert.deepEqual((await send('GET', `${SALES}?receiptNumber=5&serialNumber=SN-1`)).body.data.map((item: Document) => item['id']), [ids[4]]);
    assert.deepEqual((await send('GET', `${SALES}?receiptNumber=5&serialNumber=SN-2`)).body.data, []);
    for (const query of ['', 'limit=3', 'timestampId=a&contactId=' + customer.contactId, 'serialNumber=SN-1', 'contactId=x', 'limit=11&timestampId=a', 'timestampId=a b', 'receiptNumber=x', 'unknown=1&timestampId=a', 'timestampId=a&timestampId=b']) {
      assert.equal((await send('GET', `${SALES}${query === '' ? '' : `?${query}`}`)).status, 422, query);
    }
  });

  it('limits the writes of a key to its own budget, apart from the reads', async () => {
    const pizza = await product();
    const statuses: number[] = [];
    for (let n = 0; n < 42; n += 1) {
      statuses.push((await post(saleBody([saleLine(pizza, { qt: 1 })], { timestampId: `B-${String(n)}`, totals: { taxable: 10, tax: 2.2, total: 12.2 }, payments: { cash: 12.2 } }))).status);
    }
    assert.deepEqual([statuses.filter((status) => status === 201).length, statuses.slice(40)], [40, [429, 429]]);
    const refused = await post(saleBody([saleLine(pizza)], { timestampId: 'B-last' }));
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.equal((await send('GET', `${SALES}?timestampId=B-1`)).status, 200, 'a read is not a write of the budget');
    assert.equal(await salesOf().countDocuments({ timestampId: 'B-41' }), 0);
  });

  it('moves no stock in a group without the warehouse, in a place without the storage of the cash desks or without the rule, and says so', async () => {
    const pizza = await product();
    const common = ctx.databases.common();
    await common.collection('groups').updateOne({ _id: gid() }, { $set: { 'settings.warehouse': false } });
    const off = await post(saleBody([saleLine(pizza)], { timestampId: 'W-1' }));
    assert.equal(off.status, 201);
    assert.deepEqual([await stockOf(pizza), anomalyCodes(await saleOf(off.body.data.id))], [10, []]);
    await common.collection('groups').updateOne({ _id: gid() }, { $set: { 'settings.warehouse': true } });
    const storages = (await common.collection('places').findOne({ _id: own() }))!['storages'];
    await common.collection('places').updateOne({ _id: own() }, { $set: { storages: [{ id: new ObjectId(), cash: false }] } });
    const none = await post(saleBody([saleLine(pizza)], { timestampId: 'W-2' }));
    assert.deepEqual([none.status, await stockOf(pizza), anomalyCodes(await saleOf(none.body.data.id))], [201, 10, ['stock:noCashStorage']]);
    await common.collection('places').updateOne({ _id: own() }, { $set: { storages } });
    await common.collection('groups').updateOne({ _id: gid() }, { $set: { warehouseRules: {} } });
    const norule = await post(saleBody([saleLine(pizza)], { timestampId: 'W-3' }));
    assert.deepEqual([norule.status, await stockOf(pizza), anomalyCodes(await saleOf(norule.body.data.id))], [201, 10, ['stock:ruleMissing']]);
  });
});

describe('what the sales read of the database, tolerantly', () => {
  it('copes with a product and a contact that miss most of their fields', async () => {
    const bare = new ObjectId();
    await db().collection('products').insertOne({ _id: bare, code: 'BARE' });
    const rich = await product({ roomsSettings: { percentageFee: 5 }, bundleProducts: [{ _id: 'not an id', quantity: 1 }, { _id: new ObjectId(), quantity: 2, waste: 10 }], lastAveragePrice: undefined });
    const plain = new ObjectId();
    await contacts().insertOne({ _id: plain, name: 'Solo', surname: 'Nome' });
    const created = await post(saleBody([saleLine(bare, { qt: 1 }), saleLine(rich, { timestampId: 'line-2' })], { customer: { contactId: hex(plain) }, totals: { taxable: 30, tax: 6.6, total: 36.6 }, payments: { cash: 36.6 } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sale = await saleOf(created.body.data.id);
    const [first, second] = sale['products'] as Document[];
    assert.deepEqual([first!['availability'], first!['bundleProducts'], first!['categories'], 'simpleCost' in first!, 'lastAveragePrice' in first!, 'roomsSettings' in first!], [{ warehouse: false }, [], [], false, false, false]);
    assert.deepEqual([second!['roomsSettings'], second!['bundleProducts'].length, second!['bundleProducts'][0].waste, 'lastAveragePrice' in second!], [{ percentageFee: 5 }, 1, 10, false]);
    assert.deepEqual([sale['customer']['name'], 'fidelities' in sale['customer'], sale['customerType']], ['Solo', false, 1]);
  });

  it('records the anomaly of a customer that is missing or in the trash when the sale is amended, and the points that go below zero with their collection', async () => {
    await loyaltySetup();
    const card = await advancedCard();
    const pizza = await product();
    const mario = legacyContact({});
    const trashed = legacyContact({ trash: true });
    await contacts().insertMany([mario, trashed]);
    const created = await post(saleBody([saleLine(pizza)], { fidelityCardCode: 'ADV-1', customer: { contactId: hex(mario['_id'] as ObjectId) } }));
    const id = created.body.data.id as string;
    assert.equal((await send('PATCH', `${SALES}/${id}`, { customer: { contactId: hex(new ObjectId()) } })).status, 200);
    assert.equal((await send('PATCH', `${SALES}/${id}`, { customer: { contactId: hex(trashed['_id'] as ObjectId) } })).status, 200);
    assert.deepEqual(anomalyCodes(await saleOf(id)), ['sale:customerMissing', 'sale:customerTrashed']);
    await cards().updateOne({ _id: card }, { $set: { 'pointsCollections.pc-1': 2 } });
    const canceled = await send('POST', `${SALES}/${id}/cancellation`, { date: '2026-11-28T10:00:00.000Z' });
    assert.equal(canceled.status, 201);
    const sale = await saleOf(id);
    assert.deepEqual((sale['floodCloud'].anomalies as Document[]).filter((anomaly) => anomaly['code'] === 'negativePoints').map((anomaly) => anomaly['collectionId']), ['pc-1']);
  });

  it('refunds and amends a sale the legacy had already canceled without moving anything', async () => {
    await loyaltySetup();
    const card = await advancedCard({ balance: new Double(10), pointsCollections: { 'pc-1': 5 } });
    const pizza = await product();
    const _id = new ObjectId();
    await salesOf().insertOne({ _id, timestampId: 'L-canceled', companyId: new ObjectId(store.companyId), placeId: own(), date: at(10), receiptType: 'receipt', sType: false, fiscalState: 'canceled', refund: [], fidelityCard: { code: 'ADV-1' }, finalTotalCheckout: 24.4, paymentDiscountAmount: 0, products: [{ _id: pizza, qt: 2, price: { price: 10, taxed: 12.2, tax: 22 } }], insertDate: at(10), updateDate: null });
    const refunded = await send('POST', `${SALES}/${hex(_id)}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] });
    assert.equal(refunded.status, 201, JSON.stringify(refunded.body));
    const sale = await saleOf(hex(_id));
    assert.deepEqual([sale['fiscalState'], sale['floodCloud'].legacy.stockBaseline, sale['floodCloud'].loyalty.applied, anomalyCodes(sale)], ['canceled', [], null, ['sale:legacyStateApproximated', 'sale:refundAfterCancel']]);
    assert.deepEqual([await stockOf(pizza), await balanceOf(card)], [10, [10, 5]]);
  });
});


/** A user of the group that works at the point of sale of the key (or at another one): the set the store reads from `GET /store-context/users`. */
async function operatorUser(n: number, overrides: Document = {}): Promise<ObjectId> {
  const document = legacyUser(n, { groupId: gid(), dealerId: world.group(0).dealerId, role: 'E', placeId: own(), placesId: [own()], ...overrides });
  await ctx.databases.common().collection('users').deleteOne({ _id: document['_id'] });
  await ctx.databases.common().collection('users').insertOne(document);
  return document['_id'] as ObjectId;
}
const refillBody = (refill: ObjectId | null, overrides: Document = {}, line: Document = {}) =>
  saleBody([refill === null ? saleLine(null, { qt: 2, name: { it: 'Ricarica' }, code: '000-r-multi-50', price: { price: 40.98, taxed: 50, discount: 0, tax: 22 }, ...line }) : saleLine(refill, { qt: 2, price: { price: 40.98, taxed: 50, discount: 0, tax: 22 }, ...line })], { fidelityCardCode: 'ADV-1', totals: { taxable: 81.97, tax: 18.03, total: 100 }, payments: { cash: 100 }, ...overrides });

describe('the credit of a sale (corrections of the security review)', () => {
  it('refuses a credit used that is negative, when the sale is created and when it is amended', async () => {
    const pizza = await product();
    const bad = await post(saleBody([saleLine(pizza)], { payments: { cash: 24.4, fidelityCredit: -5 } }));
    assert.deepEqual([bad.status, bad.body.error.details], [422, [{ field: 'payments.fidelityCredit', issue: 'minimum' }]]);
    const created = await post(saleBody([saleLine(pizza)]));
    const patched = await send('PATCH', `${SALES}/${created.body.data.id}`, { payments: { fidelityCredit: -0.01 } });
    assert.deepEqual([patched.status, patched.body.error.details], [422, [{ field: 'payments.fidelityCredit', issue: 'minimum' }]]);
    assert.equal(await salesOf().countDocuments(), 1);
  });

  it('counts a refill only on a product of the catalog, warns when it is not covered, alerts on the credit added, and takes the refill back with a refund, once and never beyond what was applied', async () => {
    await loyaltySetup();
    const card = await advancedCard({ balance: new Double(10), pointsCollections: { 'pc-1': 0 } });
    const refill = await product({ code: '000-r-multi-50' });
    const operator = await operatorUser(910);
    const mark = world.office.activity.entries.length;
    const created = await post(refillBody(refill, { operatorId: hex(operator) }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(await balanceOf(card), [110, 0], 'the refill is credit, and it is not worth points');
    const alerts = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.creditAlert');
    assert.deepEqual(alerts.map((entry) => [entry.metadata!['reason'], entry.metadata!['amount'], entry.metadata!['threshold'], entry.metadata!['operatorId'], entry.actor.kind]), [['operation', 100, 50, hex(operator), 'store']]);
    // Without an operator the alert has none.
    const again = await post(refillBody(refill, { timestampId: 'T-2' }));
    assert.equal(again.status, 201);
    const second = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.creditAlert').at(-1)!;
    assert.equal('operatorId' in second.metadata!, false);
    assert.deepEqual(await balanceOf(card), [210, 0]);
    // A refund of one of the two refill units takes 50 back; another, beyond the quantity sold, takes the rest and no more.
    const id = created.body.data.id as string;
    const one = await send('POST', `${SALES}/${id}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] });
    assert.equal(one.status, 201, JSON.stringify(one.body));
    assert.deepEqual(await balanceOf(card), [160, 0]);
    assert.equal((await send('POST', `${SALES}/${id}/refunds`, { timestampId: 'R-2', date: '2026-11-28T09:30:00.000Z', products: [{ index: 0, quantity: 5 }] })).status, 201);
    assert.deepEqual(await balanceOf(card), [110, 0], 'never beyond the 100 of the sale');
    assert.equal((await send('POST', `${SALES}/${id}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] })).status, 200);
    assert.deepEqual(await balanceOf(card), [110, 0]);
    // The cancellation after the refunds reverses what is left, which is nothing.
    assert.equal((await send('POST', `${SALES}/${id}/cancellation`, { date: '2026-11-29T09:00:00.000Z' })).status, 201);
    assert.deepEqual(await balanceOf(card), [110, 0]);
    assert.deepEqual(anomalyCodes(await saleOf(id)), ['sale:refundExceedsSold', 'sale:cancelAfterRefund']);
  });

  it('gives no credit to a refill that is not a product of the catalog, and says so', async () => {
    await loyaltySetup();
    const card = await advancedCard({ balance: new Double(10), pointsCollections: { 'pc-1': 0 } });
    const free = await post(refillBody(null, { timestampId: 'T-free' }));
    assert.equal(free.status, 201);
    const missing = await post(refillBody(null, { timestampId: 'T-missing' }, { _id: hex(new ObjectId()) }));
    assert.equal(missing.status, 201);
    assert.deepEqual(await balanceOf(card), [10, 100], 'no credit; the 100 paid in cash count for points as any other sale (50 each)');
    assert.deepEqual(anomalyCodes(await saleOf(free.body.data.id)).filter((code) => code.startsWith('sale:')), ['sale:refillNotInCatalog']);
    assert.ok(anomalyCodes(await saleOf(missing.body.data.id)).includes('sale:refillNotInCatalog'));
    const refill = await product({ code: '000-r-mono-1' });
    const short = await post(refillBody(refill, { timestampId: 'T-short', payments: { cash: 40 } }));
    assert.ok(anomalyCodes(await saleOf(short.body.data.id)).includes('sale:refillNotCovered'));
    assert.equal((await post(refillBody(refill, { timestampId: 'T-ok' }))).status, 201);
    assert.ok(!anomalyCodes(await saleOf((await send('GET', `${SALES}?timestampId=T-ok`)).body.data[0].id)).includes('sale:refillNotCovered'));
  });
});

describe('the deletion of a quote (corrections of the security review)', () => {
  const legacyQuote = async (sType: unknown, fiscalReceiptInfo: unknown): Promise<string> => {
    const _id = new ObjectId();
    await salesOf().insertOne({ _id, timestampId: `Q-${hex(_id)}`, placeId: own(), companyId: new ObjectId(store.companyId), date: at(10), sType, fiscalReceiptInfo, products: [], refund: [], finalTotalCheckout: 1 });
    return hex(_id);
  };

  it('deletes only a sale whose sType is exactly true and that has no fiscal number', async () => {
    for (const sType of ['false', 1, 'S', 'true', false, null]) {
      assert.equal((await send('DELETE', `${SALES}/${await legacyQuote(sType, null)}`)).status, 409, String(sType));
    }
    assert.equal((await send('DELETE', `${SALES}/${await legacyQuote(true, { number: 3 })}`)).status, 409);
    assert.equal((await send('DELETE', `${SALES}/${await legacyQuote(true, { number: null })}`)).status, 204);
    assert.equal((await send('DELETE', `${SALES}/${await legacyQuote(true, undefined)}`)).status, 204);
    const pizza = await product();
    const quote = await post(saleBody([saleLine(pizza)], { nonFiscal: true, fiscalReceiptInfo: null }));
    assert.equal((await send('PATCH', `${SALES}/${quote.body.data.id}`, { fiscalReceiptInfo: { report: 1, number: 5 } })).status, 200);
    const refused = await send('DELETE', `${SALES}/${quote.body.data.id}`);
    assert.deepEqual([refused.status, refused.body.error.details, await stockOf(pizza)], [409, [{ field: 'nonFiscal', issue: 'fiscal' }], 8]);
  });

  it('never makes a deleted quote again: its key answers 200 with the deletion, whatever the body, with no effect', async () => {
    const pizza = await product();
    const quote = await post(saleBody([saleLine(pizza)], { timestampId: 'Q-1', nonFiscal: true, fiscalReceiptInfo: null }));
    assert.equal((await send('DELETE', `${SALES}/${quote.body.data.id}`)).status, 204);
    assert.equal(await stockOf(pizza), 10);
    const mark = world.office.activity.entries.length;
    for (const body of [saleBody([saleLine(pizza)], { timestampId: 'Q-1', nonFiscal: true, fiscalReceiptInfo: null }), saleBody([saleLine(pizza, { qt: 1 })], { timestampId: 'Q-1' })]) {
      const again = await post(body);
      assert.deepEqual([again.status, again.body.data, again.headers.get('location')], [200, { status: 'deleted', saleId: quote.body.data.id, timestampId: 'Q-1' }, null]);
    }
    assert.deepEqual([await salesOf().countDocuments(), await stockOf(pizza), world.office.activity.entries.slice(mark).length], [0, 10, 0]);
    // The sale that replaces it has a new timestampId and is made as usual; a quote of the legacy leaves its tombstone too.
    assert.equal((await post(saleBody([saleLine(pizza)], { timestampId: 'Q-2' }))).status, 201);
    const legacy = new ObjectId();
    await salesOf().insertOne({ _id: legacy, timestampId: 'Q-legacy', placeId: own(), companyId: new ObjectId(store.companyId), date: at(10), sType: true, fiscalReceiptInfo: null, products: [], refund: [], finalTotalCheckout: 1 });
    assert.equal((await send('DELETE', `${SALES}/${hex(legacy)}`)).status, 204);
    assert.deepEqual((await post(saleBody([saleLine(pizza)], { timestampId: 'Q-legacy' }))).body.data, { status: 'deleted', saleId: hex(legacy), timestampId: 'Q-legacy' });
    assert.deepEqual((await ctx.databases.group(gid(), 'cluster0').collection('sales_tombstones').find({}).project({ _id: 0, key: 1 }).toArray()).map((row) => row['key']).sort(), [`${hex(own())}|Q-1`, `${hex(own())}|Q-legacy`].sort());
  });
});

describe('the card of a sale, read by its id (corrections of the security review)', () => {
  const sale = (pizza: ObjectId, timestampId: string, code: string) => saleBody([saleLine(pizza, { qt: 1 })], { timestampId, fidelityCardCode: code, totals: { taxable: 10, tax: 2.2, total: 12.2 }, payments: { cash: 12.2 } });

  it('answers with the card the sale applied even when other cards have codes that differ by spaces , and with nothing when the card is gone', async () => {
    await loyaltySetup();
    const plain = await advancedCard({ code: 'ABC', balance: new Double(1) });
    const before = await advancedCard({ code: ' ABC', balance: new Double(2) });
    const after = await advancedCard({ code: 'ABC ', balance: new Double(3) });
    const pizza = await product();
    const created = await post(sale(pizza, 'C-1', 'ABC'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([created.body.data.fidelity.balance, (await balanceOf(plain))[1], (await balanceOf(before))[1], (await balanceOf(after))[1]], [1, 11, 5, 5]);
    await cards().deleteOne({ _id: plain });
    const duplicate = await post(sale(pizza, 'C-1', 'ABC'));
    assert.deepEqual([duplicate.status, duplicate.body.data.fidelity], [200, { cardCode: 'ABC', balance: null, points: [] }]);
  });

  it('finds the only card whose stored code has spaces around it', async () => {
    await loyaltySetup();
    await advancedCard({ code: ' ABC', balance: new Double(2) });
    const created = await post(sale(await product(), 'C-2', 'ABC'));
    assert.deepEqual([created.status, created.body.data.fidelity.balance], [201, 2]);
  });
});

describe('the numbers of a line (corrections of the security review)', () => {
  it('discards a quantity or a price beyond the bounds, records it, and never refuses the sale', async () => {
    const pizza = await product();
    const extra = await product();
    const created = await post(
      saleBody([saleLine(pizza, { qt: 2_000_000 }), saleLine(pizza, { qt: 1, timestampId: 'line-2', price: { price: 10, taxed: 1e12, tax: 22 } }), saleLine(pizza, { qt: 1, timestampId: 'line-3', selectedVariants: { plus: [{ _id: hex(extra), qt: 9e9 }] }, modularBundleSelected: { products: [{ _id: hex(extra), qt: 9e9 }] } })], { totals: { taxable: 1, tax: 0, total: 1 }, payments: { cash: 1 } }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sale = await saleOf(created.body.data.id);
    const lines = sale['products'] as Document[];
    assert.deepEqual([lines[0]!['qt'], 'taxed' in lines[1]!['price'], lines[2]!['selectedVariants'].plus[0].qt, lines[2]!['modularBundleSelected'].products[0].qt], [0, false, undefined, undefined]);
    assert.deepEqual((sale['floodCloud'].serverCheck.lines as Document[]).map((line) => `${String(line['index'])}:${String(line['code'])}`).filter((code) => /Missing/.test(code)), ['0:quantityMissing', '1:priceMissing', '2:quantityMissing']);
    assert.deepEqual([await stockOf(pizza), await stockOf(extra)], [8, 10], 'only what is a real quantity moves');
  });
});

describe('what is refused to a store key and to a hostile body (corrections of the security review)', () => {
  it('refuses __proto__ and constructor keys in the product object', async () => {
    const pizza = await product();
    for (const key of ['__proto__', 'constructor']) {
      const line = JSON.parse(`{"${key}":{"x":1},"qt":1}`) as Document;
      const reply = await post(saleBody([line]));
      assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'products.0', issue: 'forbiddenKey' }]], key);
    }
    assert.equal(await salesOf().countDocuments(), 0);
    assert.equal(await stockOf(pizza), 10);
  });

  it('answers 401 to a revoked key and STORE_DISABLED to a store that is not operational, on every route of the sales', async () => {
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza)]));
    const id = created.body.data.id as string;
    const calls: Array<[string, string, unknown]> = [
      ['POST', SALES, saleBody([saleLine(pizza)], { timestampId: 'X-1' })],
      ['GET', `${SALES}?timestampId=T-1`, undefined],
      ['GET', `${SALES}/${id}`, undefined],
      ['PATCH', `${SALES}/${id}`, { lotteryCode: 'AAAA1111' }],
      ['POST', `${SALES}/${id}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] }],
      ['POST', `${SALES}/${id}/cancellation`, { date: '2026-11-28T09:00:00.000Z' }],
      ['DELETE', `${SALES}/${id}`, undefined],
    ];
    const old = store;
    store = await world.activate(own());
    const copies = ctx.databases.common().collection('places');
    try {
      for (const [method, path, body] of calls) {
        assert.equal((await send(method, path, body, {}, old.key)).status, 401, `revoked: ${method} ${path}`);
      }
      await copies.updateOne({ _id: own() }, { $set: { status: false } });
      for (const [method, path, body] of calls) {
        const blocked = await send(method, path, body);
        assert.deepEqual([blocked.status, blocked.body.error.code], [403, 'STORE_DISABLED'], `${method} ${path}`);
      }
    } finally {
      await copies.updateOne({ _id: own() }, { $set: { status: true } });
    }
    assert.equal(await salesOf().countDocuments(), 1);
    assert.equal(await stockOf(pizza), 8);
  });

  it('accepts as an operator only a user of the set the store reads, and records any other as unknown', async () => {
    const pizza = await product();
    const elsewhere = await operatorUser(911, { placeId: new ObjectId(), placesId: [new ObjectId()] });
    const created = await post(saleBody([saleLine(pizza)], { operatorId: hex(elsewhere) }));
    assert.equal(created.status, 201);
    const sale = await saleOf(created.body.data.id);
    assert.deepEqual([sale['userId'], anomalyCodes(sale)], [null, ['sale:operatorUnknown']]);
    const listed = await send('GET', '/store-context/users');
    assert.ok(!(listed.body.data as Array<{ id: string }>).some((user) => user.id === hex(elsewhere)));
  });

  it('keeps a sale to 200 entries of refunds, leaving room for its cancellation', async () => {
    const pizza = await product();
    const created = await post(saleBody([saleLine(pizza, { qt: 400 })], { totals: { taxable: 1, tax: 0, total: 1 }, payments: { cash: 1 } }));
    const id = created.body.data.id as string;
    const dummy = (n: number) => Array.from({ length: n }, (_, index) => ({ timestampId: `D-${String(index)}`, returnedGoods: [], returnedGoodsValue: { priceTaxed: 0 } }));
    const refund = (name: string) => send('POST', `${SALES}/${id}/refunds`, { timestampId: name, date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] });
    await salesOf().updateOne({ _id: new ObjectId(id) }, { $set: { refund: dummy(198) } });
    assert.equal((await refund('R-ok')).status, 201, 'the 199th');
    const full = await refund('R-too-many');
    assert.deepEqual([full.status, full.body.error.code, full.body.error.details], [409, 'CONFLICT', [{ field: 'refund', issue: 'refundsLimit' }]]);
    assert.equal((await refund('R-ok')).status, 200, 'a refund already registered is still answered');
    assert.equal((await send('POST', `${SALES}/${id}/cancellation`, { date: '2026-11-29T09:00:00.000Z' })).status, 201, 'the cancellation fits in the 200th');
    await salesOf().updateOne({ _id: new ObjectId(id) }, { $set: { fiscalState: '', refund: dummy(200) } });
    const refused = await send('POST', `${SALES}/${id}/cancellation`, { date: '2026-11-29T09:00:00.000Z' });
    assert.deepEqual([refused.status, refused.body.error.details], [409, [{ field: 'refund', issue: 'refundsLimit' }]]);
  });
});

describe('the sale of a split table and the sales of the legacy that the loyalty adopts (corrections of the security review)', () => {
  it('saves a partitioned sale with its products, moves the stock, gives no loyalty effect, and the reads of the backoffice still leave it out', async () => {
    await loyaltySetup();
    const card = await advancedCard();
    const pizza = await product();
    const mother = await post(saleBody([saleLine(pizza)], { receiptType: 'partitioned', fidelityCardCode: 'ADV-1', fiscalReceiptInfo: null }));
    assert.equal(mother.status, 201, JSON.stringify(mother.body));
    assert.deepEqual([mother.body.data.receiptType, await stockOf(pizza), await balanceOf(card)], ['partitioned', 8, [10, 5]]);
    const sale = await saleOf(mother.body.data.id);
    assert.deepEqual([anomalyCodes(sale), sale['floodCloud'].loyalty.applied, (await cardMovements().countDocuments())], [['sale:partitionedLoyalty'], null, 0], 'the card it carries is recorded, never applied');
    const part = await post(saleBody([saleLine(null, { qt: 1, name: { it: 'Pasto completo' }, price: { price: 10, taxed: 12.2, tax: 22 } })], { timestampId: 'T-part', fidelityCardCode: 'ADV-1', totals: { taxable: 10, tax: 2.2, total: 12.2 }, payments: { cash: 12.2 } }));
    assert.equal(part.status, 201);
    assert.deepEqual(await balanceOf(card), [10, 11], 'the points accrue on the fiscal part: 12.2 / 2');
    // The cancellation of the mother reverses the stock and does nothing to the card.
    assert.equal((await send('POST', `${SALES}/${mother.body.data.id}/cancellation`, { date: '2026-11-28T09:00:00.000Z' })).status, 201);
    assert.deepEqual([await stockOf(pizza), await balanceOf(card)], [10, [10, 11]]);
    // The reads of the backoffice leave the mother out, as before.
    const list = await world.as.call(world.group(0).sa, 'GET', `/groups/${hex(gid())}/sales?from=2026-01-01&to=2026-12-31`);
    assert.deepEqual(list.body.data.map((row: Document) => row['id']), [part.body.data.id]);
    assert.equal((await world.as.call(world.group(0).sa, 'GET', `/groups/${hex(gid())}/sales/${mother.body.data.id}`)).status, 404);
    const summary = await world.as.call(world.group(0).sa, 'GET', `/groups/${hex(gid())}/sales/summary?from=2026-01-01&to=2026-12-31`);
    assert.equal(summary.body.data.count, 1);
  });

  const legacyDoc = async (overrides: Document): Promise<ObjectId> => {
    const _id = new ObjectId();
    await salesOf().insertOne({ _id, timestampId: `L-${hex(_id)}`, companyId: new ObjectId(store.companyId), placeId: own(), date: at(10), receiptType: 'receipt', sType: false, fiscalState: '', refund: [], customer: null, products: [], finalTotalCheckout: 50, paymentDiscountAmount: 0, insertDate: at(10), updateDate: null, ...overrides });
    return _id;
  };

  it('rebuilds the loyalty of a sale of the legacy with the legacy formulas on the gross total, and nothing for a card that did not exist yet', async () => {
    await loyaltySetup();
    const mario = legacyContact({ fidelities: [{ code: 'SIMPLE-1', points: 20 }] });
    await contacts().insertOne(mario);
    const simple = await legacyDoc({ fidelityCard: { code: 'SIMPLE-1' }, paymentDiscountAmount: 20 });
    assert.equal((await send('POST', `${SALES}/${hex(simple)}/cancellation`, { date: '2026-11-28T09:00:00.000Z' })).status, 201);
    assert.equal(((await contacts().findOne({ _id: mario['_id'] }))!['fidelities'] as Document[])[0]!['points'], 10, 'the legacy gave floor(50 / 5) = 10 points on the gross total');
    const late = await advancedCard({ code: 'LATE', insertDate: at(20), balance: new Double(0), pointsCollections: { 'pc-1': 0 } });
    const afterSale = await legacyDoc({ fidelityCard: { code: 'LATE' }, paymentDiscountAmount: 20 });
    assert.equal((await send('POST', `${SALES}/${hex(afterSale)}/cancellation`, { date: '2026-11-28T09:00:00.000Z' })).status, 201);
    assert.deepEqual(await balanceOf(late), [0, 0], 'no credit is given back that the legacy never charged');
    assert.ok(anomalyCodes(await saleOf(hex(afterSale))).includes('loyalty:legacyCardAfterSale'));
    const noDate = await advancedCard({ code: 'NODATE', insertDate: undefined, balance: new Double(0), pointsCollections: { 'pc-1': 0 } });
    const unknown = await legacyDoc({ fidelityCard: { code: 'NODATE' }, paymentDiscountAmount: 20 });
    await send('POST', `${SALES}/${hex(unknown)}/cancellation`, { date: '2026-11-28T09:00:00.000Z' });
    assert.deepEqual(await balanceOf(noDate), [0, 0]);
    // An advanced card that existed gets the legacy points and refills as stored.
    const ok = await advancedCard({ code: 'OLD', balance: new Double(100), pointsCollections: { 'pc-1': 25 } });
    const refilled = await legacyDoc({ fidelityCard: { code: 'OLD' }, paymentDiscountAmount: 20, products: [{ _id: new ObjectId(), code: '000-r-multi-1', qt: 1, price: { taxed: 30 } }], placeId: own() });
    await send('POST', `${SALES}/${hex(refilled)}/cancellation`, { date: '2026-11-28T09:00:00.000Z' });
    assert.deepEqual(await balanceOf(ok), [90, 0], 'the legacy: +30 of refill -20 of credit used = +10 charged; points floor(50 / 2) = 25 given: all of it goes back');
  });

  it('adopts a partitioned sale of the legacy without loyalty effects', async () => {
    await loyaltySetup();
    const card = await advancedCard();
    const mother = await legacyDoc({ receiptType: 'partitioned', fidelityCard: { code: 'ADV-1' } });
    assert.equal((await send('POST', `${SALES}/${hex(mother)}/cancellation`, { date: '2026-11-28T09:00:00.000Z' })).status, 201);
    assert.deepEqual(await balanceOf(card), [10, 5]);
    assert.equal((await saleOf(hex(mother)))['floodCloud'].loyalty.applied, null);
  });
});


describe('the last corrections of the security review', () => {
  it('never gives credit back with a refund: a line that was not sold cannot be returned, and a negative refill price returns nothing', async () => {
    await loyaltySetup();
    const card = await advancedCard({ balance: new Double(10), pointsCollections: { 'pc-1': 0 } });
    const refill = await product({ code: '000-r-multi-50' });
    const pizza = await product();
    // A line sold with a negative quantity (a return inside the receipt) is not returnable.
    const withReturn = await post(refillBody(refill, { timestampId: 'N-1' }, {}));
    assert.equal(withReturn.status, 201);
    const mixed = await post(saleBody([saleLine(pizza, { qt: -1 })], { timestampId: 'N-2', totals: { taxable: -10, tax: -2.2, total: -12.2 }, payments: { cash: -12.2 } }));
    assert.equal(mixed.status, 201);
    const refused = await send('POST', `${SALES}/${mixed.body.data.id}/refunds`, { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] });
    assert.deepEqual([refused.status, refused.body.error.details], [422, [{ field: 'products.0.index', issue: 'incorrect' }]]);
    // A refill with a negative price: the refund of its line gives nothing back.
    const negative = await post(refillBody(refill, { timestampId: 'N-3', totals: { taxable: -81.97, tax: -18.03, total: -100 }, payments: { cash: 0 } }, { price: { price: -40.98, taxed: -50, discount: 0, tax: 22 } }));
    assert.equal(negative.status, 201);
    const before = await balanceOf(card);
    const refunded = await send('POST', `${SALES}/${negative.body.data.id}/refunds`, { timestampId: 'R-2', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 2 }] });
    assert.equal(refunded.status, 201, JSON.stringify(refunded.body));
    assert.equal((await balanceOf(card))[0] >= before[0], true, 'no credit is given by a refund');
  });

  it('records the loyalty a partitioned sale carries and never applies it', async () => {
    await loyaltySetup();
    const card = await advancedCard();
    const pizza = await product();
    const refill = await product({ code: '000-r-mono-1' });
    const mother = (timestampId: string, overrides: Document, line: ObjectId = pizza) => post(saleBody([saleLine(line)], { timestampId, receiptType: 'partitioned', fiscalReceiptInfo: null, ...overrides }));
    const codes = async (reply: { body: { data: { id: string } } }) => anomalyCodes(await saleOf(reply.body.data.id));
    assert.deepEqual(await codes(await mother('P-0', {})), []);
    assert.deepEqual(await codes(await mother('P-1', { fidelityCardCode: 'ADV-1' })), ['sale:partitionedLoyalty']);
    assert.deepEqual(await codes(await mother('P-2', { payments: { cash: 20, fidelityCredit: 4.4 } })), ['sale:partitionedLoyalty']);
    assert.deepEqual(await codes(await mother('P-3', { fidelityCardCode: null }, refill)), ['sale:partitionedLoyalty']);
    assert.deepEqual([await balanceOf(card), await cardMovements().countDocuments()], [[10, 5], 0]);
  });

  it('deletes a second quote of the legacy that has the same timestampId as one already deleted', async () => {
    const quote = (id: ObjectId) => salesOf().insertOne({ _id: id, timestampId: 'DUP', placeId: own(), companyId: new ObjectId(store.companyId), date: at(10), sType: true, fiscalReceiptInfo: null, products: [], refund: [], finalTotalCheckout: 1 });
    const [first, second] = [new ObjectId(), new ObjectId()];
    await quote(first);
    await quote(second);
    assert.deepEqual([(await send('DELETE', `${SALES}/${hex(first)}`)).status, (await send('DELETE', `${SALES}/${hex(second)}`)).status], [204, 204]);
    const stones = await ctx.databases.group(gid(), 'cluster0').collection('sales_tombstones').find({}).toArray();
    assert.deepEqual(stones.map((stone) => stone['saleId']), [first], 'the key keeps the first tombstone');
  });

  it('alerts the credit added when an amendment moves a sale with refills to another advanced card', async () => {
    await loyaltySetup();
    await advancedCard({ balance: new Double(10), pointsCollections: { 'pc-1': 0 } });
    const second = await advancedCard({ code: 'ADV-2', balance: new Double(0), pointsCollections: { 'pc-1': 0 } });
    const refill = await product({ code: '000-r-multi-50' });
    const created = await post(refillBody(refill));
    const mark = world.office.activity.entries.length;
    const alerts = () => world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.creditAlert');
    assert.equal((await send('PATCH', `${SALES}/${created.body.data.id}`, { lotteryCode: 'AAAA1111' })).status, 200);
    assert.equal(alerts().length, 0, 'the same card: nothing new');
    assert.equal((await send('PATCH', `${SALES}/${created.body.data.id}`, { fidelityCardCode: 'ADV-2' })).status, 200);
    assert.deepEqual(alerts().map((entry) => [entry.metadata!['cardId'], entry.metadata!['amount']]), [[hex(second), 100]]);
    assert.deepEqual(await balanceOf(second), [100, 0]);
    // A sale without a card, given one, is a card changed as well.
    const plain = await post(saleBody([saleLine(await product())], { timestampId: 'N-9' }));
    assert.equal((await send('PATCH', `${SALES}/${plain.body.data.id}`, { fidelityCardCode: 'ADV-2' })).status, 200);
    assert.equal(alerts().length, 1, 'no refill: no credit, no alert (the amount is zero)');
  });
});
