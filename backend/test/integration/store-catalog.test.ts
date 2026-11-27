import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createBackofficeModules } from '../../src/composition.ts';
import { PRODUCT_BODY_LIMIT } from '../../src/modules/products/products.schemas.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger, testConfig } from '../helpers/app.ts';
import { legacyPermissions, legacyUser } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { catalogCollections, legacyAttributeGroup, legacyBrand, legacyCategory, legacyDepartment } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { legacyFullProduct, placeEntry } from '../helpers/products.ts';
import { throughRealLog } from '../helpers/real-log.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
let db: CatalogCollections;
let store: ActivatedKey;
const limiter = memoryRateLimiter();
const hex = (id: ObjectId) => id.toHexString();
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const gid = () => world.group(0).groupId;
const groups = () => ctx.databases.common().collection('groups');
const users = () => ctx.databases.common().collection('users');
const copies = () => ctx.databases.common().collection('places');
const originals = () => ctx.databases.group(gid(), 'cluster0').collection('places');
const ALL = { cash: true, warehouse: true, customersApp: true, tobaccosGamesMonopoly: true, productsVariants: true, services: true, scales: true, ordering: true, rooms: true, media: true };
const CATALOG = '/store-context/catalog';
const PRODUCTS = `${CATALOG}/products`;
const CATEGORIES = `${CATALOG}/categories`;
const BRANDS = `${CATALOG}/brands`;
const ATTRIBUTE_GROUPS = `${CATALOG}/attribute-groups`;
const operator = (id: ObjectId): Record<string, string> => ({ 'x-operator-id': hex(id) });
const pa = () => world.group(0).pa;
const get = (path: string, key = store.key) => world.asStore(key, 'GET', path);
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, who: ObjectId = pa(), key = store.key) => world.asStore(key, method, path, body, { ...(who === undefined ? {} : operator(who)), ...headers });
const create = (body: Document = {}, headers: Record<string, string> = {}) => send('POST', PRODUCTS, { name: { it: 'Acqua' }, places: [{ placeId: hex(own()) }], ...body }, { 'idempotency-key': randomUUID(), ...headers });
const tagOf = (reply: { headers: Headers }) => reply.headers.get('etag')!;
const ids = (reply: { body: { data: Array<{ id: string }> } }) => reply.body.data.map((item) => item.id);
const pageIds = (page: { data: Array<{ id: string }> }) => page.data.map((item) => item.id);
const entries = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const at = (days: number) => new Date(Date.UTC(2026, 0, days));

/** Pages of a list read to the end, following the cursor; the pages are returned. */
async function pagesOf(path: string): Promise<Array<{ data: Array<{ id: string }>; page: { limit: number; next: string | null } }>> {
  const pages = [];
  let next: string | null = null;
  do {
    const reply = await get(`${path}${path.includes('?') ? '&' : '?'}${next === null ? '' : `cursor=${next}&`}limit=2`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    pages.push(reply.body);
    next = reply.body.page.next;
  } while (next !== null);
  return pages;
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter });
  db = catalogCollections(ctx, world);
  await groups().updateOne({ _id: gid() }, { $set: Object.fromEntries(Object.entries(ALL).map(([key, flag]) => [`settings.${key}`, flag])) });
  await db.places.updateOne({ _id: own() }, { $set: { printStations: [{ id: 'st-1' }] } });
  store = await world.activate(own());
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  await Promise.all([db.products.deleteMany({}), db.categories.deleteMany({}), db.departments.deleteMany({}), db.brands.deleteMany({}), db.attributes.deleteMany({})]);
  await copies().updateMany({}, { $set: { trash: false, status: true } });
  await originals().updateMany({}, { $set: { trash: false } });
  await groups().updateOne({ _id: gid() }, { $set: { 'settings.languages': ['it'] } });
});

const seed = async (overrides: Document = {}): Promise<ObjectId> => {
  const document = legacyFullProduct(overrides);
  await db.products.insertOne(document);
  return document['_id'] as ObjectId;
};
const seedCategory = async (overrides: Document = {}): Promise<ObjectId> => {
  const document = legacyCategory(overrides);
  await db.categories.insertOne(document);
  return document['_id'] as ObjectId;
};

