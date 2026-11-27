import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { fixtureId, legacyPermissions, LEGACY_MODULE_NAMES } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { SALES_WAREHOUSE_RULES, saleBody, saleLine } from '../helpers/store-sales.ts';

/** The writes of the sales from the backoffice (step VS4b): every behaviour goes through `/v1/groups/{groupId}/sales` as a user, over a real MongoDB. */
let ctx: TestDatabases;
let world: StoreWorld;
const hex = (id: ObjectId) => id.toHexString();
const g = (index = 0) => world.group(index);
const own = () => g().ownPlaceId;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const base = (index = 0) => `/groups/${hex(g(index).groupId)}/sales`;
const db = (index = 0) => ctx.databases.group(g(index).groupId, 'cluster0');
const salesOf = (index = 0) => db(index).collection('sales');
const LATER_TAG = `"${'a'.repeat(43)}"`;
let companyOfOwn: ObjectId;
let cashStorage: ObjectId;
let counter = 0;
let caOther: ObjectId;
let paOther: ObjectId;
let otherPlace: ObjectId;
let otherCompany: ObjectId;

/** A body of the creation of a sale at a point of sale (the one of the group by default). */
function body(lines: Document[], overrides: Document = {}, place: ObjectId = own(), company: ObjectId = companyOfOwn): Document {
  return { ...saleBody(lines, { timestampId: `T-${String((counter += 1))}`, ...overrides }), companyId: hex(company), placeId: hex(place) };
}
const create = (actor: ObjectId, payload: unknown, key: string = randomUUID(), path = base()) => call(actor, 'POST', path, payload, { 'idempotency-key': key });
const tagOf = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const match = (reply: Awaited<ReturnType<typeof call>>) => ({ 'if-match': tagOf(reply) });

/** A product of the catalog, kept in stock (10 pieces in the storage of the cash desks). */
async function product(stock = 10): Promise<ObjectId> {
  const _id = new ObjectId();
  await db().collection('products').insertOne({
    _id,
    type: 'product',
    code: `P-${String((counter += 1))}`,
    name: { it: 'Prodotto' },
    categories: ['cat-1'],
    availability: { pos: true, warehouse: true },
    measureLoad: 'pz',
    measureDownload: 'pz',
    measureConversionRatio: 1,
    bundleProducts: [],
    barcode: [],
    quantity: { [`__${hex(own())}`]: { [`__${hex(cashStorage)}`]: { value: stock, min: 1 } } },
  });
  return _id;
}
const stockOf = async (productId: ObjectId): Promise<number> => (((await db().collection('products').findOne({ _id: productId }))!['quantity'] as Document)[`__${hex(own())}`][`__${hex(cashStorage)}`] as Document)['value'] as number;
const savedSale = async (id: string): Promise<Document> => (await salesOf().findOne({ _id: new ObjectId(id) }))!;
const error = (reply: Awaited<ReturnType<typeof call>>) => [reply.status, reply.body?.error?.code, reply.body?.error?.details] as const;

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { env: { STORE_CREDIT_ALERT_PER_OPERATION: '50' } });
  cashStorage = new ObjectId();
  const common = ctx.databases.common();
  await common.collection('groups').updateOne({ _id: g().groupId }, { $set: { 'settings.warehouse': true, warehouseRules: SALES_WAREHOUSE_RULES } });
  await common.collection('places').updateOne({ _id: own() }, { $set: { storages: [{ id: cashStorage, name: 'Shop', cash: true }] } });
  companyOfOwn = (await common.collection('places').findOne({ _id: own() }))!['companyId'] as ObjectId;
  // A second company with a point of sale of its own, and a company administrator and a place administrator who reach only that one.
  otherCompany = fixtureId('company', 2);
  otherPlace = await world.seedPlace(0, 40, 2);
  const matrix = legacyPermissions({ status: false, modules: { documents: { r: true, w: true } } });
  caOther = (await addUser(ctx, world.office, { role: 'CA', groupId: g().groupId, companyId: otherCompany, permissions: matrix })).id;
  paOther = (await addUser(ctx, world.office, { role: 'PA', groupId: g().groupId, companyId: otherCompany, placeId: otherPlace, placesId: [otherPlace], permissions: matrix })).id;
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  await Promise.all([salesOf().deleteMany({}), db().collection('sales_tombstones').deleteMany({}), salesOf(1).deleteMany({}), db().collection('products').deleteMany({}), db().collection('warehouse').deleteMany({})]);
  await ctx.databases.common().collection('places').updateOne({ _id: otherPlace }, { $set: { trash: false } });
});

