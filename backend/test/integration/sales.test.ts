import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { fixtureId, legacyPermissions, LEGACY_MODULE_NAMES } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const g = (index = 0) => world.group(index);
const psa = () => world.office.cluster.psa;
const base = (index = 0) => `/groups/${hex(g(index).groupId)}/sales`;
const db = (index = 0) => ctx.databases.group(g(index).groupId, 'cluster0');
const sid = (n: number): ObjectId => ObjectId.createFromHexString(`0a${n.toString(16).padStart(22, '0')}`);
const ids = (reply: Awaited<ReturnType<typeof call>>): string[] => reply.body.data.map((row: { id: string }) => row.id);
const nums = (...numbers: number[]) => numbers.map((n) => hex(sid(n)));
const okay = (reply: Awaited<ReturnType<typeof call>>) => assert.equal(reply.status, 200, JSON.stringify(reply.body));
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });

const contactA = new ObjectId();
const contactB = new ObjectId();
const [c1, c2] = [fixtureId('company', 1), fixtureId('company', 2)];
const [p1, p2, p3] = [fixtureId('place', 1), fixtureId('place', 2), fixtureId('place', 3)];
const day = (text: string) => new Date(`2026-05-${text}Z`);
const SECRETS = ['SECRET-LOTTERY', 'secret@example.test', 'Via Segreta', 'TERMINAL-SECRET', 'SECRET-DELIVERY', 'SECRET-TICKET'];

/** A sale as the legacy point of sale writes it. */
function sale(n: number, overrides: Document = {}): Document {
  return {
    _id: sid(n),
    userId: g().sa,
    timestampId: n,
    companyId: c1,
    placeId: p1,
    customer: { _id: contactA, companyName: 'Acme Srl', name: 'Mario', surname: 'Rossi', email: ['secret@example.test'], address: 'Via Segreta 1' },
    lotteryId: 'SECRET-LOTTERY',
    delivery: { address: 'SECRET-DELIVERY' },
    posTerminalId: 'TERMINAL-SECRET',
    tickets: [{ name: 'SECRET-TICKET' }],
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
    device: { settings: { name: 'Cassa 1' }, companyData: { secret: 1 } },
    table: { originalTable: { name: 'T1' } },
    fiscalReceiptInfo: { date: day('01T10:01:00.000'), number: n, amount: 1, reportNumber: 100 + n },
    ...overrides,
  };
}

const salesOfGroup = (): Document[] => [
  sale(1, {
    date: day('10T10:00:00.000'),
    finalTotalCheckout: 10,
    finalTotalTaxable: 8.2,
    finalTotalTax: 1.8,
    cashAmount: 4,
    electronicAmount: 6,
    adjustmentType: 'discount',
    discountPercentage: 10,
    fidelityCard: { code: 'CARD-1' },
    savedCheckoutsNote: 'Senza glutine',
    products: [
      { _id: fixtureId('country', 1), code: 'PZ', name: { en: 'Pizza', it: 'Pizza it' }, qt: 2, price: { taxed: 4, discount: 0, tax: 22 }, selectedVariants: { plus: [{ name: { it: 'Extra' }, qt: 2, price: { taxed: 1 } }], minus: [{ name: { it: 'Cipolla' } }], info: [] } },
      { name: { it: 'Libero' }, qt: 1, price: { taxed: 2 }, freeProduct: true },
    ],
  }),
  sale(9, { date: day('10T10:00:00.000'), finalTotalCheckout: 7, customer: { _id: contactB, name: 'Bruno', surname: 'Verdi' } }),
  sale(2, { date: day('09T10:00:00.000'), finalTotalCheckout: 20, customer: { _id: hex(contactA), companyName: '', name: 'Anna', surname: 'Bianchi' }, companyId: hex(c1), placeId: hex(p1) }),
  sale(3, { date: day('08T10:00:00.000'), finalTotalCheckout: 30, receiptType: 'invoice', companyId: c2, placeId: p2, unpaid: 5, userId: new ObjectId() }),
  sale(4, { date: day('07T10:00:00.000'), finalTotalCheckout: 100, sType: true }),
  sale(5, { date: day('06T10:00:00.000'), finalTotalCheckout: 1000, receiptType: 'partitioned' }),
  sale(6, { date: day('05T10:00:00.000'), finalTotalCheckout: 50, fiscalState: 'canceled' }),
  sale(7, { date: day('04T10:00:00.000'), finalTotalCheckout: 40, fiscalState: 'refunded', refund: [{ returnedGoodsValue: { priceTaxed: 15 }, fiscalReceiptInfo: { date: day('05T08:00:00.000'), reportNumber: 3, number: 9, amount: 15 } }] }),
  sale(8, { date: day('03T10:00:00.000'), finalTotalCheckout: 20, receiptType: 'charge', status: 'invoiced' }),
  sale(10, { date: day('02T10:00:00.000'), finalTotalCheckout: 'abc', fiscalState: 'refunded', refund: [{ returnedGoodsValue: { priceTaxed: 'x' } }, { returnedGoodsValue: { priceTaxed: 2 }, fiscalReceiptInfo: { reportNumber: 4, number: 1 } }, 'junk', { returnedGoodsValue: { priceTaxed: NaN } }] }),
  sale(14, { date: day('01T10:00:00.000'), finalTotalCheckout: 3, placeId: p3 }),
  sale(13, { date: new Date('2025-01-01T10:00:00.000Z'), finalTotalCheckout: 5 }),
  sale(11, { date: undefined, finalTotalCheckout: 9999 }),
  sale(12, { date: '2026-05-05', finalTotalCheckout: 9999 }),
];

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx);
  await db().collection('sales').insertMany(salesOfGroup().map((document) => Object.fromEntries(Object.entries(document).filter(([, value]) => value !== undefined))));
  // The same customer in another group of the same dealer: never mixed in.
  await db(1).collection('sales').insertOne(sale(20, { finalTotalCheckout: 999, date: day('10T10:00:00.000'), companyId: fixtureId('company', 3), placeId: fixtureId('place', 3) }));
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