describe('the catalog of the store: reading products', () => {
  it('gives the products of its place and the ones for every place, whole, in the representation of the backoffice without the costs, the suppliers and the simple cost', async () => {
    const supplier = new ObjectId();
    const everyone = await seed({ name: { it: 'Per tutti' }, simpleCost: new Double(3), suppliers: [{ id: supplier, code: 'S-1', minQt: 1 }], lastAveragePrice: { lastSupplierId: supplier, total: { lastPrice: 2.5 }, suppliers: {} }, quantity: { [`__${hex(own())}`]: { [`__${'a'.repeat(24)}`]: { value: 4, min: 1, max: 9, location: 'A1' } }, [`__${hex(other())}`]: { [`__${'b'.repeat(24)}`]: { value: 7 } } } });
    const mine = await seed({ name: { it: 'Mio' }, placesAvailability: [placeEntry(own(), { favorite: true })] });
    const shared = await seed({ name: { it: 'Condiviso' }, placesAvailability: [placeEntry(own()), placeEntry(other(), { position: 3 })] });
    const elsewhere = await seed({ name: { it: 'Altrove' }, placesAvailability: [placeEntry(other())] });
    const trashed = await seed({ name: { it: 'Cestinato' }, trash: true });
    const disabled = await seed({ name: { it: 'Spento' }, status: false });
    const listed = await get(PRODUCTS);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(new Set(ids(listed)), new Set([hex(everyone), hex(mine), hex(shared), hex(disabled)]));
    assert.ok(!ids(listed).includes(hex(elsewhere)) && !ids(listed).includes(hex(trashed)));
    assert.deepEqual(listed.body.page, { limit: 25, next: null });
    for (const item of listed.body.data) {
      for (const forbidden of ['costs', 'suppliers', 'simpleCost', 'warnings', 'lastAveragePrice']) {
        assert.ok(!(forbidden in item), `${forbidden} is not given to a store`);
      }
    }
    const first = listed.body.data.find((item: { id: string }) => item.id === hex(everyone));
    assert.deepEqual(Object.keys(first.stock), [hex(own())], 'only the stock of its own place');
    assert.equal(first.stock[hex(own())][`${'a'.repeat(24)}`].quantity, 4);
    const sharedItem = listed.body.data.find((item: { id: string }) => item.id === hex(shared));
    assert.deepEqual(sharedItem.places.map((place: { placeId: string }) => place.placeId), [hex(own())], 'only its own place of the availability');
    // The same representation as the backoffice gives a place administrator of that place, for the fields they share.
    const detail = await world.as.call(pa(), 'GET', `/groups/${hex(gid())}/products/${hex(shared)}`);
    const { costs: _costs, suppliers: _suppliers, simpleCost: _simpleCost, warnings: _warnings, ...asBackoffice } = detail.body.data;
    assert.deepEqual(sharedItem, asBackoffice);
  });

  it('is asked for a family, a page and the changes since an instant, which include the disabled and the trashed products, oldest first', async () => {
    const old = await seed({ name: { it: 'Vecchio' }, updateDate: at(1) });
    const service = await seed({ name: { it: 'Servizio' }, type: 'service', updateDate: at(2) });
    const modifier = await seed({ name: { it: 'Variante' }, variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, updateDate: at(3) });
    const trashed = await seed({ name: { it: 'Cestinato' }, trash: true, updateDate: at(5) });
    const disabled = await seed({ name: { it: 'Spento' }, status: false, updateDate: at(4) });
    const noDate = await seed({ name: { it: 'Senza data' }, updateDate: undefined });
    assert.deepEqual(ids(await get(`${PRODUCTS}?family=services`)), [hex(service)]);
    assert.deepEqual(ids(await get(`${PRODUCTS}?family=modifiers`)), [hex(modifier)]);
    assert.deepEqual(new Set(ids(await get(`${PRODUCTS}?family=products`))), new Set([hex(old), hex(disabled), hex(noDate)]));
    const since = await get(`${PRODUCTS}?updatedSince=2026-01-03T00:00:00.000Z`);
    assert.deepEqual(ids(since), [hex(modifier), hex(disabled), hex(trashed)], 'oldest first, the disabled and the trashed ones included');
    assert.equal(since.body.data.at(-1).trashed, true);
    assert.equal(since.body.data[1].enabled, false);
    assert.deepEqual(ids(await get(`${PRODUCTS}?updatedSince=2026-01-04&family=products`)), [hex(disabled), hex(trashed)]);
    // Page after page, the whole catalog once, without the trashed one.
    const pages = await pagesOf(PRODUCTS);
    assert.deepEqual(pages.map((page) => page.page.limit), pages.map(() => 2));
    assert.deepEqual(new Set(pages.flatMap(pageIds)), new Set([hex(old), hex(service), hex(modifier), hex(disabled), hex(noDate)]));
    const changes = await pagesOf(`${PRODUCTS}?updatedSince=2026-01-01`);
    assert.deepEqual(changes.flatMap(pageIds), [hex(old), hex(service), hex(modifier), hex(disabled), hex(trashed)]);
  });

  it('refuses a page above its maximum, an unknown parameter (the place is the one of the key), a bad instant and a bad cursor', async () => {
    for (const query of ['limit=51', 'limit=0', `placeId=${hex(other())}`, 'q=a', 'sort=name', 'trashed=true', 'updatedSince=yesterday', 'cursor=not-a-cursor', 'family=everything', 'updatedSince=2026-01-01&updatedSince=2026-01-02']) {
      const reply = await get(`${PRODUCTS}?${query}`);
      assert.equal(reply.status, 422, query);
    }
    assert.equal((await get(`${PRODUCTS}?limit=50`)).status, 200);
  });

  it('gives one product with its version and the duplicate warnings without the ids of the other products, and 404 for what is not its own', async () => {
    const first = await seed({ code: 'DUP', name: { it: 'Uno' }, barcode: [{ value: '111', qtSale: 1 }] });
    await seed({ code: 'DUP', name: { it: 'Due' }, barcode: [{ value: '111', qtSale: 1 }], placesAvailability: [placeEntry(other())] });
    const reply = await get(`${PRODUCTS}/${hex(first)}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.match(tagOf(reply), /^"[A-Za-z0-9_-]{43}"$/);
    assert.deepEqual(reply.body.data.warnings, [
      { field: 'code', issue: 'duplicate' },
      { field: 'barcodes.0', issue: 'duplicate' },
    ]);
    assert.ok(!JSON.stringify(reply.body).includes('productIds'));
    const elsewhere = await seed({ placesAvailability: [placeEntry(other())] });
    const foreign = new ObjectId();
    await ctx.databases.group(world.group(1).groupId, 'cluster0').collection('products').insertOne(legacyFullProduct({ _id: foreign }));
    for (const id of [hex(elsewhere), hex(foreign), hex(new ObjectId())]) {
      assert.deepEqual([(await get(`${PRODUCTS}/${id}`)).status, (await get(`${PRODUCTS}/${id}`)).body.error.code], [404, 'NOT_FOUND'], id);
    }
    assert.equal((await get(`${PRODUCTS}/not-an-id`)).status, 422);
    assert.equal((await get(`${PRODUCTS}/${'g'.repeat(24)}`)).status, 422);
  });
});

describe('the catalog of the store: reading categories and departments', () => {
  it('gives the categories of its place and the ones for every place, with the changes since an instant, one by one and as a tree', async () => {
    const everyone = await seedCategory({ name: { it: 'Tutti' }, updateDate: at(1), position: 2 });
    const mine = await seedCategory({ name: { it: 'Mia' }, updateDate: at(3), parentId: everyone, placesAvailability: [{ id: own(), position: 1, productionCenterId: null }] });
    const elsewhere = await seedCategory({ name: { it: 'Altrove' }, updateDate: at(4), placesAvailability: [{ id: other(), position: 1, productionCenterId: null }] });
    const disabled = await seedCategory({ name: { it: 'Spenta' }, updateDate: at(2), status: false });
    const listed = await get(CATEGORIES);
    assert.deepEqual(ids(listed), [hex(everyone), hex(disabled), hex(mine)], 'oldest change first');
    assert.deepEqual(listed.body.page, { limit: 50, next: null });
    assert.deepEqual(ids(await get(`${CATEGORIES}?updatedSince=2026-01-02T12:00:00Z`)), [hex(mine)]);
    assert.deepEqual((await pagesOf(CATEGORIES)).flatMap(pageIds), [hex(everyone), hex(disabled), hex(mine)]);
    const one = await get(`${CATEGORIES}/${hex(mine)}`);
    assert.equal(one.status, 200);
    assert.match(tagOf(one), /^"/);
    const asBackoffice = await world.as.call(pa(), 'GET', `/groups/${hex(gid())}/product-categories/${hex(mine)}`);
    assert.deepEqual(one.body.data, asBackoffice.body.data);
    assert.deepEqual(listed.body.data.find((item: { id: string }) => item.id === hex(mine)), asBackoffice.body.data);
    assert.equal((await get(`${CATEGORIES}/${hex(elsewhere)}`)).status, 404);
    assert.equal((await get(`${CATEGORIES}/not-an-id`)).status, 422);
    const tree = await get(`${CATEGORIES}/tree`);
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.body.data.map((node: { id: string; children: Array<{ id: string }> }) => [node.id, node.children.map((child) => child.id)]), [[hex(disabled), []], [hex(everyone), [hex(mine)]]], 'by position: the first has one, the second two');
    assert.equal((await world.asStore(store.key, 'GET', `${CATEGORIES}/tree`, undefined, { 'if-none-match': tagOf(tree) })).status, 304);
    assert.equal((await get(`${CATEGORIES}?limit=101`)).status, 422);
    assert.equal((await get(`${CATEGORIES}?sort=name`)).status, 422);
    assert.equal((await get(`${CATEGORIES}/tree?x=1`)).status, 422);
  });

  it('gives the departments, a page at a time, and refuses them to a group without the cash function', async () => {
    const mine = legacyDepartment({ code: 1, name: { it: 'Reparto 1' } });
    const shared = legacyDepartment({ code: 2, name: { it: 'Reparto 2' }, placesAvailability: [own()] });
    const elsewhere = legacyDepartment({ code: 3, name: { it: 'Reparto 3' }, placesAvailability: [other()] });
    await db.departments.insertMany([mine, shared, elsewhere]);
    const listed = await get(`${CATALOG}/departments`);
    assert.deepEqual(ids(listed), [hex(mine['_id'] as ObjectId), hex(shared['_id'] as ObjectId)]);
    assert.deepEqual((await pagesOf(`${CATALOG}/departments`)).flatMap(pageIds), ids(listed));
    assert.equal((await get(`${CATALOG}/departments?limit=101`)).status, 422);
    assert.equal((await get(`${CATALOG}/departments?q=a`)).status, 422);
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.cash': false } });
    try {
      const refused = await get(`${CATALOG}/departments`);
      assert.deepEqual([refused.status, refused.body.error.code], [403, 'FEATURE_DISABLED']);
    } finally {
      await groups().updateOne({ _id: gid() }, { $set: { 'settings.cash': true } });
    }
  });
});

describe('the catalog of the store: writing products', () => {
  it('creates a product with the operator, answers 201 with its link and version, replays a retry and records the store as the actor and the operator apart', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = { name: { it: 'Pizza' }, code: 'PZ-1', places: [{ placeId: hex(own()) }] };
    const created = await send('POST', PRODUCTS, body, { 'idempotency-key': key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    assert.equal(created.headers.get('location'), `/v1${PRODUCTS}/${id}`);
    assert.match(tagOf(created), /^"/);
    assert.ok(!('costs' in created.body.data) && !('suppliers' in created.body.data));
    assert.equal(created.body.data.editable, true);
    const replay = await send('POST', PRODUCTS, body, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body, tagOf(replay)], [201, created.body, tagOf(created)]);
    assert.equal(await db.products.countDocuments({ _id: new ObjectId(id) }), 1);
    assert.equal(await db.products.countDocuments({ 'name.it': 'Pizza' }), 1, 'one product, however many times it is sent');
    assert.equal((await send('POST', PRODUCTS, { ...body, code: 'other' }, { 'idempotency-key': key })).status, 409);
    const [event] = entries('product.created', mark);
    assert.ok(event);
    assert.deepEqual([event.actor.kind, event.actor.id?.toHexString(), event.actor.role], ['store', store.keyId, undefined]);
    assert.equal(event.metadata?.['operatorId'], hex(pa()));
    assert.equal(event.groupId?.toHexString(), hex(gid()));
    // The key is the one of the store: a user with the same key of idempotency is another request.
    const asUser = await world.as.call(pa(), 'POST', `/groups/${hex(gid())}/products`, body, { 'idempotency-key': key });
    assert.equal(asUser.status, 201);
    assert.notEqual(asUser.body.data.id, id);
    assert.equal(entries('product.created', mark).at(-1)!.metadata?.['operatorId'], undefined, 'a user is the actor of his own writes, with no operator');
    assert.equal((await send('POST', PRODUCTS, body)).status, 422, 'the Idempotency-Key is required');
  });

  it('reads the language of the operator for the required texts, and the first of the group for a read', async () => {
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.languages': ['it', 'en'] } });
    await users().updateOne({ _id: pa() }, { $set: { 'settings.language': 'en' } });
    try {
      const refused = await create({ name: { it: 'Solo italiano' } });
      assert.deepEqual([refused.status, refused.body.error.details], [422, [{ field: 'name.en', issue: 'required' }]]);
      assert.equal((await create({ name: { en: 'Only English' } })).status, 201);
    } finally {
      await users().updateOne({ _id: pa() }, { $set: { 'settings.language': 'it' } });
    }
  });

  it('changes the prices with the version it read, 412 on a stale one, and never the fields of a product it shares', async () => {
    const mine = await create({ code: 'P-1' });
    const id = mine.body.data.id as string;
    const list = Object.keys((await groups().findOne({ _id: gid() }))!['priceLists'] as Document)[0]!;
    const taxId = ((await groups().findOne({ _id: gid() }))!['taxes'] as Document[])[0]!['id'] as string;
    const prices = [{ priceListId: list, currency: 'EUR', taxId, gross: 12.5 }];
    const changed = await send('PATCH', `${PRODUCTS}/${id}`, { prices }, { 'if-match': tagOf(mine) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.prices[0].gross, 12.5);
    assert.notEqual(tagOf(changed), tagOf(mine));
    assert.equal((await send('PATCH', `${PRODUCTS}/${id}`, { prices }, { 'if-match': tagOf(mine) })).status, 412);
    assert.equal((await send('PATCH', `${PRODUCTS}/${id}`, { prices })).status, 422, 'If-Match is required');
    assert.equal((await send('PATCH', `${PRODUCTS}/${id}`, {}, { 'if-match': tagOf(changed) })).status, 422);
    // A product that is for another place too: the data of its own place only.
    const shared = await seed({ placesAvailability: [placeEntry(own()), placeEntry(other())] });
    const read = await get(`${PRODUCTS}/${hex(shared)}`);
    assert.equal(read.body.data.editable, false);
    assert.equal(read.body.data.placeEditable, true);
    const refused = await send('PATCH', `${PRODUCTS}/${hex(shared)}`, { name: { it: 'Nuovo' } }, { 'if-match': tagOf(read) });
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details], [403, 'FORBIDDEN', [{ field: 'name', issue: 'notAllowed' }]]);
    const placeData = await send('PATCH', `${PRODUCTS}/${hex(shared)}`, { places: [{ placeId: hex(own()), favorite: true }] }, { 'if-match': tagOf(read) });
    assert.equal(placeData.status, 200, JSON.stringify(placeData.body));
    // A product for every place is not its own to change, and one of another place does not exist for it.
    const everyone = await seed({});
    const everyoneRead = await get(`${PRODUCTS}/${hex(everyone)}`);
    assert.equal((await send('PATCH', `${PRODUCTS}/${hex(everyone)}`, { name: { it: 'x' } }, { 'if-match': tagOf(everyoneRead) })).status, 403);
    const elsewhere = await seed({ placesAvailability: [placeEntry(other())] });
    assert.equal((await send('PATCH', `${PRODUCTS}/${hex(elsewhere)}`, { name: { it: 'x' } }, { 'if-match': tagOf(everyoneRead) })).status, 404);
  });

  it('duplicates, trashes and restores a product, and has no way to delete one for good or to empty the trash', async () => {
    const mark = world.office.activity.entries.length;
    const made = await create({ code: 'P-9' });
    const id = made.body.data.id as string;
    const copy = await send('POST', `${PRODUCTS}/${id}/duplicate`, undefined, { 'idempotency-key': randomUUID() });
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    assert.equal(copy.headers.get('location'), `/v1${PRODUCTS}/${copy.body.data.id}`);
    assert.deepEqual(copy.body.data.name, { it: 'Acqua (Copy)' });
    const trashed = await send('POST', `${PRODUCTS}/${id}/trash`, undefined, { 'if-match': tagOf(made) });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    assert.equal(trashed.body.data.trashed, true);
    assert.equal((await send('POST', `${PRODUCTS}/${id}/trash`, undefined, { 'if-match': tagOf(trashed) })).status, 409);
    assert.equal((await send('POST', `${PRODUCTS}/${id}/restore`, undefined, { 'if-match': tagOf(made) })).status, 412);
    const restored = await send('POST', `${PRODUCTS}/${id}/restore`, undefined, { 'if-match': tagOf(trashed) });
    assert.equal(restored.body.data.trashed, false);
    for (const action of ['product.duplicated', 'product.trashed', 'product.restored']) {
      const [event] = entries(action, mark);
      assert.deepEqual([event!.actor.kind, event!.metadata?.['operatorId']], ['store', hex(pa())], action);
    }
    // No deletion for good, no bulk trash, no emptying: the methods and the paths do not exist for a store.
    for (const [method, path] of [['DELETE', `${PRODUCTS}/${id}`], ['POST', `${PRODUCTS}/trash`], ['PUT', `${PRODUCTS}/${id}`], ['DELETE', PRODUCTS], ['POST', `${PRODUCTS}/${id}/delete`]] as const) {
      const reply = await send(method, path, {}, { 'if-match': tagOf(restored) });
      assert.ok([404, 405].includes(reply.status), `${method} ${path}: ${String(reply.status)}`);
    }
    assert.equal(await db.products.countDocuments({ _id: new ObjectId(id) }), 1);
    assert.equal((await world.asStore(store.key, 'POST', `${PRODUCTS}/${id}/trash`, undefined, { 'if-match': tagOf(restored) })).status, 403, 'a write without an operator is refused');
  });

  it('refuses a body that is too big, one that is not JSON and one that is not valid, after the operator and before anything is written', async () => {
    const big = await send('POST', PRODUCTS, { name: { it: 'x'.repeat(Number.parseInt(PRODUCT_BODY_LIMIT, 10) * 1024) } }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([big.status, big.body.error.code], [413, 'PAYLOAD_TOO_LARGE']);
    const text = await fetch(`${world.office.app.baseUrl}/v1${PRODUCTS}`, { method: 'POST', headers: { authorization: `Bearer ${store.key}`, 'content-type': 'text/plain', 'idempotency-key': randomUUID(), ...operator(pa()) }, body: 'name' });
    assert.equal(text.status, 415);
    assert.equal((await create({ unknownField: 1 })).status, 422);
    assert.equal((await create({ name: { it: '' } })).status, 422);
    assert.equal(await db.products.countDocuments({}), 0);
    // Without an operator the body is never read: a body that is not even JSON is 403, not 400.
    const unread = await fetch(`${world.office.app.baseUrl}/v1${PRODUCTS}`, { method: 'POST', headers: { authorization: `Bearer ${store.key}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{"name":' });
    assert.equal(unread.status, 403);
    assert.equal(((await unread.json()) as { error: { code: string } }).error.code, 'OPERATOR_NOT_ALLOWED');
  });
});

describe('the catalog of the store: writing categories', () => {
  it('creates, changes and deletes a category of its place, with the rules of the backoffice, and records the store with the operator', async () => {
    const mark = world.office.activity.entries.length;
    const key = randomUUID();
    const body = { name: { it: 'Bevande' }, places: [{ placeId: hex(own()) }] };
    const created = await send('POST', CATEGORIES, body, { 'idempotency-key': key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    assert.equal(created.headers.get('location'), `/v1${CATEGORIES}/${id}`);
    assert.deepEqual((await send('POST', CATEGORIES, body, { 'idempotency-key': key })).body, created.body);
    assert.equal((await send('POST', CATEGORIES, { ...body, parentId: id, places: [{ placeId: hex(other()) }] }, { 'idempotency-key': randomUUID() })).status, 403);
    const changed = await send('PATCH', `${CATEGORIES}/${id}`, { name: { it: 'Bibite' } }, { 'if-match': tagOf(created) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await send('PATCH', `${CATEGORIES}/${id}`, { name: { it: 'Altro' } }, { 'if-match': tagOf(created) })).status, 412);
    assert.equal((await send('PATCH', `${CATEGORIES}/${id}`, { parentId: id }, { 'if-match': tagOf(changed) })).status, 422, 'no cycle');
    const child = await send('POST', CATEGORIES, { name: { it: 'Figlia' }, parentId: id, places: [{ placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const inUse = await send('DELETE', `${CATEGORIES}/${id}`);
    assert.deepEqual([inUse.status, inUse.body.error.code], [409, 'CONFLICT'], 'no cascade, the child refers to it');
    assert.equal((await send('DELETE', `${CATEGORIES}/${child.body.data.id}`)).status, 204);
    assert.equal((await send('DELETE', `${CATEGORIES}/${id}`)).status, 204);
    assert.equal(await db.categories.countDocuments({}), 0);
    for (const action of ['productCategory.created', 'productCategory.updated', 'productCategory.deleted']) {
      assert.ok(entries(action, mark).every((entry) => entry.actor.kind === 'store' && entry.metadata?.['operatorId'] === hex(pa())), action);
    }
  });

  it('keeps a category for every place, one of another place and one shared with others out of its hands', async () => {
    const everyone = await seedCategory({ name: { it: 'Tutti' } });
    const shared = await seedCategory({ name: { it: 'Condivisa' }, placesAvailability: [{ id: own(), position: 1, productionCenterId: null }, { id: other(), position: 1, productionCenterId: null }] });
    const elsewhere = await seedCategory({ name: { it: 'Altrove' }, placesAvailability: [{ id: other(), position: 1, productionCenterId: null }] });
    for (const id of [everyone, shared]) {
      const read = await get(`${CATEGORIES}/${hex(id)}`);
      assert.equal(read.body.data.editable, false);
      assert.equal((await send('PATCH', `${CATEGORIES}/${hex(id)}`, { name: { it: 'x' } }, { 'if-match': tagOf(read) })).status, 403);
      assert.equal((await send('DELETE', `${CATEGORIES}/${hex(id)}`)).status, 403);
    }
    assert.equal((await send('PATCH', `${CATEGORIES}/${hex(elsewhere)}`, { name: { it: 'x' } }, { 'if-match': tagOf(await get(`${CATEGORIES}/${hex(everyone)}`)) })).status, 404);
    assert.equal((await send('DELETE', `${CATEGORIES}/${hex(elsewhere)}`)).status, 404);
    assert.equal((await send('POST', CATEGORIES, { name: { it: 'Per tutti' } }, { 'idempotency-key': randomUUID() })).status, 403, 'a category for every place is not its to make');
    assert.equal(await db.categories.countDocuments({}), 3);
  });
});

describe('the catalog of the store: brands', () => {
  const brand = async (overrides: Document = {}): Promise<ObjectId> => {
    const document = legacyBrand(overrides);
    await db.brands.insertOne(document);
    return document['_id'] as ObjectId;
  };

  it('reads the brands of its place and the ones for every place, the disabled ones included, page after page and since an instant', async () => {
    const everyone = await brand({ name: { it: 'Per tutti' }, updateDate: at(1) });
    const mine = await brand({ name: { it: 'Mia' }, placesAvailability: [own()], updateDate: at(2) });
    const shared = await brand({ name: { it: 'Condivisa' }, placesAvailability: [own(), other()], updateDate: at(3) });
    const elsewhere = await brand({ name: { it: 'Altrove' }, placesAvailability: [other()], updateDate: at(4) });
    const disabled = await brand({ name: { it: 'Spenta' }, status: false, updateDate: at(5) });
    const listed = await get(BRANDS);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(ids(listed), [hex(everyone), hex(mine), hex(shared), hex(disabled)], 'oldest change first, none of another place');
    assert.ok(!ids(listed).includes(hex(elsewhere)));
    assert.deepEqual(listed.body.page, { limit: 50, next: null });
    assert.equal(listed.body.data[3].enabled, false);
    assert.deepEqual(listed.body.data[2].placeIds, [hex(own())], 'only its own place of the availability');
    assert.deepEqual((await pagesOf(BRANDS)).flatMap(pageIds), [hex(everyone), hex(mine), hex(shared), hex(disabled)]);
    assert.deepEqual(ids(await get(`${BRANDS}?updatedSince=2026-01-03T00:00:00.000Z`)), [hex(shared), hex(disabled)]);
    const one = await get(`${BRANDS}/${hex(mine)}`);
    assert.equal(one.status, 200);
    assert.ok(one.headers.get('etag'));
    assert.equal((await get(`${BRANDS}/${hex(elsewhere)}`)).status, 404);
    assert.equal((await get(`${BRANDS}/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get(`${BRANDS}/zz`)).status, 422);
    for (const query of ['?sort=name', '?q=a', '?enabled=true', '?limit=101', '?updatedSince=ieri', '?placeId=x']) {
      assert.equal((await get(`${BRANDS}${query}`)).status, 422, query);
    }
  });

  it('creates, changes and deletes a brand of its place, with the rules of the backoffice, and records the store with the operator', async () => {
    const mark = world.office.activity.entries.length;
    const key = randomUUID();
    const body = { name: { it: 'Acme' }, placeIds: [hex(own())] };
    const created = await send('POST', BRANDS, body, { 'idempotency-key': key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    assert.equal(created.headers.get('location'), `/v1${BRANDS}/${id}`);
    assert.deepEqual((await send('POST', BRANDS, body, { 'idempotency-key': key })).body, created.body, 'a retry is replayed');
    assert.equal(await db.brands.countDocuments({}), 1);
    assert.equal((await send('POST', BRANDS, { name: { it: 'x' }, placeIds: [hex(other())] }, { 'idempotency-key': randomUUID() })).status, 403, 'a place that is not its own');
    assert.equal((await send('POST', BRANDS, { name: { it: 'Per tutti' } }, { 'idempotency-key': randomUUID() })).status, 403, 'a brand for every place is not its to make');
    assert.equal((await send('POST', BRANDS, { name: { it: 'x' }, placeIds: [hex(own())] })).status, 422, 'a creation needs its Idempotency-Key');
    const changed = await send('PATCH', `${BRANDS}/${id}`, { name: { it: 'Acme 2' } }, { 'if-match': tagOf(created) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.name.it, 'Acme 2');
    assert.equal((await send('PATCH', `${BRANDS}/${id}`, { name: { it: 'Altro' } }, { 'if-match': tagOf(created) })).status, 412);
    assert.equal((await send('PATCH', `${BRANDS}/${id}`, { name: { it: 'Altro' } })).status, 422, 'If-Match is required');
    assert.equal((await send('PATCH', `${BRANDS}/${id}`, {}, { 'if-match': tagOf(changed) })).status, 422);
    await db.products.insertOne(legacyFullProduct({ brandId: new ObjectId(id) }));
    const inUse = await send('DELETE', `${BRANDS}/${id}`);
    assert.deepEqual([inUse.status, inUse.body.error.code], [409, 'CONFLICT'], 'a product has it');
    await db.products.deleteMany({});
    assert.equal((await send('DELETE', `${BRANDS}/${id}`)).status, 204);
    assert.equal(await db.brands.countDocuments({}), 0);
    for (const action of ['productBrand.created', 'productBrand.updated', 'productBrand.deleted']) {
      const found = entries(action, mark);
      assert.ok(found.length > 0 && found.every((entry) => entry.actor.kind === 'store' && entry.metadata?.['operatorId'] === hex(pa())), action);
    }
  });

  it('refuses the image, the places of others and the operator it does not have, and keeps a brand for every place, of another place or shared out of its hands', async () => {
    const everyone = await brand({ name: { it: 'Tutti' } });
    const shared = await brand({ name: { it: 'Condivisa' }, placesAvailability: [own(), other()] });
    const elsewhere = await brand({ name: { it: 'Altrove' }, placesAvailability: [other()] });
    const tag = tagOf(await get(`${BRANDS}/${hex(everyone)}`));
    assert.equal((await send('POST', BRANDS, { name: { it: 'x' }, placeIds: [hex(own())], image: null }, { 'idempotency-key': randomUUID() })).status, 422, 'no image');
    assert.equal((await send('PATCH', `${BRANDS}/${hex(everyone)}`, { image: { imageId: hex(new ObjectId()) } }, { 'if-match': tag })).status, 422);
    for (const id of [everyone, shared]) {
      const read = await get(`${BRANDS}/${hex(id)}`);
      assert.equal(read.body.data.editable, false);
      assert.equal((await send('PATCH', `${BRANDS}/${hex(id)}`, { name: { it: 'x' } }, { 'if-match': tagOf(read) })).status, 403);
      assert.equal((await send('DELETE', `${BRANDS}/${hex(id)}`)).status, 403);
    }
    assert.equal((await send('PATCH', `${BRANDS}/${hex(elsewhere)}`, { name: { it: 'x' } }, { 'if-match': tag })).status, 404);
    assert.equal((await send('DELETE', `${BRANDS}/${hex(elsewhere)}`)).status, 404);
    assert.equal(await db.brands.countDocuments({}), 3);
    // Without a verified operator nothing is read, as for the products.
    const noOperator = await world.asStore(store.key, 'DELETE', `${BRANDS}/${hex(everyone)}`);
    assert.equal(noOperator.body.error.code, 'OPERATOR_NOT_ALLOWED');
    // A user does not reach the routes of the store, and a store key not the ones of the backoffice.
    assert.equal((await world.as.call(pa(), 'GET', BRANDS)).status, 403);
    assert.equal((await world.asStore(store.key, 'GET', `/groups/${hex(gid())}/product-brands`)).status, 403);
  });

  it('lets a store of a group with one place only change a brand for every place, and takes it back with a second place', async () => {
    const everyone = await brand({ name: { it: 'Tutti' } });
    await Promise.all([copies().updateOne({ _id: other() }, { $set: { trash: true } }), originals().updateOne({ _id: other() }, { $set: { trash: true } })]);
    try {
      const read = await get(`${BRANDS}/${hex(everyone)}`);
      assert.equal(read.body.data.editable, true);
      const renamed = await send('PATCH', `${BRANDS}/${hex(everyone)}`, { name: { it: 'Mia' } }, { 'if-match': tagOf(read) });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      const forAll = await send('POST', BRANDS, { name: { it: 'Nuova per tutti' } }, { 'idempotency-key': randomUUID() });
      assert.equal(forAll.status, 201, JSON.stringify(forAll.body));
    } finally {
      await Promise.all([copies().updateOne({ _id: other() }, { $set: { trash: false } }), originals().updateOne({ _id: other() }, { $set: { trash: false } })]);
    }
    assert.equal((await get(`${BRANDS}/${hex(everyone)}`)).body.data.editable, false);
  });
});

describe('the catalog of the store: the activity log as it is stored', () => {
  it('keeps the store as the actor and the operator in the metadata of every write, with nothing redacted and nothing refused by the real log', async () => {
    const mark = world.office.activity.entries.length;
    const product = await create({ code: 'LOG-1' });
    const trashed = await send('POST', `${PRODUCTS}/${product.body.data.id}/trash`, undefined, { 'if-match': tagOf(product) });
    await send('POST', `${PRODUCTS}/${product.body.data.id}/restore`, undefined, { 'if-match': tagOf(trashed) });
    await send('POST', `${PRODUCTS}/${product.body.data.id}/duplicate`, undefined, { 'idempotency-key': randomUUID() });
    const category = await send('POST', CATEGORIES, { name: { it: 'Log' }, places: [{ placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() });
    await send('DELETE', `${CATEGORIES}/${category.body.data.id}`);
    const brand = await send('POST', BRANDS, { name: { it: 'Log' }, placeIds: [hex(own())] }, { 'idempotency-key': randomUUID() });
    const renamed = await send('PATCH', `${BRANDS}/${brand.body.data.id}`, { name: { it: 'Log 2' } }, { 'if-match': tagOf(brand) });
    assert.equal(renamed.status, 200);
    await send('DELETE', `${BRANDS}/${brand.body.data.id}`);
    const { stored, refused } = await throughRealLog(ctx, world.office.activity.entries.slice(mark));
    assert.deepEqual(refused, []);
    assert.ok(stored.length >= 9);
    for (const entry of stored) {
      assert.equal(entry['actor'].kind, 'store', entry['action']);
      assert.equal(entry['metadata']['operatorId'], hex(pa()), entry['action']);
    }
    assert.ok(!JSON.stringify(stored).includes('REDACTED'));
  });
});

describe('the catalog of the store: groups of attributes', () => {
  it('reads them, page after page and since an instant, and one, and never writes them', async () => {
    const first = legacyAttributeGroup({ name: { it: 'Colori' }, updateDate: at(1) });
    const second = legacyAttributeGroup({ name: { it: 'Taglie' }, updateDate: at(3) });
    await db.attributes.insertMany([second, first]);
    const listed = await get(ATTRIBUTE_GROUPS);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(ids(listed), [hex(first['_id'] as ObjectId), hex(second['_id'] as ObjectId)]);
    assert.deepEqual(listed.body.data[0].attributes, [{ id: 'attr-1', name: { it: 'Rosso' } }, { id: 'attr-2', name: { it: 'Blu' } }]);
    assert.equal(listed.body.data[0].editable, false);
    assert.deepEqual(listed.body.page, { limit: 50, next: null });
    assert.equal((await pagesOf(ATTRIBUTE_GROUPS)).flatMap(pageIds).length, 2);
    assert.deepEqual(ids(await get(`${ATTRIBUTE_GROUPS}?updatedSince=2026-01-02`)), [hex(second['_id'] as ObjectId)]);
    const one = await get(`${ATTRIBUTE_GROUPS}/${hex(first['_id'] as ObjectId)}`);
    assert.equal(one.status, 200);
    assert.ok(one.headers.get('etag'));
    assert.equal((await get(`${ATTRIBUTE_GROUPS}/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get(`${ATTRIBUTE_GROUPS}?q=a`)).status, 422);
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      const path = method === 'POST' ? ATTRIBUTE_GROUPS : `${ATTRIBUTE_GROUPS}/${hex(first['_id'] as ObjectId)}`;
      const reply = await send(method, path, { name: { it: 'x' } }, { 'idempotency-key': randomUUID(), 'if-match': tagOf(one) });
      assert.ok([404, 405].includes(reply.status), `${method} is not a route of the store: ${String(reply.status)}`);
    }
    assert.equal(await db.attributes.countDocuments({}), 2);
  });
});

describe('the catalog of the store: the operator', () => {
  const REFUSED = { status: 403, body: { error: { code: 'OPERATOR_NOT_ALLOWED', message: 'Operator not allowed' } } };
  let mine: ObjectId;
  let tag: string;
  const user = async (n: number, overrides: Document = {}): Promise<ObjectId> => {
    const document = legacyUser(n, { groupId: gid(), dealerId: world.group(0).dealerId, permissions: legacyPermissions({ status: false, modules: { products: { r: true, w: true } } }), ...overrides });
    await users().deleteOne({ _id: document['_id'] });
    await users().insertOne(document);
    return document['_id'] as ObjectId;
  };
  beforeEach(async () => {
    const made = await create();
    mine = new ObjectId(made.body.data.id as string);
    tag = tagOf(made);
    await db.products.deleteMany({ _id: { $ne: mine } });
  });
  const attempt = async (headers: Record<string, string>) => {
    limiter.reset();
    const mark = world.office.activity.entries.length;
    const reply = await world.asStore(store.key, 'PATCH', `${PRODUCTS}/${hex(mine)}`, { enabled: false }, { 'if-match': tag, ...headers });
    return { reply, mark };
  };

  it('is one answer, byte for byte, for a missing, malformed, unknown, foreign, trashed, disabled and unauthorized operator, and nothing is written', async () => {
    const ofOtherPlace = world.group(0).employee; // an E of the other place
    const trashedUser = await user(901, { role: 'PA', placeId: own(), placesId: [own()], trash: true });
    const disabledUser = await user(902, { role: 'PA', placeId: own(), placesId: [own()], status: false });
    const readOnly = await user(903, { role: 'PA', placeId: own(), placesId: [own()], permissions: legacyPermissions({ status: false, modules: { products: { r: true, w: false } } }) });
    const noMatrix = await user(904, { role: 'PA', placeId: own(), placesId: [own()], permissions: null });
    const otherGroup = world.group(1).pa;
    const cases: Array<[string, Record<string, string>, string]> = [
      ['missing', {}, 'missing'],
      ['malformed', { 'x-operator-id': 'zz' }, 'malformed'],
      ['twice', { 'x-operator-id': `${hex(pa())}, ${hex(pa())}` }, 'malformed'],
      ['unknown', operator(new ObjectId()), 'notFound'],
      ['of the other place', operator(ofOtherPlace), 'notFound'],
      ['of another group', operator(otherGroup), 'notFound'],
      ['a PSA', operator(world.office.cluster.psa), 'notFound'],
      ['a dealer', operator(world.office.cluster.dealerA), 'notFound'],
      ['trashed', operator(trashedUser), 'notFound'],
      ['disabled', operator(disabledUser), 'disabled'],
      ['without the write flag', operator(readOnly), 'noPermission'],
      ['without a matrix', operator(noMatrix), 'noPermission'],
    ];
    const answers = new Set<string>();
    for (const [name, headers, reason] of cases) {
      const { reply, mark } = await attempt(headers);
      answers.add(JSON.stringify({ status: reply.status, body: reply.body }));
      assert.deepEqual({ status: reply.status, body: reply.body }, REFUSED, name);
      assert.equal(reply.headers.get('etag'), null);
      const [event] = entries('store.operatorRejected', mark);
      assert.ok(event, name);
      assert.deepEqual([event.category, event.outcome, event.actor.kind, event.actor.id?.toHexString(), event.metadata?.['reason']], ['security', 'denied', 'store', store.keyId, reason], name);
      assert.equal(event.groupId?.toHexString(), hex(gid()));
    }
    assert.equal(answers.size, 1, 'nothing tells one refusal from another');
    assert.equal((await db.products.findOne({ _id: mine }))!['status'], true);
    // The declared id is in the event only when it is well formed, and the log never says more of the user.
    const { mark } = await attempt(operator(ofOtherPlace));
    assert.equal(entries('store.operatorRejected', mark)[0]!.metadata?.['operatorId'], hex(ofOtherPlace));
    const malformed = await attempt({ 'x-operator-id': 'zz' });
    assert.equal(entries('store.operatorRejected', malformed.mark)[0]!.metadata?.['operatorId'], undefined);
  });

  it('records a refused operator once an hour for a key and an address', async () => {
    limiter.reset();
    const mark = world.office.activity.entries.length;
    for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1) {
      await world.asStore(store.key, 'PATCH', `${PRODUCTS}/${hex(mine)}`, { enabled: false }, { 'if-match': tag });
    }
    assert.equal(entries('store.operatorRejected', mark).length, 1);
  });

  it('lets in the users of its set that may write the products: a place administrator, an employee of the place, the administrator of its company and of the group', async () => {
    const employee = await user(911, { role: 'E', placeId: own(), placesId: [own()] });
    const ca = world.group(0).ca;
    const sa = world.group(0).sa;
    for (const who of [pa(), employee, ca, sa]) {
      const current = await get(`${PRODUCTS}/${hex(mine)}`);
      const reply = await send('PATCH', `${PRODUCTS}/${hex(mine)}`, { favorite: who === pa() }, { 'if-match': tagOf(current) }, who);
      assert.equal(reply.status, 200, `${hex(who)}: ${JSON.stringify(reply.body)}`);
    }
    // The operator of a read is not asked: no header, no event.
    const mark = world.office.activity.entries.length;
    assert.equal((await get(PRODUCTS)).status, 200);
    assert.equal(entries('store.operatorRejected', mark).length, 0);
  });
});

describe('the catalog of the store: who may call it and when', () => {
  it('is refused to a user (403), to a missing, forged or revoked key (401) and to a store that is not operational (STORE_DISABLED), and a store key does not reach the routes of the users', async () => {
    const token = (await world.as.tokenOf(pa()));
    const refusals: Array<[string, string, unknown?]> = [['GET', PRODUCTS], ['GET', `${PRODUCTS}/${hex(new ObjectId())}`], ['POST', PRODUCTS, { name: { it: 'x' } }], ['GET', CATEGORIES], ['GET', `${CATEGORIES}/tree`], ['DELETE', `${CATEGORIES}/${hex(new ObjectId())}`], ['GET', `${CATALOG}/departments`]];
    for (const [method, path, body] of refusals) {
      const asUser = await world.office.call(method, path, token, body, { ...operator(pa()), 'idempotency-key': randomUUID() });
      assert.deepEqual([asUser.status, ((await asUser.json()) as { error: { code: string } }).error.code], [403, 'FORBIDDEN'], `${method} ${path}`);
      assert.equal((await world.asStore(undefined, method, path, body)).status, 401);
      assert.equal((await world.asStore(`fc_sk_${'x'.repeat(43)}`, method, path, body)).status, 401);
    }
    // The routes of the backoffice stay shut to a store key: the same catalog, under the group, is 403.
    const g = `/groups/${hex(gid())}`;
    for (const [method, path] of [['GET', `${g}/products`], ['POST', `${g}/products`], ['GET', `${g}/products/${hex(new ObjectId())}`], ['PATCH', `${g}/products/${hex(new ObjectId())}`], ['POST', `${g}/products/trash`], ['DELETE', `${g}/products/${hex(new ObjectId())}`], ['GET', `${g}/product-categories`], ['GET', `${g}/product-categories/tree`], ['DELETE', `${g}/product-categories/${hex(new ObjectId())}`], ['GET', `${g}/product-departments`], ['GET', `${g}/product-brands`], ['GET', `${g}/product-attribute-groups`], ['POST', `${g}/trash/products/restore`], ['POST', `${g}/trash/products/delete`], ['POST', `${g}/trash/products/empty`]] as const) {
      const reply = await send(method, path, method === 'GET' ? undefined : {});
      assert.equal(reply.status, 403, `${method} ${path}`);
    }
    // Revoked: a new activation revokes the old key.
    const old = store;
    store = await world.activate(own());
    try {
      assert.equal((await get(PRODUCTS, old.key)).status, 401);
      assert.equal((await send('POST', PRODUCTS, { name: { it: 'x' } }, { 'idempotency-key': randomUUID() }, pa(), old.key)).status, 401);
      assert.equal((await get(PRODUCTS)).status, 200);
      // The place disabled: the store is not operational, for a read and for a write, and the body of the write is not read.
      await copies().updateOne({ _id: own() }, { $set: { status: false } });
      assert.deepEqual([(await get(PRODUCTS)).body.error.code, (await create()).body.error.code], ['STORE_DISABLED', 'STORE_DISABLED']);
    } finally {
      await copies().updateOne({ _id: own() }, { $set: { status: true } });
    }
  });

  it('is limited per store key, writes included, before anything else is read', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_API_PER_STORE: '3' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await office.activate(office.group(0).ownPlaceId);
      const statuses = [];
      for (let index = 0; index < 4; index += 1) {
        statuses.push((await office.asStore(key.key, index === 2 ? 'POST' : 'GET', PRODUCTS, index === 2 ? { name: { it: 'x' }, places: [{ placeId: hex(office.group(0).ownPlaceId) }] } : undefined, { 'x-operator-id': hex(office.group(0).pa), 'idempotency-key': randomUUID() })).status);
      }
      assert.deepEqual(statuses, [200, 200, 201, 429]);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });

  it('opens to a store key these routes and no other (the list is asserted in full, the contacts and the cards included)', () => {
    const modules = createBackofficeModules({ config: testConfig(), databases: ctx.databases, activityLog: memoryActivityLog(), logger: memoryLogger().logger, rateLimiter: memoryRateLimiter() });
    const open = modules.routes.filter((route) => route.auth.kind === 'store' || (route.auth.kind === 'user' && route.auth.store === true)).map((route) => `${route.method} ${route.path}`).sort();
    assert.deepEqual(open, [
      'DELETE /store-context/catalog/brands/:brandId',
      'DELETE /store-context/catalog/categories/:categoryId',
      'DELETE /store-context/sales/:saleId',
      'GET /store-context',
      'GET /store-context/catalog/attribute-groups',
      'GET /store-context/catalog/attribute-groups/:attributeGroupId',
      'GET /store-context/catalog/brands',
      'GET /store-context/catalog/brands/:brandId',
      'GET /store-context/catalog/categories',
      'GET /store-context/catalog/categories/:categoryId',
      'GET /store-context/catalog/categories/tree',
      'GET /store-context/catalog/departments',
      'GET /store-context/catalog/products',
      'GET /store-context/catalog/products/:productId',
      'GET /store-context/company',
      'GET /store-context/contact-groups',
      'GET /store-context/contacts',
      'GET /store-context/contacts/:contactId',
      'GET /store-context/countries',
      'GET /store-context/fidelity-cards',
      'GET /store-context/fidelity-cards/:cardId',
      'GET /store-context/fidelity-cards/:cardId/movements',
      'GET /store-context/group',
      'GET /store-context/place',
      'GET /store-context/sales',
      'GET /store-context/sales/:saleId',
      'GET /store-context/users',
      'PATCH /store-context/catalog/brands/:brandId',
      'PATCH /store-context/catalog/categories/:categoryId',
      'PATCH /store-context/catalog/products/:productId',
      'PATCH /store-context/contacts/:contactId',
      'PATCH /store-context/fidelity-cards/:cardId',
      'PATCH /store-context/sales/:saleId',
      'POST /store-context/catalog/brands',
      'POST /store-context/catalog/categories',
      'POST /store-context/catalog/products',
      'POST /store-context/catalog/products/:productId/duplicate',
      'POST /store-context/catalog/products/:productId/restore',
      'POST /store-context/catalog/products/:productId/trash',
      'POST /store-context/contacts',
      'POST /store-context/contacts/:contactId/fidelity-cards/:code/points-adjustments',
      'POST /store-context/contacts/:contactId/trash',
      'POST /store-context/fidelity-cards',
      'POST /store-context/fidelity-cards/:cardId/adjustments',
      'POST /store-context/sales',
      'POST /store-context/sales/:saleId/cancellation',
      'POST /store-context/sales/:saleId/refunds',
    ]);
    for (const route of modules.routes.filter((candidate) => candidate.auth.kind === 'store' && candidate.method !== 'GET')) {
      assert.equal(typeof (route.auth as { operator?: unknown }).operator, 'function', `${route.method} ${route.path} verifies the operator`);
    }
  });
});

describe('the catalog of the store: a group with one place only', () => {
  const sole = () => Promise.all([copies().updateOne({ _id: other() }, { $set: { trash: true } }), originals().updateOne({ _id: other() }, { $set: { trash: true } })]);
  const second = () => Promise.all([copies().updateOne({ _id: other() }, { $set: { trash: false } }), originals().updateOne({ _id: other() }, { $set: { trash: false } })]);
  afterEachRestore();

  it('lets it change an entry for every place as a whole and create one, and the second place takes that back on the next request', async () => {
    const everyone = await seed({ name: { it: 'Per tutti' } });
    const everyoneCategory = await seedCategory({ name: { it: 'Categoria per tutti' } });
    const read = await get(`${PRODUCTS}/${hex(everyone)}`);
    assert.equal(read.body.data.editable, false);
    assert.equal((await send('PATCH', `${PRODUCTS}/${hex(everyone)}`, { name: { it: 'Mio' } }, { 'if-match': tagOf(read) })).status, 403);
    assert.equal((await send('POST', PRODUCTS, { name: { it: 'Per tutti' } }, { 'idempotency-key': randomUUID() })).status, 403);
    await sole();
    const now = await get(`${PRODUCTS}/${hex(everyone)}`);
    assert.equal(now.body.data.editable, true);
    const renamed = await send('PATCH', `${PRODUCTS}/${hex(everyone)}`, { name: { it: 'Mio' }, places: [{ placeId: hex(own()) }] }, { 'if-match': tagOf(now) });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.data.name.it, 'Mio');
    const forAll = await send('POST', PRODUCTS, { name: { it: 'Nuovo per tutti' } }, { 'idempotency-key': randomUUID() });
    assert.equal(forAll.status, 201, JSON.stringify(forAll.body));
    assert.deepEqual(forAll.body.data.places, []);
    const category = await get(`${CATEGORIES}/${hex(everyoneCategory)}`);
    assert.equal(category.body.data.editable, true);
    assert.equal((await send('PATCH', `${CATEGORIES}/${hex(everyoneCategory)}`, { name: { it: 'Cambiata' } }, { 'if-match': tagOf(category) })).status, 200);
    assert.equal((await send('POST', CATEGORIES, { name: { it: 'Categoria nuova per tutti' } }, { 'idempotency-key': randomUUID() })).status, 201);
    assert.equal((await send('DELETE', `${CATEGORIES}/${hex(everyoneCategory)}`)).status, 204);
    // An entry of another place stays out of its reach, and a shared one shared.
    const elsewhere = await seed({ placesAvailability: [placeEntry(other())] });
    assert.equal((await get(`${PRODUCTS}/${hex(elsewhere)}`)).status, 404);
    const sharedWithTrashed = await seed({ placesAvailability: [placeEntry(own()), placeEntry(other())] });
    assert.equal((await get(`${PRODUCTS}/${hex(sharedWithTrashed)}`)).body.data.editable, false);
    // A second place, and the very next request is back to the rules of two places.
    await second();
    const back = await get(`${PRODUCTS}/${forAll.body.data.id as string}`);
    assert.equal(back.body.data.editable, false);
    assert.equal((await send('PATCH', `${PRODUCTS}/${forAll.body.data.id}`, { name: { it: 'x' } }, { 'if-match': tagOf(back) })).status, 403);
    assert.equal((await send('POST', PRODUCTS, { name: { it: 'Ancora per tutti' } }, { 'idempotency-key': randomUUID() })).status, 403);
  });

  it('does not apply when the one place that is not in the trash is not the one of the key', async () => {
    await Promise.all([copies().updateOne({ _id: own() }, { $set: { trash: true } }), originals().updateOne({ _id: own() }, { $set: { trash: true } })]);
    await second();
    const everyone = await seed({ name: { it: 'Per tutti' } });
    // The store of a place in the trash is not operational, so the rule is judged with the place of another caller: the place administrator of the trashed place gets nothing from it.
    const read = await world.as.call(pa(), 'GET', `/groups/${hex(gid())}/products/${hex(everyone)}`);
    assert.equal(read.body.data.editable, false);
  });
});

describe('the group with one place: the two sources must agree', () => {
  const other0 = () => ({ _id: other() });
  const cases: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    ['the copy of the second place is missing', async () => copies().deleteOne(other0()), async () => copies().insertOne({ ...(await originals().findOne(other0()))!, groupId: gid() })],
    ['the copy of the second place is in the trash and the original is not', async () => copies().updateOne(other0(), { $set: { trash: true } }), async () => copies().updateOne(other0(), { $set: { trash: false } })],
    ['the original of the second place is in the trash and the copy is not', async () => originals().updateOne(other0(), { $set: { trash: true } }), async () => originals().updateOne(other0(), { $set: { trash: false } })],
    [
      'each source has a different place left',
      async () => Promise.all([copies().updateOne(other0(), { $set: { trash: true } }), originals().updateOne({ _id: own() }, { $set: { trash: true } })]),
      async () => Promise.all([copies().updateOne(other0(), { $set: { trash: false } }), originals().updateOne({ _id: own() }, { $set: { trash: false } })]),
    ],
  ];
  for (const [name, break_, mend] of cases) {
    it(`gives no exception to the store, the company administrator or the place administrator when ${name}`, async () => {
      const everyone = await seed({ name: { it: 'Per tutti' } });
      const category = await seedCategory({ name: { it: 'Per tutti' } });
      await break_();
      try {
        const store = await get(`${PRODUCTS}/${hex(everyone)}`);
        assert.equal(store.body.data.editable, false);
        assert.equal((await get(`${CATEGORIES}/${hex(category)}`)).body.data.editable, false);
        assert.equal((await send('POST', PRODUCTS, { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 403);
        for (const actor of [world.group(0).ca, world.group(0).pa]) {
          assert.equal((await world.as.call(actor, 'GET', `/groups/${hex(gid())}/products/${hex(everyone)}`)).body.data.editable, false);
          assert.equal((await world.as.call(actor, 'POST', `/groups/${hex(gid())}/products`, { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 403);
        }
      } finally {
        await mend();
      }
    });
  }
});

describe('the catalog of the store: what it may not write, and what it may not refer to', () => {
  const MODIFIER = { variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } } };
  it('refuses the fields of costs, suppliers and images as unknown keys and writes nothing, in a creation and in a modification', async () => {
    const mine = await create();
    const id = mine.body.data.id as string;
    for (const field of ['simpleCost', 'suppliers', 'image', 'gallery']) {
      const value = field === 'simpleCost' ? 3 : field === 'suppliers' ? [{ contactId: hex(new ObjectId()) }] : field === 'image' ? { imageId: hex(new ObjectId()) } : [];
      const created = await create({ [field]: value });
      assert.deepEqual([created.status, created.body.error.details], [422, [{ field, issue: 'unknown' }]], field);
      const patched = await send('PATCH', `${PRODUCTS}/${id}`, { [field]: value }, { 'if-match': tagOf(mine) });
      assert.deepEqual([patched.status, patched.body.error.details], [422, [{ field, issue: 'unknown' }]], field);
    }
    assert.equal(await db.products.countDocuments({}), 1);
    assert.equal(tagOf(await get(`${PRODUCTS}/${id}`)), tagOf(mine));
    assert.equal((await create({ name: { it: 'ok' }, shipping: { width: 1 } })).status, 201, 'the other fields are the ones of the backoffice');
  });

  it('refuses the image and the icon of a category as unknown keys and writes nothing', async () => {
    const made = await send('POST', CATEGORIES, { name: { it: 'Bevande' }, places: [{ placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() });
    assert.equal(made.status, 201);
    for (const field of ['image', 'icon']) {
      const value = { imageId: hex(new ObjectId()) };
      const created = await send('POST', CATEGORIES, { name: { it: 'Altra' }, places: [{ placeId: hex(own()) }], [field]: value }, { 'idempotency-key': randomUUID() });
      assert.deepEqual([created.status, created.body.error.details], [422, [{ field, issue: 'unknown' }]], field);
      const patched = await send('PATCH', `${CATEGORIES}/${made.body.data.id}`, { [field]: value }, { 'if-match': tagOf(made) });
      assert.deepEqual([patched.status, patched.body.error.details], [422, [{ field, issue: 'unknown' }]], field);
    }
    assert.equal(await db.categories.countDocuments({}), 1);
    assert.equal(tagOf(await get(`${CATEGORIES}/${made.body.data.id}`)), tagOf(made));
  });

  it('copies the costs and suppliers of the product of origin in a duplicate, without ever showing them', async () => {
    const source = await seed({ placesAvailability: [placeEntry(own())], simpleCost: new Double(9), suppliers: [{ id: new ObjectId(), code: 'S-1' }] });
    const copy = await send('POST', `${PRODUCTS}/${hex(source)}/duplicate`, undefined, { 'idempotency-key': randomUUID() });
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    assert.ok(!('suppliers' in copy.body.data) && !('simpleCost' in copy.body.data));
    const stored = await db.products.findOne({ _id: new ObjectId(copy.body.data.id as string) });
    assert.deepEqual([stored!['simpleCost'], (stored!['suppliers'] as Document[]).length], [9, 1], 'the copy keeps the cost and the suppliers of the source');
  });

  it('judges a reference to something of another place or of another group as the backoffice does for a place administrator', async () => {
    const elsewhereCategory = await seedCategory({ name: { it: 'Altrove' }, placesAvailability: [{ id: other(), position: 1, productionCenterId: null }] });
    const elsewhereProduct = await seed({ placesAvailability: [placeEntry(other())] });
    const elsewhereModifier = await seed({ ...MODIFIER, placesAvailability: [placeEntry(other())] });
    const mine = await create();
    const tag = tagOf(mine);
    const id = mine.body.data.id as string;
    const patch = (body: Document) => send('PATCH', `${PRODUCTS}/${id}`, body, { 'if-match': tag });
    const unprocessable = async (reply: ReturnType<typeof patch>, field: string) => {
      const got = await reply;
      assert.equal(got.status, 422, field);
      assert.ok((got.body.error.details as Array<{ field: string; issue: string }>).some((detail) => detail.field.startsWith(field) && detail.issue === 'incorrect'), `${field}: ${JSON.stringify(got.body)}`);
    };
    await unprocessable(patch({ categoryIds: [hex(elsewhereCategory)] }), 'categoryIds');
    await unprocessable(patch({ components: [{ productId: hex(elsewhereProduct), quantity: 1 }] }), 'components');
    await unprocessable(patch({ modifierIds: [hex(elsewhereModifier)] }), 'modifierIds');
    await unprocessable(patch({ modifierCategoryIds: [hex(elsewhereCategory)] }), 'modifierCategoryIds');
    await unprocessable(patch({ menu: [{ categoryId: hex(elsewhereCategory), quantity: 1 }] }), 'menu');
    const category = await send('POST', CATEGORIES, { name: { it: 'Figlia' }, parentId: hex(elsewhereCategory), places: [{ placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([category.status, category.body.error.details], [422, [{ field: 'parentId', issue: 'incorrect' }]]);
    const foreignPlace = hex(world.group(1).ownPlaceId);
    for (const place of [hex(other()), foreignPlace]) {
      assert.equal((await patch({ places: [{ placeId: place }] })).status, 403, `places ${place}`);
      assert.equal((await patch({ stock: { [place]: { [hex(new ObjectId())]: { min: 1 } } } })).status, 403, `stock ${place}`);
      assert.equal((await patch({ printStations: { [place]: ['st-1'] } })).status, 403, `printStations ${place}`);
    }
  });

  it('keeps the answers of an Idempotency-Key to the store key that sent it, and refuses a public API key and an operator in capitals', async () => {
    const key = randomUUID();
    const body = { name: { it: 'Una sola volta' }, places: [{ placeId: hex(own()) }] };
    const first = await send('POST', PRODUCTS, body, { 'idempotency-key': key });
    assert.equal(first.status, 201);
    const newKey = await world.activate(own());
    store = newKey;
    const second = await send('POST', PRODUCTS, body, { 'idempotency-key': key }, pa(), newKey.key);
    assert.equal(second.status, 201);
    assert.notEqual(second.body.data.id, first.body.data.id, 'not a replay of the answer of another key');
    assert.equal(await db.products.countDocuments({ 'name.it': 'Una sola volta' }), 2);
    for (const [method, path] of [['GET', PRODUCTS], ['POST', PRODUCTS], ['DELETE', `${CATEGORIES}/${hex(new ObjectId())}`]] as const) {
      const reply = await world.asStore(`fc_pk_${'a'.repeat(43)}`, method, path, method === 'POST' ? body : undefined, operator(pa()));
      assert.equal(reply.status, 401, `${method} ${path}`);
    }
    const upper = await world.asStore(store.key, 'POST', PRODUCTS, { ...body, name: { it: 'Maiuscolo' } }, { 'x-operator-id': hex(pa()).toUpperCase(), 'idempotency-key': randomUUID() });
    assert.equal(upper.status, 201, JSON.stringify(upper.body));
  });

  it('limits the writes of the catalog per store key apart from the reads, with 429, Retry-After and the event of the first excess', async () => {
    const small = await openTestDatabases();
    const office = await startStoreWorld(small, { env: { RATE_LIMIT_STORE_CATALOG_WRITE_PER_STORE: '2' }, rateLimiter: memoryRateLimiter() });
    try {
      const group = office.group(0);
      const key = await office.activate(group.ownPlaceId);
      const write = () => office.asStore(key.key, 'POST', PRODUCTS, { name: { it: 'x' }, places: [{ placeId: hex(group.ownPlaceId) }] }, { ...operator(group.pa), 'idempotency-key': randomUUID() });
      const statuses = [(await write()).status, (await write()).status];
      const limited = await write();
      assert.deepEqual([...statuses, limited.status, limited.body.error.code], [201, 201, 429, 'RATE_LIMITED']);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      assert.equal((await write()).status, 429);
      assert.equal((await office.asStore(key.key, 'GET', PRODUCTS)).status, 200, 'the reads are not counted');
      assert.equal(office.office.activity.entries.filter((entry) => entry.action === 'rateLimit.exceeded' && entry.metadata?.['bucket'] === 'store-catalog-write:store' && entry.actor.kind === 'store').length, 1);
      // A refused operator is counted too, and the user routes of the backoffice never use this bucket.
      assert.equal((await office.asStore(key.key, 'POST', PRODUCTS, { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 429);
    } finally {
      await office.office.close();
      await small.cleanup();
    }
  });
});

/** Puts the second place back after a test that trashed it. */
function afterEachRestore(): void {
  beforeEach(async () => {
    await copies().updateMany({}, { $set: { trash: false } });
    await originals().updateMany({}, { $set: { trash: false } });
  });
}