describe('the permissions of the writes of the sales', () => {
  it('follows sales:write (documents.w) for the five roles of the backoffice, independently of the read, and sales:delete only for PSA, D and SA', async () => {
    const actors: Array<[string, ObjectId]> = [['PSA', world.office.cluster.psa], ['D', world.office.cluster.dealerA], ['SA', g().sa], ['CA', g().ca], ['PA', g().pa]];
    for (const [role, actor] of actors) {
      const made = await create(actor, body([saleLine(null)], { nonFiscal: true, fiscalReceiptInfo: null }));
      assert.equal(made.status, 201, `${role}: ${JSON.stringify(made.body)}`);
      const wanted = ['PSA', 'D', 'SA'].includes(role) ? 204 : 403;
      assert.equal((await call(actor, 'DELETE', `${base()}/${made.body.data.id}?nonFiscal=include`, undefined, match(made))).status, wanted, role);
    }
    // The flags of the user's own matrix: documents.w alone writes (and, being a group administrator, deletes); documents.r alone does not write at all.
    const writer = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: false, w: true } } }) })).id;
    const reader = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: false } } }) })).id;
    const written = await create(writer, body([saleLine(null)], { nonFiscal: true, fiscalReceiptInfo: null }));
    assert.equal(written.status, 201);
    assert.equal((await call(writer, 'GET', `${base()}/${written.body.data.id}?nonFiscal=include`)).status, 403, 'writing is not reading');
    assert.equal((await create(reader, body([saleLine(null)]))).status, 403);
    const target = `${base()}/${written.body.data.id}`;
    for (const [method, path, payload] of [['PATCH', target, { lotteryCode: 'X' }], ['POST', `${target}/refunds`, {}], ['POST', `${target}/cancellation`, {}], ['DELETE', `${target}?nonFiscal=include`, undefined]] as const) {
      assert.equal((await call(reader, method, path, payload, { 'if-match': LATER_TAG })).status, 403, `${method} ${path}`);
    }
  });

  it('is closed to the anonymous, to a store key, to a public key and to another group', async () => {
    const key = await world.activate(own());
    const payload = body([saleLine(null)]);
    assert.equal((await world.office.call('POST', base(), undefined, payload, { 'idempotency-key': randomUUID() })).status, 401);
    assert.equal((await world.asStore(key.key, 'POST', base(), payload, { 'idempotency-key': randomUUID() })).status, 403);
    assert.equal((await world.office.call('POST', base(), `fc_pk_${'a'.repeat(43)}`, payload, { 'idempotency-key': randomUUID() })).status, 401);
    assert.equal((await create(g(1).sa, payload)).status, 404);
    assert.equal((await create(world.office.cluster.dealerB, payload)).status, 404);
    assert.equal((await create(g().sa, payload, randomUUID(), '/groups/x/sales')).status, 404);
    assert.equal(await salesOf().countDocuments(), 0);
  });
});