const as = async (role: 'CA' | 'PA', scope: Document, modules: Record<string, Document> = { documents: { r: true, w: false } }) =>
  (await addUser(ctx, world.office, { role, ...scope, permissions: legacyPermissions({ status: false, modules }) })).id;
const forA = `?contactId=${hex(contactA)}`;

describe('sales: access', () => {
  it('follows sales:read (documents.r), keeps the groups apart, and is closed to a store key and to a public API key', async () => {
    for (const actor of [psa(), world.office.cluster.dealerA, g().sa, g().ca, g().pa]) {
      okay(await call(actor, 'GET', `${base()}${forA}`));
    }
    assert.equal((await world.office.call('GET', `${base()}${forA}`, undefined)).status, 401);
    assert.equal((await world.office.call('GET', `${base()}${forA}`, `fc_pk_${'a'.repeat(43)}`)).status, 401);
    // Another dealer, another group, a malformed group.
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', `${base()}${forA}`)).status, 404);
    assert.equal(failure(await call(g(1).sa, 'GET', `${base()}${forA}`)).status, 404);
    assert.equal(failure(await call(g().sa, 'GET', `/groups/x/sales${forA}`)).status, 404);
    // The user's own matrix: documents.r gives the read, nothing else does.
    const reader = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: false } } }) })).id;
    const blind = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { documents: { r: false, w: true }, contacts: { r: true, w: true }, stats: { r: true, w: true } } }) })).id;
    for (const path of [`${base()}${forA}`, `${base()}/summary${forA}`, `${base()}/${hex(sid(1))}`]) {
      okay(await call(reader, 'GET', path));
      assert.equal(failure(await call(blind, 'GET', path)).status, 403, path);
    }
    const key = await world.activate(g().ownPlaceId);
    for (const path of [`${base()}${forA}`, `${base()}/summary${forA}`, `${base()}/${hex(sid(1))}`]) {
      assert.equal((await world.asStore(key.key, 'GET', path)).status, 403, path);
    }
    // The writes of the backoffice are in `sales-admin.test.ts`; these have no route.
    for (const method of ['POST', 'PUT']) {
      assert.ok([404, 405].includes((await call(g().sa, method, `${base()}/${hex(sid(1))}`, {})).status), method);
    }
  });
});

