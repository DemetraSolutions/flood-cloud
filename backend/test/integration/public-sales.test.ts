import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld, MadeKey } from '../helpers/api-keys.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

/** The sales of the public API (step VS4b): `GET /public/v1/sales` and `/sales/{saleId}`, read only, with `sales:read`, over a real MongoDB. */
let ctx: TestDatabases;
let world: KeysWorld;
let all: MadeKey;
let placeKey: MadeKey;
let companyKey: MadeKey;
let otherKey: MadeKey;
let blindKey: MadeKey;
const hex = (id: ObjectId) => id.toHexString();
const own = () => world.group(0).ownPlaceId;
const db = (index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0');
const get = (path: string, key: MadeKey | null = all) => world.asKey(key?.secret, path);
const ids = (reply: { body: { data: Array<{ id: string }> } }) => reply.body.data.map((item) => item.id);
const sid = (n: number): ObjectId => ObjectId.createFromHexString(`0b${n.toString(16).padStart(22, '0')}`);
const day = (text: string) => new Date(`2026-05-${text}Z`);
const PERIOD = 'from=2026-05-01&to=2026-06-01';
let companyOfOwn: ObjectId;
let otherCompany: ObjectId;
let otherPlace: ObjectId;
const SECRETS = ['SECRET-LOTTERY', 'secret@example.test', 'Via Segreta', 'TERMINAL-SECRET', 'SECRET-DELIVERY', 'SECRET-TICKET', 'SECRET-NOTE', 'CARD-SECRET', 'Mario', 'Rossi', 'SECRET-SERIAL'];

/** A sale as the legacy point of sale writes it, with every datum the public API must never show. */
function sale(n: number, overrides: Document = {}): Document {
  return {
    _id: sid(n),
    userId: new ObjectId(),
    timestampId: n,
    companyId: companyOfOwn,
    placeId: own(),
    customer: { _id: sid(900), companyName: 'Acme Srl', name: 'Mario', surname: 'Rossi', email: ['secret@example.test'], address: 'Via Segreta 1' },
    lotteryId: 'SECRET-LOTTERY',
    delivery: { address: 'SECRET-DELIVERY' },
    posTerminalId: 'TERMINAL-SECRET',
    tickets: [{ name: 'SECRET-TICKET' }],
    savedCheckoutsNote: 'SECRET-NOTE',
    fidelityCard: { code: 'CARD-SECRET' },
    floodCloud: { serverCheck: { status: 'differences' }, anomalies: [{ code: 'SECRET-ANOMALY' }] },
    products: [],
    refund: [],
    receiptType: 'receipt',
    sType: false,
    fiscalState: '',
    cashAmount: 0,
    electronicAmount: 0,
    ticketsAmount: 0,
    chequeAmount: 0,
    paymentDiscountAmount: 0,
    unpaid: 0,
    date: day('01T10:00:00.000'),
    finalTotalCheckout: 1,
    finalTotalTaxable: 1,
    finalTotalTax: 0,
    device: { settings: { name: 'Cassa 1', serialNumber: 'SECRET-SERIAL' } },
    table: { originalTable: { name: 'T1' } },
    fiscalReceiptInfo: { date: day('01T10:01:00.000'), number: n, amount: 1, reportNumber: 100 + n },
    ...overrides,
  };
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx);
  const common = ctx.databases.common();
  companyOfOwn = (await common.collection('places').findOne({ _id: own() }))!['companyId'] as ObjectId;
  otherPlace = await world.seedPlace(0, 40, 2);
  otherCompany = (await common.collection('places').findOne({ _id: otherPlace }))!['companyId'] as ObjectId;
  all = await world.makeKey(0, { name: 'All', permissions: ['sales:read'] });
  placeKey = await world.makeKey(0, { name: 'Place', permissions: ['sales:read'], restrictions: { placeIds: [hex(own())] } });
  companyKey = await world.makeKey(0, { name: 'Company', permissions: ['sales:read'], restrictions: { companyIds: [hex(otherCompany)] } });
  otherKey = await world.makeKey(1, { name: 'Other group', permissions: ['sales:read'] });
  blindKey = await world.makeKey(0, { name: 'Blind', permissions: ['catalog:read', 'contacts:read'] });
  const line = { _id: sid(800), code: 'PZ', name: { en: 'Pizza', it: 'Pizza it' }, qt: 2.5, price: { price: 10, taxed: 12.2, discount: 5, tax: 22, taxData: { id: 't', value: 22 } }, simpleCost: 3, lastAveragePrice: { total: { averagePrice: 4 } }, sentBy: 'SECRET-SENTBY' };
  await db().collection('sales').insertMany([
    sale(1, {
      date: day('10T10:00:00.000'),
      finalTotalCheckout: 24.4,
      finalTotalTaxable: 20,
      finalTotalTax: 4.4,
      cashAmount: 14.4,
      electronicAmount: 10,
      chequeAmount: 0.1,
      ticketsAmount: 0.2,
      paymentDiscountAmount: 0.3,
      unpaid: 0.07,
      adjustmentType: 'discount',
      discountPercentage: 10,
      discountValue: 2.7,
      products: [line, { name: { it: 'Libero' }, qt: 1, price: { taxed: 2 }, freeProduct: true }, 'junk'],
    }),
    sale(2, { date: day('09T10:00:00.000'), receiptType: 'invoice', status: 'invoiced', finalTotalCheckout: 30, companyId: otherCompany, placeId: otherPlace, customer: null }),
    sale(3, { date: day('08T10:00:00.000'), sType: true, finalTotalCheckout: 100 }),
    sale(4, { date: day('07T10:00:00.000'), receiptType: 'partitioned', finalTotalCheckout: 60, products: [{ ...line, qt: 3 }] }),
    sale(5, { date: day('06T10:00:00.000'), fiscalState: 'canceled', finalTotalCheckout: 5 }),
    sale(6, { date: day('05T10:00:00.000'), fiscalState: 'refunded', finalTotalCheckout: 40, refund: [{ date: day('06T08:00:00.000'), returnedGoodsValue: { priceTaxed: 15.55 }, fiscalReceiptInfo: { reportNumber: 3, number: 9 } }, { returnedGoodsValue: { priceTaxed: 'x' }, fiscalReceiptInfo: { date: day('07T08:00:00.000') } }, 'junk'] }),
    sale(7, { date: day('04T10:00:00.000'), receiptType: 'weird', finalTotalCheckout: 'abc', cashAmount: NaN, fiscalReceiptInfo: null, customer: null, device: null }),
    sale(8, { date: day('03T10:00:00.000'), receiptType: 'charge', sType: null, finalTotalCheckout: 1.005, cashAmount: 0.1 + 0.2, electronicAmount: 4.35, chequeAmount: 1.15 }),
    sale(9, { date: new Date('2025-01-01T10:00:00.000Z') }),
    sale(10, { date: day('02T10:00:00.000'), products: Array.from({ length: 501 }, (_, index) => ({ qt: 1, name: { it: `L${String(index)}` }, price: { taxed: 1 } })) }),
  ]);
  await db(1).collection('sales').insertOne(sale(20, { companyId: new ObjectId(), placeId: world.group(1).ownPlaceId, date: day('10T10:00:00.000'), finalTotalCheckout: 999 }));
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('public sales: access', () => {
  it('needs the permission sales:read, a valid key and the group of the key, and has no write', async () => {
    assert.equal((await get(`/sales?${PERIOD}`, blindKey)).status, 403);
    assert.equal((await get(`/sales/${hex(sid(1))}`, blindKey)).status, 403);
    assert.equal((await get(`/sales?${PERIOD}`, null)).status, 401);
    assert.equal((await world.asKey('fc_pk_nope', `/sales?${PERIOD}`)).status, 401);
    assert.equal((await get(`/sales?${PERIOD}`)).status, 200);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const reply = await world.asKey(all.secret, `/sales/${hex(sid(1))}`, {}, method, {});
      assert.ok([404, 405].includes(reply.status), `${method}: ${String(reply.status)}`);
    }
    assert.ok([404, 405].includes((await world.asKey(all.secret, '/sales', {}, 'POST', {})).status));
    // The backoffice token of a user is not a key of the public API.
    assert.equal((await world.asKey(await world.as.tokenOf(world.group(0).sa), `/sales?${PERIOD}`)).status, 401);
  });
});