describe('the creation of a sale from the backoffice', () => {
  it('needs an Idempotency-Key, saves the sale as the user, answers 201 with its link and version, and replays the same key', async () => {
    const pizza = await product();
    const payload = body([saleLine(pizza)], { timestampId: 'BO-1' });
    const missing = await call(g().sa, 'POST', base(), payload);
    assert.deepEqual(error(missing), [422, 'VALIDATION_ERROR', [{ field: 'Idempotency-Key', issue: 'required' }]]);
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const made = await create(g().sa, payload, key);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.match(made.headers.get('location')!, new RegExp(`/groups/${hex(g().groupId)}/sales/${made.body.data.id}$`));
    assert.equal(tagOf(made), `"${made.body.data.version}"`);
    assert.deepEqual([made.body.data.timestampId, made.body.data.total, made.body.data.checks, made.body.data.invoice], ['BO-1', 24.4, { status: 'ok', anomalies: 0 }, null]);
    const sale = await savedSale(made.body.data.id);
    assert.deepEqual([sale['companyId'], sale['placeId'], sale['userId']], [companyOfOwn, own(), g().sa]);
    assert.deepEqual([sale['floodCloud'].createdBy, sale['floodCloud'].key], [{ kind: 'user', userId: g().sa }, `${hex(own())}|BO-1`]);
    assert.equal(await stockOf(pizza), 8, 'the warehouse moved');
    const [movement] = await db().collection('warehouse').find({ saleId: sale['_id'] }).toArray();
    assert.deepEqual([movement!['userId'], movement!['storeKeyId']], [g().sa, undefined]);
    const entry = world.office.activity.entries.slice(mark).find((candidate) => candidate.action === 'sale.created')!;
    assert.deepEqual([entry.actor.kind, entry.actor.id, entry.resource!.id, entry.metadata!['operatorId']], ['user', g().sa, made.body.data.id, undefined]);
    // The same key and the same body: the same answer, nothing written again.
    const replay = await create(g().sa, payload, key);
    assert.deepEqual([replay.status, replay.body, replay.headers.get('etag'), replay.headers.get('location')], [201, made.body, tagOf(made), made.headers.get('location')]);
    assert.deepEqual([await salesOf().countDocuments(), await stockOf(pizza)], [1, 8]);
    // Another key, the same natural key: the original sale, 200.
    const again = await create(g().sa, payload);
    assert.deepEqual([again.status, again.body.data.id], [200, made.body.data.id]);
    assert.equal(await stockOf(pizza), 8);
    // The same key with another body is a conflict.
    assert.deepEqual(error(await create(g().sa, { ...payload, note: 'other' }, key)).slice(0, 2), [409, 'CONFLICT']);
  });

  it('makes up a timestampId when there is none, and refuses an operator, unknown properties and unpaid sales on a receipt', async () => {
    const { timestampId: _dropped, ...withoutKey } = body([saleLine(null)]);
    const made = await create(g().sa, withoutKey);
    assert.equal(made.status, 201);
    assert.match(made.body.data.timestampId, /^bo-[0-9a-f]{24}$/);
    assert.match((await savedSale(made.body.data.id))['timestampId'], /^bo-/);
    const issue = (field: string, kind: string) => [422, 'VALIDATION_ERROR', [{ field, issue: kind }]];
    assert.deepEqual(error(await create(g().sa, { ...withoutKey, operatorId: hex(g().sa) })), issue('operatorId', 'unknown'));
    assert.deepEqual(error(await create(g().sa, { ...withoutKey, extra: 1 })), issue('extra', 'unknown'));
    assert.deepEqual(error(await create(g().sa, { ...withoutKey, unpaidSaleIds: [hex(new ObjectId())] })), issue('unpaidSaleIds', 'incorrect'));
    const { placeId: _place, ...noPlace } = withoutKey;
    assert.deepEqual(error(await create(g().sa, noPlace)), issue('placeId', 'required'));
    assert.deepEqual(error(await create(g().sa, { ...withoutKey, products: [] })), issue('products', 'minLength'));
  });

  it('verifies the company and the point of sale in the group and in the perimeter of the user, with one answer for every case', async () => {
    const incorrect = [422, 'VALIDATION_ERROR', [{ field: 'placeId', issue: 'incorrect' }]];
    const lines = [saleLine(null)];
    // A company administrator or a place administrator of another company or place.
    assert.deepEqual(error(await create(caOther, body(lines))), incorrect);
    assert.deepEqual(error(await create(paOther, body(lines))), incorrect);
    // A place of the group with the wrong company, a place that does not exist, a place of another group, a place in the trash.
    assert.deepEqual(error(await create(g().sa, body(lines, {}, own(), otherCompany))), incorrect);
    assert.deepEqual(error(await create(g().sa, body(lines, {}, new ObjectId()))), incorrect);
    assert.deepEqual(error(await create(g().sa, body(lines, {}, g(1).ownPlaceId))), incorrect);
    await ctx.databases.common().collection('places').updateOne({ _id: otherPlace }, { $set: { trash: true } });
    assert.deepEqual(error(await create(g().sa, body(lines, {}, otherPlace, otherCompany))), incorrect);
    await ctx.databases.common().collection('places').updateOne({ _id: otherPlace }, { $set: { trash: false } });
    assert.equal(await salesOf().countDocuments(), 0);
    // Inside their perimeter they write.
    assert.equal((await create(caOther, body(lines, {}, otherPlace, otherCompany))).status, 201);
    assert.equal((await create(paOther, body(lines, {}, otherPlace, otherCompany))).status, 201);
    assert.equal((await create(g().ca, body(lines))).status, 201);
    assert.equal((await create(g().sa, body(lines, {}, otherPlace, otherCompany))).status, 201);
    assert.deepEqual((await salesOf().find().sort({ _id: 1 }).toArray()).map((sale) => hex(sale['placeId'])), [hex(otherPlace), hex(otherPlace), hex(own()), hex(otherPlace)]);
  });
});