describe('GET /v1/groups/{groupId}/sales', () => {
  it('lists the purchases of a customer, the newest first, with the ids stored as ids and as text, the canceled ones and the refunded ones, and not the non fiscal, the split tables, the ones without a date and the other group', async () => {
    const reply = await call(g().sa, 'GET', `${base()}${forA}&limit=100`);
    okay(reply);
    assert.deepEqual(ids(reply), nums(1, 2, 3, 6, 7, 8, 10, 14, 13));
    assert.deepEqual(reply.body.page, { limit: 100, next: null });
    assert.deepEqual(reply.body.data[0], {
      id: hex(sid(1)),
      date: '2026-05-10T10:00:00.000Z',
      receiptType: 'receipt',
      nonFiscal: false,
      number: { report: 101, number: 1 },
      fiscalState: null,
      refunds: [],
      unpaid: 0,
      invoiced: false,
      total: 10,
      companyId: hex(c1),
      placeId: hex(p1),
      cashDesk: 'Cassa 1',
      operator: { id: hex(g().sa), name: 'Name003 Surname003' },
      table: 'T1',
      customer: { id: hex(contactA), displayName: 'Acme Srl' },
    });
    const text = JSON.stringify(reply.body);
    for (const secret of [...SECRETS, 'lotteryId', 'delivery', 'posTerminalId', 'products', 'email', 'address', 'companyData']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const byId = new Map<string, any>(reply.body.data.map((row: { id: string }) => [row.id, row]));
    // Stored as text: the ids and the customer are read as well, and the person is named.
    assert.deepEqual([byId.get(hex(sid(2)))!.companyId, byId.get(hex(sid(2)))!.placeId, byId.get(hex(sid(2)))!.customer], [hex(c1), hex(p1), { id: hex(contactA), displayName: 'Anna Bianchi' }]);
    // An operator who is not a user of the group is unknown; the states and the numbers of the refunds.
    assert.equal(byId.get(hex(sid(3)))!.operator, null);
    assert.deepEqual([byId.get(hex(sid(3)))!.receiptType, byId.get(hex(sid(3)))!.unpaid], ['invoice', 5]);
    assert.deepEqual([byId.get(hex(sid(6)))!.fiscalState, byId.get(hex(sid(7)))!.fiscalState, byId.get(hex(sid(7)))!.refunds, byId.get(hex(sid(8)))!.receiptType, byId.get(hex(sid(8)))!.invoiced], ['canceled', 'refunded', [{ report: 3, number: 9 }], 'charge', true]);
    // Broken amounts and refunds are read as zero and as what they have.
    assert.deepEqual([byId.get(hex(sid(10)))!.total, byId.get(hex(sid(10)))!.refunds], [0, [{ report: null, number: null }, { report: 4, number: 1 }, { report: null, number: null }]]);
  });

  it('shows the sales that are not fiscal only when asked, and never the split tables', async () => {
    assert.deepEqual(ids(await call(g().sa, 'GET', `${base()}${forA}&nonFiscal=include`)).slice(0, 4), nums(1, 2, 3, 4));
    assert.equal(ids(await call(g().sa, 'GET', `${base()}${forA}&nonFiscal=include&limit=100`)).includes(hex(sid(5))), false);
    assert.deepEqual(ids(await call(g().sa, 'GET', `${base()}${forA}&nonFiscal=exclude`)).includes(hex(sid(4))), false);
    const row = (await call(g().sa, 'GET', `${base()}${forA}&nonFiscal=include&limit=4`)).body.data[3];
    assert.deepEqual([row.id, row.nonFiscal], [hex(sid(4)), true]);
    assert.deepEqual(ids(await call(g().sa, 'GET', `${base()}?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z&receiptType=receipt&nonFiscal=include&limit=100`)).includes(hex(sid(5))), false);
  });

  it('filters by kind, state, payment, company, place and period, and combines the filters', async () => {
    const list = async (query: string) => ids(await call(g().sa, 'GET', `${base()}${forA}&${query}&limit=100`));
    assert.deepEqual(await list('receiptType=invoice'), nums(3));
    assert.deepEqual(await list('receiptType=charge'), nums(8));
    assert.deepEqual(await list('fiscalState=canceled'), nums(6));
    assert.deepEqual(await list('fiscalState=refunded'), nums(7, 10));
    assert.deepEqual(await list('fiscalState=none'), nums(1, 2, 3, 8, 14, 13));
    assert.deepEqual(await list('unpaid=true'), nums(3));
    assert.deepEqual(await list('invoiced=true'), nums(8));
    assert.deepEqual(await list(`companyId=${hex(c2)}`), nums(3));
    assert.deepEqual(await list(`placeId=${hex(p2)}`), nums(3));
    assert.deepEqual(await list(`placeId=${hex(p3)}`), nums(14));
    assert.deepEqual(await list(`companyId=${hex(c1)}&placeId=${hex(p2)}`), []);
    assert.deepEqual(await list('receiptType=receipt&fiscalState=refunded&companyId=' + hex(c1)), nums(7, 10));
    // The period: `from` is in, `to` is out.
    assert.deepEqual(await list('from=2026-05-04T00:00:00Z&to=2026-05-09T00:00:00Z'), nums(3, 6, 7));
    assert.deepEqual(await list('from=2026-05-10T10:00:00.000Z'), nums(1));
    assert.deepEqual(await list('to=2026-05-10T10:00:00.000Z').then((found) => found.slice(0, 2)), nums(2, 3));
    assert.deepEqual(await list('from=2026-05-10T10:00:00.001Z'), []);
    assert.deepEqual(await list('from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z'), nums(14));
  });

  it('lists a period without a customer, the customers of every sale, and pages with a cursor that loses and repeats nothing, also across the same instant', async () => {
    const period = '?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z';
    const whole = await call(g().sa, 'GET', `${base()}${period}&limit=100`);
    // The sales 1 and 9 have the same instant: the larger id comes first.
    assert.deepEqual(ids(whole), nums(9, 1, 2, 3, 6, 7, 8, 10, 14));
    for (const limit of [1, 2, 3, 4]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const reply: Awaited<ReturnType<typeof call>> = await call(g().sa, 'GET', `${base()}${period}&limit=${limit}${cursor === null ? '' : `&cursor=${cursor}`}`);
        okay(reply);
        assert.ok(reply.body.data.length <= limit);
        seen.push(...ids(reply));
        cursor = reply.body.page.next;
        pages += 1;
        assert.ok(pages < 20);
      } while (cursor !== null);
      assert.deepEqual(seen, ids(whole), `limit ${String(limit)}`);
    }
    // The default page is 20.
    assert.equal((await call(g().sa, 'GET', `${base()}${period}`)).body.page.limit, 20);
    // Nothing in the period: an empty page, without a cursor.
    assert.deepEqual((await call(g().sa, 'GET', `${base()}?from=2024-01-01T00:00:00Z&to=2024-02-01T00:00:00Z`)).body, { data: [], page: { limit: 20, next: null } });
  });

  it('asks for a bound: a customer or a whole period of at most one year', async () => {
    const refuse = async (query: string) => failure(await call(g().sa, 'GET', `${base()}${query}`));
    assert.deepEqual(await refuse(''), issues(['from', 'required'], ['to', 'required']));
    assert.deepEqual(await refuse('?limit=5'), issues(['from', 'required'], ['to', 'required']));
    assert.deepEqual(await refuse('?from=2026-01-01'), issues(['to', 'required']));
    assert.deepEqual(await refuse(`?companyId=${hex(c1)}`), issues(['from', 'required'], ['to', 'required']));
    assert.deepEqual(await refuse('?from=2024-01-01&to=2026-01-01'), issues(['to', 'maximum']));
    assert.deepEqual(await refuse('?from=2026-02-01&to=2026-01-01'), issues(['to', 'incorrect']));
    // A customer may have a longer period, or none.
    okay(await call(g().sa, 'GET', `${base()}${forA}&from=2010-01-01&to=2026-12-31`));
  });

  it('refuses unknown parameters, operators, repeated and bad values, and bad cursors, before reading anything', async () => {
    const refuse = async (query: string) => (await call(g().sa, 'GET', `${base()}${forA}${query}`)).status;
    for (const query of ['&other=1', '&contactId[$ne]=x', '&companyId[$gt]=', '&limit=0', '&limit=101', '&limit=x', '&receiptType=partitioned', '&receiptType=receipt&receiptType=invoice', '&fiscalState=none&fiscalState=canceled', '&unpaid=false', '&nonFiscal=all', '&from=today', '&cursor=%24%24', `&contactId=${hex(contactB)}&contactId=${hex(contactA)}`, '&cursor=' + 'a'.repeat(101)]) {
      assert.equal(await refuse(query), 422, query);
    }
    assert.deepEqual(failure(await call(g().sa, 'GET', `${base()}${forA}&cursor=e30`)), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'cursor', issue: 'format' }] });
    assert.equal((await call(g().sa, 'GET', `${base()}?contactId=nope`)).status, 422);
  });

  it('answers 422 to an operator in a filter before any other rule', async () => {
    const reply = await call(g().sa, 'GET', `${base()}?contactId[$ne]=x&from=2026-01-01`);
    assert.equal(reply.status, 422);
  });
});