describe('public sales: the list', () => {
  it('shows the fiscal sales in cents with the parent bills of split tables, never a sale that is not fiscal, and keeps the groups apart', async () => {
    const listed = await get(`/sales?${PERIOD}&limit=50`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(ids(listed), [1, 2, 4, 5, 6, 7, 8, 10].map((n) => hex(sid(n))), 'the newest first, with the partitioned one, without the quote (3) and the sale out of the period (9)');
    assert.deepEqual(listed.body.page, { limit: 50, next: null });
    const [first] = listed.body.data;
    assert.deepEqual(first, {
      id: hex(sid(1)),
      date: '2026-05-10T10:00:00.000Z',
      receiptType: 'receipt',
      number: { report: 101, number: 1 },
      fiscalState: null,
      refunds: [],
      invoiced: false,
      companyId: hex(companyOfOwn),
      placeId: hex(own()),
      customerId: hex(sid(900)),
      products: [
        { productId: hex(sid(800)), code: 'PZ', name: 'Pizza', quantity: 2.5, unitPriceCents: 1220, discountPercent: 5, taxRatePercent: 22 },
        { productId: null, code: null, name: 'Libero', quantity: 1, unitPriceCents: 200, discountPercent: 0, taxRatePercent: null },
      ],
      productsCount: 2,
      totals: { totalCents: 2440, taxableCents: 2000, taxCents: 440, discount: { adjustment: 'discount', percentage: 10, valueCents: 270 } },
      payments: { cashCents: 1440, electronicCents: 1000, chequeCents: 10, ticketsCents: 20, fidelityCreditCents: 30 },
      unpaidCents: 7,
    });
    const text = JSON.stringify(listed.body);
    for (const secret of [...SECRETS, 'SECRET-ANOMALY', 'SECRET-SENTBY', 'simpleCost', 'averagePrice', 'floodCloud', 'serverCheck', 'userId', 'lotteryId', 'serialNumber']) {
      assert.equal(text.includes(secret), false, secret);
    }
    const byId = new Map<string, Document>(listed.body.data.map((row: Document) => [row['id'], row]));
    assert.deepEqual(Object.keys(first).sort(), Object.keys(byId.get(hex(sid(4)))!).sort(), 'every sale has the same fields');
    assert.deepEqual(byId.get(hex(sid(4)))!['receiptType'], 'partitioned');
    assert.equal(byId.get(hex(sid(4)))!['products'][0].quantity, 3, 'the parent bill carries the products of the table');
    assert.deepEqual(byId.get(hex(sid(2)))!['invoiced'], true);
    assert.deepEqual(byId.get(hex(sid(2)))!['customerId'], null);
    assert.equal(byId.get(hex(sid(5)))!['fiscalState'], 'canceled');
    assert.deepEqual(byId.get(hex(sid(6)))!['refunds'], [{ date: '2026-05-06T08:00:00.000Z', number: { report: 3, number: 9 }, amountCents: 1555 }, { date: '2026-05-07T08:00:00.000Z', number: null, amountCents: 0 }]);
    // The documents of the legacy that miss or break their values are read as they are: the kind of receipt unknown, the amounts zero, no fiscal number, no device.
    assert.deepEqual([byId.get(hex(sid(7)))!['receiptType'], byId.get(hex(sid(7)))!['number'], (byId.get(hex(sid(7)))!['totals'] as Document)['totalCents'], (byId.get(hex(sid(7)))!['payments'] as Document)['cashCents']], [null, null, 0, 0]);
    // A sale with more lines than the API shows reports how many it has.
    const long = byId.get(hex(sid(10)))!;
    assert.deepEqual([long['products'].length, long['productsCount']], [500, 501]);
    assert.equal(byId.get(hex(sid(8)))!['receiptType'], 'charge', 'a sale with sType null is fiscal');
    // The cents are rounded after cleaning the binary noise of the product: 1.005 is 101 (not 100), 0.1 + 0.2 is 30, 4.35 is 435, 1.15 is 115.
    assert.deepEqual([(byId.get(hex(sid(8)))!['totals'] as Document)['totalCents'], ...Object.values(byId.get(hex(sid(8)))!['payments'] as Document).slice(0, 3)], [101, 30, 435, 115]);
    // Not even the name of the cash desk: no device datum at all.
    assert.equal(text.includes('Cassa 1') || text.includes('cashDesk'), false);
    assert.equal(ids(await get(`/sales?${PERIOD}`, otherKey)).length, 1, 'another group reads its own sale only');
    assert.equal(ids(await get(`/sales?${PERIOD}`, otherKey))[0], hex(sid(20)));
  });

  it('leaves the parent bills out or asks for them alone, and filters by company, place, customer, kind and state', async () => {
    const without = await get(`/sales?${PERIOD}&partitioned=exclude`);
    assert.equal(ids(without).includes(hex(sid(4))), false);
    assert.equal(ids(without).length, 7);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&partitioned=include`)).includes(hex(sid(4))), true);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&receiptType=partitioned`)), [hex(sid(4))]);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&receiptType=partitioned&partitioned=include`)), [hex(sid(4))]);
    assert.deepEqual((await get(`/sales?${PERIOD}&receiptType=partitioned&partitioned=exclude`)).body.error.details, [{ field: 'partitioned', issue: 'incorrect' }]);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&receiptType=invoice`)), [hex(sid(2))]);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&receiptType=charge`)), [hex(sid(8))]);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&companyId=${hex(otherCompany)}`)), [hex(sid(2))]);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&placeId=${hex(otherPlace)}`)), [hex(sid(2))]);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&fiscalState=canceled`)), [hex(sid(5))]);
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&fiscalState=refunded`)), [hex(sid(6))]);
    // A customer: no period is needed, the sales of any date are his.
    const mine = await get(`/sales?contactId=${hex(sid(900))}`);
    assert.equal(ids(mine).includes(hex(sid(9))), true);
    assert.equal(ids(mine).includes(hex(sid(3))), false, 'never a sale that is not fiscal');
  });

  it('requires a bounded period without a customer, and refuses what the table does not know', async () => {
    const failed = async (path: string) => (await get(path)).body.error;
    assert.deepEqual((await failed('/sales')).details, [{ field: 'from', issue: 'required' }, { field: 'to', issue: 'required' }]);
    assert.deepEqual((await failed('/sales?from=2026-05-01')).details, [{ field: 'to', issue: 'required' }]);
    assert.deepEqual((await failed('/sales?from=2026-05-02&to=2026-05-01')).details, [{ field: 'to', issue: 'incorrect' }]);
    assert.deepEqual((await failed('/sales?from=2025-01-01&to=2026-05-01')).details, [{ field: 'to', issue: 'maximum' }]);
    for (const query of ['nonFiscal=include', 'unpaid=true', 'invoiced=true', 'updatedSince=2026-05-01', 'limit=51', 'limit=0', 'receiptType=refund', 'partitioned=only', 'cursor=not-a-cursor']) {
      assert.equal((await get(`/sales?${PERIOD}&${query}`)).status, 422, query);
    }
  });

  it('pages with a cursor, the newest first, whatever the filters', async () => {
    const first = await get(`/sales?${PERIOD}&limit=3`);
    assert.deepEqual([ids(first).length, first.body.page.limit, typeof first.body.page.next], [3, 3, 'string']);
    const second = await get(`/sales?${PERIOD}&limit=3&cursor=${first.body.page.next}`);
    const third = await get(`/sales?${PERIOD}&limit=3&cursor=${second.body.page.next}`);
    assert.deepEqual([...ids(first), ...ids(second), ...ids(third)], [1, 2, 4, 5, 6, 7, 8, 10].map((n) => hex(sid(n))));
    assert.equal(third.body.page.next, null);
    assert.equal((await get(`/sales?${PERIOD}`)).body.page.limit, 20);
  });
});

describe('public sales: the detail and the restrictions of the key', () => {
  it('shows one sale, and is 404 for a sale that is not fiscal, of another group or that does not exist', async () => {
    const one = await get(`/sales/${hex(sid(4))}`);
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.data.receiptType, one.body.data.totals.totalCents, one.body.data.products.length], ['partitioned', 6000, 1]);
    assert.equal(JSON.stringify(one.body).includes('SECRET'), false);
    assert.equal((await get(`/sales/${hex(sid(3))}`)).status, 404, 'a quote');
    assert.equal((await get(`/sales/${hex(sid(20))}`)).status, 404, 'a sale of another group');
    assert.equal((await get(`/sales/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get('/sales/not-an-id')).status, 422);
    assert.equal((await get(`/sales/${hex(sid(1))}?x=1`)).status, 422);
    assert.equal((await get(`/sales/${hex(sid(20))}`, otherKey)).status, 200);
  });

  it('applies the restrictions of the key to places and companies as the perimeter of the read', async () => {
    assert.deepEqual(ids(await get(`/sales?${PERIOD}`, placeKey)), [1, 4, 5, 6, 7, 8, 10].map((n) => hex(sid(n))));
    assert.deepEqual(ids(await get(`/sales?${PERIOD}`, companyKey)), [hex(sid(2))], 'the places of the company');
    // A filter cannot widen it.
    assert.deepEqual(ids(await get(`/sales?${PERIOD}&placeId=${hex(otherPlace)}`, placeKey)), []);
    assert.equal((await get(`/sales/${hex(sid(1))}`, placeKey)).status, 200);
    assert.equal((await get(`/sales/${hex(sid(2))}`, placeKey)).status, 404);
    assert.equal((await get(`/sales/${hex(sid(2))}`, companyKey)).status, 200);
    assert.equal((await get(`/sales/${hex(sid(1))}`, companyKey)).status, 404);
    // A key whose restrictions match no place reaches nothing.
    const trashedKey = await world.makeKey(0, { name: 'Trashed', permissions: ['sales:read'], restrictions: { placeIds: [hex(otherPlace)] } });
    assert.equal((await get(`/sales/${hex(sid(2))}`, trashedKey)).status, 200);
    await ctx.databases.common().collection('places').updateOne({ _id: otherPlace }, { $set: { trash: true } });
    assert.equal((await get(`/sales?${PERIOD}`, trashedKey)).status, 404);
    assert.equal((await get(`/sales/${hex(sid(2))}`, trashedKey)).status, 404);
    await ctx.databases.common().collection('places').updateOne({ _id: otherPlace }, { $set: { trash: false } });
  });
});