describe('the credit, the parent bill and the actor of the effects (security review)', () => {
  /** The prepaid card type that collects no points, and a card of 10 euros; the refill product of 100 euros. */
  async function loyalty(): Promise<{ card: ObjectId; refill: ObjectId }> {
    await ctx.databases.common().collection('groups').updateOne({ _id: g().groupId }, { $set: { 'fidelity.cardsTypes': [{ id: 'ct', status: true, prepaid: { status: true, type: 'multi' }, pointsCollect: { status: false, collectionIds: [] }, placesAvailability: [] }], fidelityCardRules: { EUR: { value: 5 } } } });
    const card = new ObjectId();
    await db().collection('fidelity_cards').deleteMany({});
    await db().collection('fidelity_cards_movements').deleteMany({});
    await db().collection('fidelity_cards').insertOne({ _id: card, code: 'ADV-1', cardTypeId: 'ct', status: true, balance: 10, pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    const refill = await product();
    await db().collection('products').updateOne({ _id: refill }, { $set: { code: '000-r-multi-50' } });
    return { card, refill };
  }
  const refillLine = (refill: ObjectId) => saleLine(refill, { qt: 2, price: { price: 40.98, taxed: 50, discount: 0, tax: 22 } });
  const refillBody = (refill: ObjectId, overrides: Document = {}) => body([refillLine(refill)], { fidelityCardCode: 'ADV-1', totals: { taxable: 81.97, tax: 18.03, total: 100 }, payments: { cash: 100 }, ...overrides });
  const balance = async (card: ObjectId): Promise<number> => Math.round(((await db().collection('fidelity_cards').findOne({ _id: card }))!['balance'] as number) * 100) / 100;
  /** A user with the write flag of the documents and, or not, the one of the loyalty. */
  const writer = async (fidelity: boolean): Promise<ObjectId> =>
    (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: true }, fidelity: { r: fidelity, w: fidelity } } }) })).id;

  it('asks a user who moves the credit of a card for fidelity.w too, and alerts the credit he added with his own name', async () => {
    const { card, refill } = await loyalty();
    const blind = await writer(false);
    const full = await writer(true);
    // A refill, and a credit used, with sales:write alone: 403, nothing written.
    assert.deepEqual(error(await create(blind, refillBody(refill))).slice(0, 2), [403, 'FORBIDDEN']);
    assert.deepEqual(error(await create(blind, body([saleLine(null)], { fidelityCardCode: 'ADV-1', payments: { cash: 14.4, fidelityCredit: 10 } }))).slice(0, 2), [403, 'FORBIDDEN']);
    assert.deepEqual([await salesOf().countDocuments(), await balance(card)], [0, 10]);
    // A card that only collects (no credit moved) is no business of the loyalty permission.
    assert.equal((await create(blind, body([saleLine(null)], { fidelityCardCode: 'ADV-1' }))).status, 201);
    // With fidelity.w: the credit moves, and the alert (above the threshold of one operation) has the user as the actor.
    const mark = world.office.activity.entries.length;
    const made = await create(full, refillBody(refill, { timestampId: 'ADM-R' }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(await balance(card), 110);
    const alert = world.office.activity.entries.slice(mark).find((entry) => entry.action === 'store.creditAlert')!;
    assert.deepEqual([alert.actor.kind, alert.actor.id, alert.metadata!['reason'], alert.metadata!['amount'], alert.resource!.type, 'operatorId' in alert.metadata!], ['user', full, 'operation', 100, 'fidelityCard', false]);
    // The amendment of the credit used (100 to 0), and a change of card, need it too.
    const used = await create(full, body([saleLine(null)], { timestampId: 'ADM-U', fidelityCardCode: 'ADV-1', totals: { taxable: 81.97, tax: 18.03, total: 100 }, payments: { cash: 0, fidelityCredit: 100 } }));
    assert.equal(used.status, 201, JSON.stringify(used.body));
    assert.equal(await balance(card), 10);
    const target = `${base()}/${used.body.data.id}`;
    assert.deepEqual(error(await call(blind, 'PATCH', target, { payments: { cash: 100, fidelityCredit: 0 } }, match(used))).slice(0, 2), [403, 'FORBIDDEN']);
    assert.deepEqual(error(await call(blind, 'PATCH', target, { fidelityCardCode: 'OTHER' }, match(used))).slice(0, 2), [403, 'FORBIDDEN']);
    assert.equal(await balance(card), 10, 'nothing moved');
    // The actor of the card movements is the user who amended, never the cashier of the sale.
    const amended = await call(full, 'PATCH', target, { payments: { cash: 100, fidelityCredit: 0 } }, match(used));
    assert.equal(amended.status, 200, JSON.stringify(amended.body));
    assert.equal(await balance(card), 110);
    const movements = await db().collection('fidelity_cards_movements').find({ cardId: card }).sort({ _id: -1 }).limit(1).toArray();
    assert.deepEqual([movements[0]!['userId'], (await savedSale(used.body.data.id))['userId']], [full, full]);
    assert.notEqual(full, g().sa);
  });

  it('keeps the effects of an amendment under the name of the user who made it, not the cashier of the sale', async () => {
    const { card } = await loyalty();
    const cashier = (await addUser(ctx, world.office, { permissions: legacyPermissions({ status: false, modules: { documents: { r: true, w: true }, fidelity: { r: true, w: true } } }) })).id;
    const other = await writer(true);
    const made = await create(cashier, body([saleLine(null)], { fidelityCardCode: 'ADV-1', totals: { taxable: 81.97, tax: 18.03, total: 100 }, payments: { cash: 90, fidelityCredit: 10 } }));
    assert.equal(made.status, 201);
    const patched = await call(other, 'PATCH', `${base()}/${made.body.data.id}`, { payments: { cash: 100, fidelityCredit: 0 } }, match(made));
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const [last] = await db().collection('fidelity_cards_movements').find({ cardId: card }).sort({ _id: -1 }).limit(1).toArray();
    assert.deepEqual([(await savedSale(made.body.data.id))['userId'], last!['userId']], [cashier, other], 'the sale stays the cashier\'s, the movement is the user\'s');
  });

  it('asks fidelity.w also for a cancellation or a refund that moves the credit of a card, and for none that does not', async () => {
    const { card, refill } = await loyalty();
    const blind = await writer(false);
    const full = await writer(true);
    const used = await create(full, body([saleLine(null)], { timestampId: 'CR-U', fidelityCardCode: 'ADV-1', totals: { taxable: 81.97, tax: 18.03, total: 100 }, payments: { cash: 90, fidelityCredit: 10 } }));
    const filled = await create(full, refillBody(refill, { timestampId: 'CR-R' }));
    assert.deepEqual([used.status, filled.status, await balance(card)], [201, 201, 100]);
    const date = '2026-11-28T09:00:00.000Z';
    const one = { timestampId: 'R-1', date, products: [{ index: 0, quantity: 1 }] };
    const usedUrl = `${base()}/${used.body.data.id}`;
    const filledUrl = `${base()}/${filled.body.data.id}`;
    // The credit used would come back, the refill would be reversed: 403 for a user without fidelity.w, and nothing is written.
    assert.deepEqual(error(await call(blind, 'POST', `${usedUrl}/cancellation`, { date }, match(used))).slice(0, 2), [403, 'FORBIDDEN']);
    assert.deepEqual(error(await call(blind, 'POST', `${filledUrl}/refunds`, one, match(filled))).slice(0, 2), [403, 'FORBIDDEN']);
    assert.deepEqual(error(await call(blind, 'POST', `${filledUrl}/cancellation`, { date }, match(filled))).slice(0, 2), [403, 'FORBIDDEN']);
    assert.deepEqual([await balance(card), (await savedSale(used.body.data.id))['fiscalState'], (await savedSale(filled.body.data.id))['refund'].length], [100, '', 0]);
    // A refund that returns what was not credit (the credit used is never given back by a refund) moves none: it needs nothing more.
    assert.equal((await call(blind, 'POST', `${usedUrl}/refunds`, one, match(used))).status, 201);
    assert.equal(await balance(card), 100);
    // With fidelity.w the cancellation gives the credit back and the refund takes the refill back.
    const refunded = await call(full, 'POST', `${filledUrl}/refunds`, one, match(filled));
    assert.deepEqual([refunded.status, await balance(card)], [201, 50]);
    const canceled = await call(full, 'POST', `${usedUrl}/cancellation`, { date }, { 'if-match': `"${(await call(full, 'GET', usedUrl)).body.data.version}"` });
    assert.deepEqual([canceled.status, await balance(card)], [201, 60]);
    // A sale that touches no credit, on a card that only collects: nobody needs more than sales:write.
    const plain = await create(blind, body([saleLine(null)], { timestampId: 'CR-P', fidelityCardCode: 'ADV-1' }));
    assert.equal(plain.status, 201);
    assert.equal((await call(blind, 'POST', `${base()}/${plain.body.data.id}/cancellation`, { date }, match(plain))).status, 201);
    assert.equal(await balance(card), 60);
  });

  it('refuses a refill the payment does not cover, and the parent bill of a split table, from the backoffice', async () => {
    const { refill } = await loyalty();
    const short = await create(g().sa, refillBody(refill, { payments: { cash: 40 } }));
    assert.deepEqual(error(short), [409, 'CONFLICT', [{ field: 'payments', issue: 'refillNotCovered' }]]);
    assert.equal(await salesOf().countDocuments(), 0);
    assert.equal((await create(g().sa, refillBody(refill))).status, 201);
    assert.deepEqual(error(await create(g().sa, body([saleLine(null)], { receiptType: 'partitioned' }))).slice(0, 2), [422, 'VALIDATION_ERROR']);
    assert.deepEqual(error(await create(g().sa, body([saleLine(null)], { receiptType: 'partitioned' })))[2], [{ field: 'receiptType', issue: 'enum' }]);
  });
});