describe('sales: the name of the operator', () => {
  it('is the first name and surname, else the user name, else nothing; an encrypted name is never shown', async () => {
    const contactC = new ObjectId();
    const encrypted = `${'ab'.repeat(16)}$${'cd'.repeat(16)}`;
    const noName = await addUser(ctx, world.office, { name: '', surname: '' });
    const encryptedName = await addUser(ctx, world.office, { name: encrypted, surname: encrypted });
    const nothing = await addUser(ctx, world.office, { name: '', surname: '', userName: '' });
    const surnameOnly = await addUser(ctx, world.office, { name: '', surname: 'Solo' });
    const withoutUser = sale(45, { date: new Date('2026-06-16T10:00:00Z'), customer: { _id: contactC } });
    delete withoutUser['userId'];
    await db()
      .collection('sales')
      .insertMany([
        sale(41, { date: new Date('2026-06-20T10:00:00Z'), userId: noName.id, customer: { _id: contactC } }),
        sale(42, { date: new Date('2026-06-19T10:00:00Z'), userId: encryptedName.id, customer: { _id: contactC } }),
        sale(43, { date: new Date('2026-06-18T10:00:00Z'), userId: nothing.id, customer: { _id: contactC } }),
        sale(44, { date: new Date('2026-06-17T10:00:00Z'), userId: surnameOnly.id, customer: { _id: contactC } }),
        withoutUser,
      ]);
    const reply = await call(g().sa, 'GET', `${base()}?contactId=${hex(contactC)}`);
    okay(reply);
    const customer = { id: hex(contactC), displayName: null };
    assert.deepEqual(
      reply.body.data.map((row: { operator: { name: string } | null; customer: unknown }) => [row.operator?.name ?? null, row.customer]),
      [[noName.name, customer], [encryptedName.name, customer], [null, customer], ['Solo', customer], [null, customer]],
    );
  });
});

describe('sales: the perimeter of the role', () => {
  it('gives a company administrator the sales of his companies and a place administrator those of his places, in the list, the summary and the detail', async () => {
    const ca = g().ca;
    const pa = g().pa;
    assert.deepEqual(ids(await call(ca, 'GET', `${base()}${forA}&limit=100`)), nums(1, 2, 6, 7, 8, 10, 14, 13));
    assert.deepEqual(ids(await call(pa, 'GET', `${base()}${forA}&limit=100`)), nums(1, 2, 6, 7, 8, 10, 13));
    assert.deepEqual((await call(ca, 'GET', `${base()}/summary${forA}`)).body.data, { total: 81, count: 7, average: 11.57, refunded: 17 });
    assert.deepEqual((await call(pa, 'GET', `${base()}/summary${forA}`)).body.data, { total: 78, count: 6, average: 13, refunded: 17 });
    assert.deepEqual((await call(g().sa, 'GET', `${base()}/summary${forA}`)).body.data, { total: 111, count: 8, average: 13.88, refunded: 17 });
    // The company of another administrator, a place outside the perimeter: nothing, never an error that tells it exists.
    for (const [actor, query] of [[ca, `companyId=${hex(c2)}`], [ca, `placeId=${hex(p2)}`], [pa, `companyId=${hex(c2)}`], [pa, `placeId=${hex(p2)}`], [pa, `placeId=${hex(p3)}`]] as const) {
      assert.deepEqual((await call(actor, 'GET', `${base()}${forA}&${query}`)).body.data, [], query);
      assert.deepEqual((await call(actor, 'GET', `${base()}/summary${forA}&${query}`)).body.data, { total: 0, count: 0, average: 0, refunded: 0 }, query);
    }
    // The detail: inside the perimeter 200, outside 404 (a sale of another company, a sale of another place of the same company).
    okay(await call(ca, 'GET', `${base()}/${hex(sid(14))}`));
    assert.equal(failure(await call(pa, 'GET', `${base()}/${hex(sid(14))}`)).status, 404);
    assert.equal(failure(await call(ca, 'GET', `${base()}/${hex(sid(3))}`)).status, 404);
    assert.equal(failure(await call(pa, 'GET', `${base()}/${hex(sid(3))}`)).status, 404);
    okay(await call(pa, 'GET', `${base()}/${hex(sid(2))}`));
    // A period without a customer is limited the same way.
    const period = '?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z';
    assert.deepEqual(ids(await call(ca, 'GET', `${base()}${period}&limit=100`)), nums(9, 1, 2, 6, 7, 8, 10, 14));
    assert.deepEqual((await call(g().sa, 'GET', `${base()}/summary${period}`)).body.data, { total: 113, count: 8, average: 14.13, refunded: 17 });
  });

  it('works for administrators of the other company and place, who see their own sales only', async () => {
    const ca2 = await as('CA', { groupId: g().groupId, companyId: c2 });
    const pa2 = await as('PA', { groupId: g().groupId, companyId: c2, placeId: p2, placesId: [p2] });
    for (const actor of [ca2, pa2]) {
      assert.deepEqual(ids(await call(actor, 'GET', `${base()}${forA}&limit=100`)), nums(3));
      assert.equal((await call(actor, 'GET', `${base()}/summary${forA}`)).body.data.total, 30);
      okay(await call(actor, 'GET', `${base()}/${hex(sid(3))}`));
      assert.equal(failure(await call(actor, 'GET', `${base()}/${hex(sid(1))}`)).status, 404);
    }
  });
});