describe('If-Match, refunds, cancellation and the conflicts of the state', () => {
  it('requires the version the user read: 422 without it, 412 with another one, and the version of the detail is the one of the writes', async () => {
    const made = await create(g().sa, body([saleLine(null)]));
    const id = made.body.data.id as string;
    const target = `${base()}/${id}`;
    const patch = { payments: { cash: 20, electronic: 4.4 } };
    assert.deepEqual(error(await call(g().sa, 'PATCH', target, patch)), [422, 'VALIDATION_ERROR', [{ field: 'If-Match', issue: 'required' }]]);
    assert.deepEqual(error(await call(g().sa, 'PATCH', target, patch, { 'if-match': 'W/"x"' })), [422, 'VALIDATION_ERROR', [{ field: 'If-Match', issue: 'format' }]]);
    assert.equal((await call(g().sa, 'POST', `${target}/refunds`, { timestampId: 'R', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] })).status, 422);
    assert.equal((await call(g().sa, 'POST', `${target}/cancellation`, { date: '2026-11-28T09:00:00.000Z' })).status, 422);
    assert.equal((await call(g().sa, 'DELETE', `${target}?nonFiscal=include`)).status, 422);
    assert.deepEqual(error(await call(g().sa, 'PATCH', target, patch, { 'if-match': LATER_TAG })).slice(0, 2), [412, 'PRECONDITION_FAILED']);
    // The detail (the read of V1) carries the version, which is the tag of the last write.
    const detail = await call(g().sa, 'GET', target);
    assert.equal(detail.body.data.version, made.body.data.version);
    const amended = await call(g().sa, 'PATCH', target, patch, { 'if-match': `"${detail.body.data.version}"` });
    assert.equal(amended.status, 200, JSON.stringify(amended.body));
    assert.deepEqual([amended.body.data.payments.cash, amended.body.data.payments.electronic], [20, 4.4]);
    assert.notEqual(tagOf(amended), tagOf(made));
    assert.equal((await call(g().sa, 'GET', target)).body.data.version, amended.body.data.version);
    // The stale version is refused now, and the same patch with the fresh one writes nothing.
    assert.equal((await call(g().sa, 'PATCH', target, patch, { 'if-match': tagOf(made) })).status, 412);
    const same = await call(g().sa, 'PATCH', target, patch, match(amended));
    assert.deepEqual([same.status, tagOf(same)], [200, tagOf(amended)]);
    assert.deepEqual(error(await call(g().sa, 'PATCH', target, {}, match(amended))), [422, 'VALIDATION_ERROR', [{ field: '(body)', issue: 'required' }]]);
    assert.deepEqual(error(await call(g().sa, 'PATCH', target, { operatorId: hex(g().sa) }, match(amended))), [422, 'VALIDATION_ERROR', [{ field: 'operatorId', issue: 'unknown' }]]);
  });

  it('registers refunds with the user as the operator, refuses one beyond what was sold or after the cancellation with 409, and cancels once', async () => {
    const pizza = await product();
    const made = await create(g().sa, body([saleLine(pizza)]));
    const target = `${base()}/${made.body.data.id}`;
    const refund = { timestampId: 'R-1', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] };
    const first = await call(g().pa, 'POST', `${target}/refunds`, refund, match(made));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.match(first.headers.get('location')!, /\/refunds\/R-1$/);
    assert.deepEqual([first.body.data.sale.fiscalState, first.body.data.refund.timestampId, await stockOf(pizza)], ['refunded', 'R-1', 9]);
    assert.deepEqual((await savedSale(made.body.data.id))['refund'][0]['userId'], g().pa, 'the operator is the user who made the refund');
    // The same refund again: 200, nothing written.
    const repeated = await call(g().pa, 'POST', `${target}/refunds`, refund, match(first));
    assert.deepEqual([repeated.status, await stockOf(pizza)], [200, 9]);
    // Beyond what was sold: a conflict, and the warehouse does not move.
    const beyond = await call(g().pa, 'POST', `${target}/refunds`, { ...refund, timestampId: 'R-2', products: [{ index: 0, quantity: 2 }] }, match(repeated));
    assert.deepEqual(error(beyond), [409, 'CONFLICT', [{ field: 'products', issue: 'refundExceeds' }]]);
    assert.deepEqual([await stockOf(pizza), (await savedSale(made.body.data.id))['refund'].length], [9, 1]);
    assert.deepEqual(error(await call(g().pa, 'POST', `${target}/refunds`, { ...refund, timestampId: 'R-3', products: [{ index: 4, quantity: 1 }] }, match(repeated))).slice(0, 2), [422, 'VALIDATION_ERROR']);
    // The cancellation puts everything back; a second one answers 200 and writes nothing.
    const canceled = await call(g().sa, 'POST', `${target}/cancellation`, { date: '2026-11-28T10:00:00.000Z' }, match(repeated));
    assert.equal(canceled.status, 201, JSON.stringify(canceled.body));
    assert.match(canceled.headers.get('location')!, /\/cancellation$/);
    assert.deepEqual([canceled.body.data.fiscalState, await stockOf(pizza)], ['canceled', 10]);
    const again = await call(g().sa, 'POST', `${target}/cancellation`, { date: '2026-11-28T10:00:00.000Z' }, match(canceled));
    assert.deepEqual([again.status, tagOf(again), await stockOf(pizza)], [200, tagOf(canceled), 10]);
    // A canceled sale is not refunded nor amended from the backoffice (the till would only record an anomaly).
    const conflict = [409, 'CONFLICT', [{ field: 'fiscalState', issue: 'canceled' }]];
    assert.deepEqual(error(await call(g().sa, 'POST', `${target}/refunds`, { ...refund, timestampId: 'R-4' }, match(canceled))), conflict);
    assert.deepEqual(error(await call(g().sa, 'PATCH', target, { lotteryCode: 'ABCD' }, match(canceled))), conflict);
    assert.equal(await stockOf(pizza), 10);
    const operations = (await savedSale(made.body.data.id))['floodCloud'].operations.map((operation: Document) => [operation.kind, operation.by.kind]);
    assert.deepEqual(operations, [['create', 'user'], ['refund', 'user'], ['cancel', 'user']]);
  });

  it('refuses to change the customer of a sale gathered in an invoice, and lets its payments change with an anomaly', async () => {
    const made = await create(g().sa, body([saleLine(null)]));
    const target = `${base()}/${made.body.data.id}`;
    const contactId = new ObjectId();
    await db().collection('contacts').insertOne({ _id: contactId, name: 'Mario', surname: 'Rossi', code: 'C-1', trash: false });
    await salesOf().updateOne({ _id: new ObjectId(made.body.data.id) }, { $set: { status: 'invoiced' } });
    const refused = await call(g().sa, 'PATCH', target, { customer: { contactId: hex(contactId) } }, match(made));
    assert.deepEqual(error(refused), [409, 'CONFLICT', [{ field: 'status', issue: 'invoiced' }]]);
    assert.deepEqual(error(await call(g().sa, 'PATCH', target, { fidelityCardCode: 'CARD-1' }, match(made))).slice(0, 2), [409, 'CONFLICT']);
    const paid = await call(g().sa, 'PATCH', target, { payments: { cash: 0, electronic: 24.4 } }, match(made));
    assert.equal(paid.status, 200);
    assert.deepEqual((await savedSale(made.body.data.id))['floodCloud'].anomalies.map((anomaly: Document) => anomaly.code), ['amendAfterInvoiced']);
    // Without the invoice the customer is set from the contact of the database.
    await salesOf().updateOne({ _id: new ObjectId(made.body.data.id) }, { $set: { status: '' } });
    const customer = await call(g().sa, 'PATCH', target, { customer: { contactId: hex(contactId) } }, match(paid));
    assert.equal(customer.status, 200);
    assert.deepEqual([customer.body.data.customer, (await savedSale(made.body.data.id))['customer'].name], [{ contactId: hex(contactId) }, 'Mario']);
  });
});