describe('GET /v1/groups/{groupId}/sales/summary', () => {
  it('adds up the sales net of the refunds, without the canceled ones and the split tables, and rounds to two decimals', async () => {
    const summary = async (query: string, index = 0) => {
      const reply = await call(g(index).sa, 'GET', `${base(index)}/summary${query}`);
      okay(reply);
      return reply.body.data;
    };
    // The refunded sale 7 takes away the 15 returned, not its 40; the sale 10 has a total that is not a number (0) and a refund of 2 among values that are not numbers; the canceled sale 6 and the split table 5 do not count.
    assert.deepEqual(await summary(forA), { total: 111, count: 8, average: 13.88, refunded: 17 });
    assert.deepEqual(await summary(`${forA}&nonFiscal=include`), { total: 211, count: 9, average: 23.44, refunded: 17 });
    assert.deepEqual(await summary(`${forA}&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`), { total: 106, count: 7, average: 15.14, refunded: 17 });
    assert.deepEqual(await summary(`${forA}&receiptType=invoice`), { total: 30, count: 1, average: 30, refunded: 0 });
    assert.deepEqual(await summary(`${forA}&fiscalState=refunded`), { total: 23, count: 2, average: 11.5, refunded: 17 });
    // The filter of the canceled ones counts nothing: they are never in the summary.
    assert.deepEqual(await summary(`${forA}&fiscalState=canceled`), { total: 0, count: 0, average: 0, refunded: 0 });
    assert.deepEqual(await summary(`${forA}&unpaid=true`), { total: 30, count: 1, average: 30, refunded: 0 });
    assert.deepEqual(await summary(`${forA}&invoiced=true&companyId=${hex(c1)}`), { total: 20, count: 1, average: 20, refunded: 0 });
    assert.deepEqual(await summary(`?contactId=${hex(contactB)}`), { total: 7, count: 1, average: 7, refunded: 0 });
    assert.deepEqual(await summary(`?contactId=${hex(new ObjectId())}`), { total: 0, count: 0, average: 0, refunded: 0 });
    assert.deepEqual(await summary('?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z'), { total: 113, count: 8, average: 14.13, refunded: 17 });
    // The other group is never mixed in.
    assert.deepEqual(await summary(forA, 1), { total: 999, count: 1, average: 999, refunded: 0 });
  });

  it('asks for the same bound and refuses the parameters of the list', async () => {
    assert.deepEqual(failure(await call(g().sa, 'GET', `${base()}/summary`)), issues(['from', 'required'], ['to', 'required']));
    assert.deepEqual(failure(await call(g().sa, 'GET', `${base()}/summary?from=2020-01-01&to=2026-01-01`)), issues(['to', 'maximum']));
    assert.deepEqual(failure(await call(g().sa, 'GET', `${base()}/summary${forA}&limit=5`)), issues(['limit', 'unknown']));
    assert.deepEqual(failure(await call(g().sa, 'GET', `${base()}/summary${forA}&cursor=x`)), issues(['cursor', 'unknown']));
  });
});