describe('the perimeter of the writes on an existing sale', () => {
  it('finds a sale only inside the group and the perimeter of the user, in writing as in reading', async () => {
    const own1 = await create(g().sa, body([saleLine(null)]));
    const own2 = await create(g().sa, body([saleLine(null)], {}, otherPlace, otherCompany));
    const foreign = new ObjectId();
    await salesOf(1).insertOne({ _id: foreign, timestampId: 'F', companyId: fixtureId('company', 3), placeId: g(1).ownPlaceId, receiptType: 'receipt', sType: false, products: [], refund: [], date: new Date() });
    const bodies = (target: string): Array<[string, string, unknown]> => [
      ['PATCH', target, { lotteryCode: 'Z' }],
      ['POST', `${target}/refunds`, { timestampId: 'R', date: '2026-11-28T09:00:00.000Z', products: [{ index: 0, quantity: 1 }] }],
      ['POST', `${target}/cancellation`, { date: '2026-11-28T09:00:00.000Z' }],
    ];
    const notFound = async (actor: ObjectId, id: string): Promise<void> => {
      for (const [method, path, payload] of bodies(`${base()}/${id}`)) {
        assert.equal((await call(actor, method, path, payload, { 'if-match': LATER_TAG })).status, 404, `${method} ${path}`);
      }
    };
    await notFound(caOther, own1.body.data.id);
    await notFound(paOther, own1.body.data.id);
    await notFound(g().ca, own2.body.data.id);
    await notFound(g().pa, own2.body.data.id);
    await notFound(g().sa, hex(foreign));
    await notFound(g().sa, hex(new ObjectId()));
    // Inside the perimeter the writes work, and the reads of the same sale agree.
    assert.equal((await call(caOther, 'PATCH', `${base()}/${own2.body.data.id}`, { lotteryCode: 'Z' }, match(own2))).status, 200);
    assert.equal((await call(g().pa, 'PATCH', `${base()}/${own1.body.data.id}`, { lotteryCode: 'Z' }, match(own1))).status, 200);
    assert.equal((await call(caOther, 'GET', `${base()}/${own1.body.data.id}`)).status, 404);
    // A sale whose company or point of sale is not an id is not reached by a write.
    const broken = new ObjectId();
    await salesOf().insertOne({ _id: broken, timestampId: 'B', companyId: null, placeId: 'x', receiptType: 'receipt', sType: false, products: [], refund: [], date: new Date() });
    await notFound(g().sa, hex(broken));
    // The parent bill of a split table is not reachable either.
    const parent = new ObjectId();
    await salesOf().insertOne({ _id: parent, timestampId: 'P', companyId: companyOfOwn, placeId: own(), receiptType: 'partitioned', sType: false, products: [], refund: [], date: new Date() });
    await notFound(g().sa, hex(parent));
  });

  it('reaches a sale that is not fiscal only with nonFiscal=include, and deletes only those', async () => {
    const pizza = await product();
    const quote = await create(g().sa, body([saleLine(pizza)], { nonFiscal: true, fiscalReceiptInfo: null }));
    assert.equal(quote.status, 201);
    const target = `${base()}/${quote.body.data.id}`;
    assert.equal(await stockOf(pizza), 8);
    assert.equal((await call(g().sa, 'PATCH', target, { lotteryCode: 'Z' }, match(quote))).status, 404);
    assert.equal((await call(g().sa, 'DELETE', target, undefined, match(quote))).status, 404, 'without the signal the quote does not exist');
    const amended = await call(g().sa, 'PATCH', `${target}?nonFiscal=include`, { lotteryCode: 'Z' }, match(quote));
    assert.equal(amended.status, 200);
    assert.equal((await call(g().sa, 'PATCH', `${target}?nonFiscal=bogus`, { lotteryCode: 'Z' }, match(amended))).status, 422);
    // The deletion needs sales:delete: a company or place administrator cannot, whatever the matrix says.
    for (const actor of [g().ca, g().pa, caOther]) {
      assert.equal((await call(actor, 'DELETE', `${target}?nonFiscal=include`, undefined, match(amended))).status, 403);
    }
    const mark = world.office.activity.entries.length;
    const removed = await call(g().sa, 'DELETE', `${target}?nonFiscal=include`, undefined, match(amended));
    assert.deepEqual([removed.status, removed.body, await salesOf().countDocuments(), await stockOf(pizza)], [204, undefined, 0, 10]);
    const entry = world.office.activity.entries.slice(mark).find((candidate) => candidate.action === 'sale.deleted')!;
    assert.deepEqual([entry.actor.kind, entry.actor.id, entry.resource!.id], ['user', g().sa, quote.body.data.id]);
    assert.equal((await call(g().sa, 'DELETE', `${target}?nonFiscal=include`, undefined, { 'if-match': LATER_TAG })).status, 404);
    // The key of the deleted quote is blocked for good: it answers 409, with no effect.
    const again = await create(g().sa, body([saleLine(pizza)], { timestampId: quote.body.data.timestampId, nonFiscal: true, fiscalReceiptInfo: null }));
    assert.deepEqual(error(again), [409, 'CONFLICT', [{ field: 'timestampId', issue: 'deleted' }]]);
    assert.deepEqual([await salesOf().countDocuments(), await stockOf(pizza)], [0, 10]);
  });

  it('never deletes a sale that is fiscal or gathered in an invoice', async () => {
    const fiscal = await create(g().sa, body([saleLine(null)]));
    const target = `${base()}/${fiscal.body.data.id}`;
    const conflict = [409, 'CONFLICT', [{ field: 'nonFiscal', issue: 'fiscal' }]];
    assert.deepEqual(error(await call(g().sa, 'DELETE', target, undefined, match(fiscal))), conflict, 'without the signal it is found, and fiscal');
    assert.deepEqual(error(await call(g().sa, 'DELETE', `${target}?nonFiscal=include`, undefined, match(fiscal))), conflict);
    const invoiced = await create(g().sa, body([saleLine(null)], { nonFiscal: true, fiscalReceiptInfo: null }));
    await salesOf().updateOne({ _id: new ObjectId(invoiced.body.data.id) }, { $set: { status: 'invoiced' } });
    assert.deepEqual(error(await call(g().sa, 'DELETE', `${base()}/${invoiced.body.data.id}?nonFiscal=include`, undefined, match(invoiced))), [409, 'CONFLICT', [{ field: 'status', issue: 'invoiced' }]]);
    assert.equal(await salesOf().countDocuments(), 2);
  });
});

describe('the reads of the backoffice after the writes', () => {
  it('lists what the backoffice wrote and keeps the version in the detail', async () => {
    const made = await create(g().sa, body([saleLine(null)]));
    const list = await call(g().sa, 'GET', `${base()}?from=2026-11-01&to=2026-12-01`);
    assert.deepEqual(list.body.data.map((row: Document) => row['id']), [made.body.data.id]);
    assert.equal((await call(g().sa, 'GET', `${base()}/${made.body.data.id}`)).body.data.version, made.body.data.version);
    assert.ok(LEGACY_MODULE_NAMES.includes('documents'));
  });
});