describe('GET /v1/groups/{groupId}/sales/{saleId}', () => {
  it('shows the sale with its lines, totals, payments and refunds, with a weak ETag, and none of the data of the customer beyond his name', async () => {
    const reply = await call(g().sa, 'GET', `${base()}/${hex(sid(1))}`);
    okay(reply);
    // The version is the strong tag of `If-Match` of the writes (step VS4b).
    const { version, ...detail } = reply.body.data;
    assert.match(version, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(detail, {
      id: hex(sid(1)),
      date: '2026-05-10T10:00:00.000Z',
      receiptType: 'receipt',
      nonFiscal: false,
      number: { report: 101, number: 1 },
      fiscalState: null,
      refunds: [],
      unpaid: 0,
      invoiced: false,
      total: 10,
      companyId: hex(c1),
      placeId: hex(p1),
      cashDesk: 'Cassa 1',
      operator: { id: hex(g().sa), name: 'Name003 Surname003' },
      table: 'T1',
      customer: { id: hex(contactA), displayName: 'Acme Srl' },
      products: [
        { productId: hex(fixtureId('country', 1)), code: 'PZ', name: 'Pizza it', quantity: 2, unitPrice: 4, discount: 0, variants: '+ Extra x2, - Cipolla', index: 0, returned: 0 },
        { productId: null, code: null, name: 'Libero', quantity: 1, unitPrice: 2, discount: 0, variants: null, index: 1, returned: 0 },
      ],
      productsCount: 2,
      totals: { total: 10, taxable: 8.2, tax: 1.8, discount: { adjustment: 'discount', percentage: 10, value: 0 } },
      payments: { cash: 4, electronic: 6, cheque: 0, tickets: 0, fidelityCredit: 0, unpaid: 0 },
      fiscalReceiptInfo: { date: '2026-05-01T10:01:00.000Z', report: 101, number: 1, amount: 1 },
      fidelityCardCode: 'CARD-1',
      fidelityCardUsed: true,
      note: 'Senza glutine',
      // A sale of the legacy has no check, no anomaly, no invoice and no operation of this backend.
      canceled: false,
      returnedValue: 0,
      serverCheck: null,
      anomalies: [],
      invoice: null,
      operations: [],
    });
    const text = JSON.stringify(reply.body);
    for (const secret of [...SECRETS, 'lotteryId', 'delivery', 'posTerminalId', 'companyData', 'email', 'address']) {
      assert.ok(!text.includes(secret), secret);
    }
    const etag = reply.headers.get('etag')!;
    assert.match(etag, /^W\//);
    assert.equal((await world.office.call('GET', `${base()}/${hex(sid(1))}`, await world.as.tokenOf(g().sa), undefined, { 'if-none-match': etag })).status, 304);
  });

  it('reads a sale that is not fiscal only with nonFiscal=include (the UM mode), and shows the refunds with their amounts', async () => {
    assert.equal(failure(await call(g().sa, 'GET', `${base()}/${hex(sid(4))}`)).status, 404);
    assert.equal(failure(await call(g().sa, 'GET', `${base()}/${hex(sid(4))}?nonFiscal=exclude`)).status, 404);
    const quote = await call(g().sa, 'GET', `${base()}/${hex(sid(4))}?nonFiscal=include`);
    okay(quote);
    assert.deepEqual([quote.body.data.nonFiscal, quote.body.data.total], [true, 100]);
    // A fiscal sale is read either way; the parameter is checked.
    okay(await call(g().sa, 'GET', `${base()}/${hex(sid(1))}?nonFiscal=include`));
    for (const query of ['?nonFiscal=all', '?other=1', '?nonFiscal=include&nonFiscal=exclude']) {
      assert.equal((await call(g().sa, 'GET', `${base()}/${hex(sid(1))}${query}`)).status, 422, query);
    }
    const refunded = (await call(g().sa, 'GET', `${base()}/${hex(sid(7))}`)).body.data;
    assert.deepEqual([refunded.fiscalState, refunded.refunds], ['refunded', [{ report: 3, number: 9, date: '2026-05-05T08:00:00.000Z', amount: 15, canceled: false }]]);
    // The broken sale reads as what it has.
    const broken = (await call(g().sa, 'GET', `${base()}/${hex(sid(10))}`)).body.data;
    assert.deepEqual([broken.total, broken.refunds.map((refund: { amount: number }) => refund.amount), broken.products, broken.note], [0, [0, 2, 0], [], null]);
  });

  it('shows the check, the anomalies, the invoice with its state of sending read from the document, and what was already returned', async () => {
    const [saleId, missingId, legacyId, canceledId] = [sid(30), sid(31), sid(32), sid(33)];
    const [docQueued, docMissing, docLegacy] = [new ObjectId(), new ObjectId(), new ObjectId()];
    const date = new Date('2025-06-10T10:00:00.000Z');
    const line = (qt: number) => ({ name: { it: 'Pizza' }, qt, price: { taxed: 5, cost: 99 } });
    const hostile = { at: date, operation: 'create', source: 'loyalty', code: 'negativePoints', collectionId: hex(fixtureId('country', 2)), cardCode: 'CARD-SECRET', ids: [hex(saleId), 7], fields: ['recipient.vat'] };
    const cloud = (extra: Document) => ({ v: 1, key: 'k', createdBy: { kind: 'store', storeKeyId: new ObjectId() }, bodyHash: 'HASH-SECRET', loyalty: { applied: null, full: null, cardCode: 'CARD-SECRET' }, legacy: null, cancellation: null, ...extra });
    const sales = [
      sale(30, {
        _id: saleId, customer: null, date, receiptType: 'invoice', fidelityCard: { code: 'CARD-SECRET' }, updateDate: date,
        products: [line(3), line(1)],
        refund: [
          { returnedGoods: [{ index: 0, returnedQt: 1 }, { index: 5, returnedQt: 9 }, { index: 'x', returnedQt: 1 }], returnedGoodsValue: { priceTaxed: 5 } },
          { canceled: true, returnedGoods: [{ index: 0, returnedQt: 2 }], returnedGoodsValue: { priceTaxed: 10 } },
          { returnedGoods: [{ index: 0, returnedQt: 1 }], returnedGoodsValue: { priceTaxed: 5.1 } },
        ],
        floodCloud: cloud({
          serverCheck: { checkedAt: date, status: 'differences', totals: [{ field: 'total', pos: 20, server: 19.5, cost: 7 }, 'junk'], lines: [{ index: 0, code: 'lineTotalMismatch', pos: 5, server: 4.9, cost: 3 }, { index: 1, code: 'taxMissing' }, { code: 'x' }], linesTruncated: true, secret: 'S' },
          anomalies: [hostile, 'junk'],
          operations: [{ kind: 'create', at: date, by: { kind: 'user', userId: g().sa } }, { kind: 'refund', at: date, by: { kind: 'store', storeKeyId: new ObjectId() }, ref: 'R' }, 5],
          invoice: { documentId: docQueued, number: 12, prefixSuffix: 'A/', year: 2025, queuedAt: date },
        }),
      }),
      sale(31, { _id: missingId, customer: null, date, receiptType: 'invoice', floodCloud: cloud({ serverCheck: { status: 'ok', totals: [], lines: [] }, invoice: { documentId: docMissing, number: 13, prefixSuffix: '', year: 2025 } }) }),
      sale(32, { _id: legacyId, customer: null, date, receiptType: 'invoice' }),
      sale(33, { _id: canceledId, customer: null, date, fiscalState: 'canceled' }),
    ];
    await db().collection('sales').insertMany(sales);
    await db().collection('documents').insertMany([
      { _id: docQueued, companyId: c1, date, number: 12, prefixSuffix: 'A/', sendStatus: 'notQueued', XML: 'XML-SECRET', saleId },
      { _id: docLegacy, companyId: c1, date, number: 4, prefixSuffix: 'F', sendStatus: 'sent', XML: 'XML-SECRET', saleId: legacyId },
    ]);
    try {
      const read = async (actor: ObjectId, id: ObjectId) => (await call(actor, 'GET', `${base()}/${hex(id)}`)).body.data;
      const withCard = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: false }, fidelity: { r: true, w: false } } }) })).id;
      const withoutCard = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: false } } }) })).id;
      for (const actor of [withoutCard, withCard]) {
        const detail = await read(actor, saleId);
        assert.deepEqual(detail.serverCheck, {
          checkedAt: '2025-06-10T10:00:00.000Z',
          status: 'differences',
          totals: [{ field: 'total', pos: 20, server: 19.5 }],
          lines: [{ index: 0, code: 'lineTotalMismatch', pos: 5, server: 4.9 }, { index: 1, code: 'taxMissing', pos: null, server: null }],
          linesTruncated: true,
        });
        assert.deepEqual(detail.anomalies, [{ at: '2025-06-10T10:00:00.000Z', operation: 'create', source: 'loyalty', code: 'negativePoints', productId: null, collectionId: hex(fixtureId('country', 2)), type: null, ids: [hex(saleId)], fields: ['recipient.vat'] }]);
        // The invoice: its number from the reference, its state of sending read from the document, which the consumer of the queue moves.
        assert.deepEqual(detail.invoice, { documentId: hex(docQueued), number: 12, prefixSuffix: 'A/', year: 2025, sendStatus: 'notQueued', notQueued: true, documentFound: true });
        assert.deepEqual(detail.operations, [{ kind: 'create', at: '2025-06-10T10:00:00.000Z' }, { kind: 'refund', at: '2025-06-10T10:00:00.000Z' }]);
        // What was returned: the refunds that were not canceled, by line; the value without the canceled refund.
        assert.deepEqual([detail.products.map((product: { index: number; returned: number }) => [product.index, product.returned]), detail.returnedValue, detail.canceled, detail.refunds.map((refund: { canceled: boolean }) => refund.canceled)], [[[0, 2], [1, 0]], 10.1, false, [false, true, false]]);
        const text = JSON.stringify(detail);
        assert.equal(text.includes('cost'), false);
        assert.equal(text.includes('HASH-SECRET'), false);
        assert.equal(text.includes('XML-SECRET'), false);
        assert.equal(text.includes('CARD-SECRET'), actor === withCard);
      }
      // The state of sending follows the document: the e-invoicing moves it and the next read shows it.
      await db().collection('documents').updateOne({ _id: docQueued }, { $set: { sendStatus: 'queued' } });
      assert.deepEqual([(await read(g().sa, saleId)).invoice.sendStatus, (await read(g().sa, saleId)).invoice.notQueued], ['queued', false]);
      // A reference whose document is gone: the number is the reference's, the state is unknown.
      assert.deepEqual((await read(g().sa, missingId)).invoice, { documentId: hex(docMissing), number: 13, prefixSuffix: null, year: 2025, sendStatus: null, notQueued: false, documentFound: false });
      assert.equal((await read(g().sa, missingId)).serverCheck.status, 'ok');
      // An invoice of the legacy is found by its company, date and sale.
      assert.deepEqual((await read(g().sa, legacyId)).invoice, { documentId: hex(docLegacy), number: 4, prefixSuffix: 'F', year: 2025, sendStatus: 'sent', notQueued: false, documentFound: true });
      const canceled = await read(g().sa, canceledId);
      assert.deepEqual([canceled.canceled, canceled.invoice, canceled.serverCheck, canceled.anomalies], [true, null, null, []]);
    } finally {
      await db().collection('sales').deleteMany({ _id: { $in: [saleId, missingId, legacyId, canceledId] } });
      await db().collection('documents').deleteMany({ _id: { $in: [docQueued, docLegacy] } });
    }
  });

  it('shows the code of the loyalty card only with fidelity:read, and whether a card was used to everybody', async () => {
    const without = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: false } } }) })).id;
    const withCard = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: false }, fidelity: { r: true, w: false } } }) })).id;
    const plain = (await call(without, 'GET', `${base()}/${hex(sid(1))}`)).body.data;
    assert.deepEqual([plain.fidelityCardCode, plain.fidelityCardUsed], [null, true]);
    assert.ok(!JSON.stringify(plain).includes('CARD-1'));
    const full = (await call(withCard, 'GET', `${base()}/${hex(sid(1))}`)).body.data;
    assert.deepEqual([full.fidelityCardCode, full.fidelityCardUsed], ['CARD-1', true]);
    assert.deepEqual([(await call(without, 'GET', `${base()}/${hex(sid(2))}`)).body.data.fidelityCardUsed], [false]);
  });

  it('takes a sale for non fiscal when its flag is anything but false, null or missing: hidden without include, shown with it, in the list, the summary and the detail', async () => {
    const contactD = new ObjectId();
    const odd = [['true', 51], [1, 52], ['S', 53]] as const;
    await db().collection('sales').insertMany([
      ...odd.map(([sType, n]) => sale(n, { sType, date: new Date(`2026-07-0${n - 50}T10:00:00Z`), finalTotalCheckout: 10, customer: { _id: contactD } })),
      sale(54, { sType: null, date: new Date('2026-07-09T10:00:00Z'), finalTotalCheckout: 5, customer: { _id: contactD } }),
    ]);
    const query = `?contactId=${hex(contactD)}`;
    assert.deepEqual(ids(await call(g().sa, 'GET', `${base()}${query}`)), nums(54));
    assert.deepEqual((await call(g().sa, 'GET', `${base()}/summary${query}`)).body.data, { total: 5, count: 1, average: 5, refunded: 0 });
    const shown = await call(g().sa, 'GET', `${base()}${query}&nonFiscal=include`);
    assert.deepEqual(ids(shown), nums(54, 53, 52, 51));
    assert.deepEqual(shown.body.data.map((row: { nonFiscal: boolean }) => row.nonFiscal), [false, true, true, true]);
    assert.deepEqual((await call(g().sa, 'GET', `${base()}/summary${query}&nonFiscal=include`)).body.data, { total: 35, count: 4, average: 8.75, refunded: 0 });
    for (const [, n] of odd) {
      assert.equal(failure(await call(g().sa, 'GET', `${base()}/${hex(sid(n))}`)).status, 404);
      assert.equal((await call(g().sa, 'GET', `${base()}/${hex(sid(n))}?nonFiscal=include`)).body.data.nonFiscal, true);
    }
    okay(await call(g().sa, 'GET', `${base()}/${hex(sid(54))}`));
  });

  it('is not found when it does not exist, is in another group, is a split table, or the id is not an id', async () => {
    for (const path of [`${base()}/${hex(new ObjectId())}`, `${base()}/${hex(sid(20))}`, `${base()}/${hex(sid(5))}`, `${base(1)}/${hex(sid(1))}`]) {
      assert.equal(failure(await call(g().sa, 'GET', path)).status, 404, path);
    }
    assert.equal(failure(await call(g(1).sa, 'GET', `${base()}/${hex(sid(20))}`)).status, 404);
    okay(await call(g(1).sa, 'GET', `${base(1)}/${hex(sid(20))}`));
    for (const id of ['nope', '123', hex(sid(1)).toUpperCase().slice(0, 23)]) {
      assert.equal(failure(await call(g().sa, 'GET', `${base()}/${id}`)).status, 422, id);
    }
  });

  it('shows the names of the products in the language of the user, the first one of a name that has not it', async () => {
    const english = (await addUser(ctx, world.office, { settings: { language: 'en', hiddenInStats: false }, permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: false } } }) })).id;
    const lines = (await call(english, 'GET', `${base()}/${hex(sid(1))}`)).body.data.products;
    assert.deepEqual(lines.map((line: { name: string }) => line.name), ['Pizza', 'Libero']);
  });
});

describe('sales: the index of the purchases of a customer', () => {
  const named = async (index = 0) => (await db(index).collection('sales').indexes()).find((entry) => entry.name === 'customer._id_1_date_-1');
  const waitFor = async (index = 0) => {
    for (let attempt = 0; attempt < 100 && (await named(index)) === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return named(index);
  };

  it('is created by the first read for a customer of a group, without that read waiting for it, and not by a read without a customer', async () => {
    await db(2).collection('sales').insertOne(sale(30, { date: day('10T10:00:00.000') }));
    assert.equal(await named(2), undefined);
    okay(await call(g(2).sa, 'GET', `${base(2)}?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z`));
    okay(await call(g(2).sa, 'GET', `${base(2)}/summary?from=2026-05-01T00:00:00Z&to=2026-05-31T00:00:00Z`));
    assert.equal(await named(2), undefined);
    const reply = await call(g(2).sa, 'GET', `${base(2)}/summary?contactId=${hex(contactA)}`);
    okay(reply);
    assert.equal(reply.body.data.count, 1);
    const index = await waitFor(2);
    assert.deepEqual([index?.key, index?.unique], [{ 'customer._id': 1, date: -1 }, undefined]);
  });
});
