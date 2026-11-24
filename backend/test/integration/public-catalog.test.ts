import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createBackofficeModules, createPublicApiModules } from '../../src/composition.ts';
import { ACTION_CATALOG } from '../../src/shared/activity-log/catalog.ts';
import { netOf } from '../../src/modules/products/products.pricing.ts';
import { PRODUCT_BODY_LIMIT } from '../../src/modules/products/products.schemas.ts';
import { sha256, startKeysWorld } from '../helpers/api-keys.ts';
import type { KeysWorld, MadeKey } from '../helpers/api-keys.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger, testConfig } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import { throughRealLog } from '../helpers/real-log.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { catalogCollections, legacyAttributeGroup, legacyBrand, legacyCategory, legacyDepartment } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { legacyFullProduct, legacyPrice, placeEntry } from '../helpers/products.ts';

let ctx: TestDatabases;
let world: KeysWorld;
let db: CatalogCollections;
let db1: CatalogCollections;
let admin: MadeKey;
let placeKey: MadeKey;
let companyKey: MadeKey;
let reader: MadeKey;
let writer: MadeKey;
const limiter = memoryRateLimiter();
const hex = (id: ObjectId) => id.toHexString();
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const gid = () => world.group(0).groupId;
const groups = () => ctx.databases.common().collection('groups');
const copies = () => ctx.databases.common().collection('places');
const originals = () => ctx.databases.group(gid(), 'cluster0').collection('places');
const ALL = { cash: true, warehouse: true, customersApp: true, tobaccosGamesMonopoly: true, productsVariants: true, services: true, scales: true, ordering: true, rooms: true, media: true };
const NONE = { cash: false, warehouse: false, customersApp: false, tobaccosGamesMonopoly: false, productsVariants: false, services: false, scales: false, ordering: false, rooms: false, media: false };
const settings = (flags: Record<string, boolean>) => Object.fromEntries(Object.entries(flags).map(([key, flag]) => [`settings.${key}`, flag]));
const call = (key: MadeKey | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => world.asKey(key?.secret, path, headers, method, body);
const get = (path: string, key: MadeKey = admin) => call(key, 'GET', path);
const send = (key: MadeKey, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(key, method, path, body, headers);
const create = (body: Document = {}, key: MadeKey = admin, headers: Record<string, string> = {}) => send(key, 'POST', '/products', { name: { it: 'Acqua' }, ...body }, { 'idempotency-key': randomUUID(), ...headers });
const tagOf = (reply: { headers: Headers }) => reply.headers.get('etag')!;
const ids = (reply: { body: { data: Array<{ id: string }> } }) => reply.body.data.map((item) => item.id);
const entries = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const at = (days: number) => new Date(Date.UTC(2026, 0, days));
const priceListId = async () => Object.keys((await groups().findOne({ _id: gid() }))!['priceLists'] as Document)[0]!;
const taxOf = async () => ((await groups().findOne({ _id: gid() }))!['taxes'] as Document[])[0]!;

const seed = async (overrides: Document = {}, collection = db.products): Promise<ObjectId> => {
  const document = legacyFullProduct(overrides);
  await collection.insertOne(document);
  return document['_id'] as ObjectId;
};
const seedCategory = async (overrides: Document = {}): Promise<ObjectId> => {
  const document = legacyCategory(overrides);
  await db.categories.insertOne(document);
  return document['_id'] as ObjectId;
};

/** Pages of a list read to the end, following the cursor, two entries a page. */
async function pagesOf(path: string, key: MadeKey = admin): Promise<Array<{ data: Array<{ id: string }>; page: { limit: number; next: string | null } }>> {
  const pages = [];
  let next: string | null = null;
  do {
    const reply = await get(`${path}${path.includes('?') ? '&' : '?'}${next === null ? '' : `cursor=${next}&`}limit=2`, key);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    pages.push(reply.body);
    next = reply.body.page.next;
  } while (next !== null);
  return pages;
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startKeysWorld(ctx, { rateLimiter: limiter, env: { RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY: '1000000', PUBLIC_API_DEFAULT_RATE_LIMIT_PER_MINUTE: '6000', PUBLIC_API_DEFAULT_GROUP_RATE_LIMIT_PER_MINUTE: '6000', PUBLIC_API_DEFAULT_DAILY_QUOTA: '100000', PUBLIC_API_DEFAULT_GROUP_DAILY_QUOTA: '100000' } });
  db = catalogCollections(ctx, world);
  db1 = catalogCollections(ctx, world, 1);
  await groups().updateOne({ _id: gid() }, { $set: settings(ALL) });
  await groups().updateOne({ _id: world.group(1).groupId }, { $set: settings(NONE) });
  const companyOfOwn = (await copies().findOne({ _id: own() }))!['companyId'] as ObjectId;
  admin = await world.makeKey(0, { name: 'Admin', permissions: ['catalog:read', 'catalog:write'] });
  placeKey = await world.makeKey(0, { name: 'Place', permissions: ['catalog:read', 'catalog:write'], restrictions: { placeIds: [hex(own())] } });
  companyKey = await world.makeKey(0, { name: 'Company', permissions: ['catalog:read', 'catalog:write'], restrictions: { companyIds: [hex(companyOfOwn)] } });
  reader = await world.makeKey(0, { name: 'Reader', permissions: ['catalog:read'] });
  writer = await world.makeKey(0, { name: 'Writer', permissions: ['catalog:write'] });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  await Promise.all([db.products.deleteMany({}), db.categories.deleteMany({}), db.departments.deleteMany({}), db.brands.deleteMany({}), db.attributes.deleteMany({}), db1.products.deleteMany({})]);
  await copies().updateMany({}, { $set: { trash: false, status: true } });
  await originals().updateMany({}, { $set: { trash: false } });
  await groups().updateOne({ _id: gid() }, { $set: { ...settings(ALL), 'settings.languages': ['it'], publicApi: { enabled: true } } });
  world.office.activity.entries.length = 0;
});

describe('the catalog of the public API: who may call it', () => {
  it('answers 401 to every wrong credential, whatever the route, and 403 to a key without the permission', async () => {
    const storeKey = await world.activate(own());
    const tokens = await world.office.tokens('user-001');
    const paths = ['/products', '/categories', '/brands', '/attribute-groups', '/departments', '/stock'];
    for (const path of paths) {
      assert.equal((await call(undefined, 'GET', path)).status, 401, path);
      assert.equal((await world.asKey(`fc_pk_${'A'.repeat(43)}`, path)).status, 401, path); // gitleaks:allow (fake test value)
      assert.equal((await world.asKey(storeKey.key, path)).status, 401, `${path} with a store key`);
      assert.equal((await world.asKey(tokens.accessToken, path)).status, 401, `${path} with a user token`);
      const bearer = await fetch(`${world.office.app.baseUrl}/public/v1${path}`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
      assert.equal(bearer.status, 401, `${path} with a Bearer token`);
      assert.equal((await get(path, writer)).status, 403, `${path} needs catalog:read`);
    }
    const noCatalog = await world.makeKey(0, { name: 'Places', permissions: ['places:read'] });
    assert.equal((await get('/products', noCatalog)).status, 403);
    assert.equal((await send(noCatalog, 'POST', '/products', { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 403);
    for (const [method, path, body] of [['POST', '/products', { name: { it: 'x' } }], ['PATCH', `/products/${hex(new ObjectId())}`, { code: 'x' }], ['POST', `/products/${hex(new ObjectId())}/trash`, undefined], ['POST', `/products/${hex(new ObjectId())}/restore`, undefined], ['POST', '/categories', { name: { it: 'x' } }], ['PATCH', `/categories/${hex(new ObjectId())}`, { position: 1 }], ['DELETE', `/categories/${hex(new ObjectId())}`, undefined]] as const) {
      const refused = await send(reader, method, path, body, { 'idempotency-key': randomUUID(), 'if-match': `"${'A'.repeat(43)}"` });
      assert.deepEqual([refused.status, refused.body.error.code], [403, 'FORBIDDEN'], `${method} ${path} needs catalog:write`);
    }
    assert.equal(await db.products.countDocuments({}), 0);
    assert.equal(await db.categories.countDocuments({}), 0);
  });

  it('is not reachable with the key on /v1, and no route of /public/v1 takes anything but a public key', async () => {
    const reply = await fetch(`${world.office.app.baseUrl}/v1/groups/${hex(gid())}/products`, { headers: { 'x-api-key': admin.secret } });
    assert.equal(reply.status, 401);
    const modules = createBackofficeModules({ config: testConfig(), databases: ctx.databases, activityLog: memoryActivityLog(), logger: memoryLogger().logger, rateLimiter: memoryRateLimiter() });
    assert.ok(modules.routes.every((route) => route.auth.kind !== 'apiKey'));
    assert.equal(modules.catalog.products !== undefined, true);
  });

  it('is off when the public API of the group is switched off, and for a key whose restrictions match no place', async () => {
    assert.equal((await get('/products')).status, 200);
    await groups().updateOne({ _id: gid() }, { $set: { publicApi: { enabled: false } } });
    for (const path of ['/products', '/categories', '/stock', '/brands']) {
      assert.equal((await get(path)).status, 401, path);
    }
    assert.equal((await send(admin, 'POST', '/products', { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 401);
    await groups().updateOne({ _id: gid() }, { $set: { publicApi: { enabled: true } } });
    // A key limited to places that are all in the trash reaches nothing of the catalog.
    await copies().updateOne({ _id: own() }, { $set: { trash: true } });
    assert.equal((await get('/products', placeKey)).status, 404);
    assert.equal((await send(placeKey, 'POST', '/products', { name: { it: 'x' }, places: [{ placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() })).status, 404);
    assert.equal((await get('/products')).status, 200, 'the keys without that restriction are not affected');
  });

  it('keeps the groups apart: another group is never reached and its entries are 404', async () => {
    const foreign = await seed({ name: { it: 'Altro gruppo' } }, db1.products);
    const category = legacyCategory({ name: { it: 'Altra categoria' } });
    await db1.categories.insertOne(category);
    assert.equal((await get(`/products/${hex(foreign)}`)).status, 404);
    assert.equal((await get(`/categories/${hex(category['_id'] as ObjectId)}`)).status, 404);
    assert.deepEqual(ids(await get('/products')), []);
    const tag = `"${'A'.repeat(43)}"`;
    assert.equal((await send(admin, 'PATCH', `/products/${hex(foreign)}`, { code: 'x' }, { 'if-match': tag })).status, 404);
    assert.equal((await send(admin, 'POST', `/products/${hex(foreign)}/trash`, undefined, { 'if-match': tag })).status, 404);
    assert.equal((await send(admin, 'DELETE', `/categories/${hex(category['_id'] as ObjectId)}`)).status, 404);
    assert.equal(await db1.products.countDocuments({ trash: true }), 0);
  });
});

describe('the catalog of the public API: reading products', () => {
  it('lists the active products of the perimeter of the key, whole, and never what is internal', async () => {
    const supplier = new ObjectId();
    const everyone = await seed({ name: { it: 'Per tutti' }, simpleCost: new Double(3), suppliers: [{ id: supplier, code: 'S-1', minQt: 1 }], lastAveragePrice: { lastSupplierId: supplier, total: { lastPrice: 2.5 }, suppliers: {} }, printStations: { [`__${hex(own())}`]: ['st-1'] }, bundleProducts: [{ _id: new ObjectId(), quantity: 1, waste: 0 }], updateDate: at(1) });
    const mine = await seed({ name: { it: 'Mio' }, placesAvailability: [placeEntry(own(), { favorite: true, position: 2, productionCenterId: 'pc-1' })], updateDate: at(2) });
    const shared = await seed({ name: { it: 'Condiviso' }, placesAvailability: [placeEntry(own()), placeEntry(other(), { position: 3 })], updateDate: at(3) });
    const elsewhere = await seed({ name: { it: 'Altrove' }, placesAvailability: [placeEntry(other())], updateDate: at(4) });
    const trashed = await seed({ name: { it: 'Cestinato' }, trash: true, updateDate: at(5) });
    const disabled = await seed({ name: { it: 'Spento' }, status: false, updateDate: at(6) });
    const listed = await get('/products');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(new Set(ids(listed)), new Set([hex(everyone), hex(mine), hex(shared), hex(elsewhere)]), 'every place for a key without restrictions, none of the disabled or the trashed');
    assert.deepEqual(listed.body.page, { limit: 25, next: null });
    const text = JSON.stringify(listed.body);
    for (const forbidden of ['costs', 'suppliers', 'simpleCost', 'lastAveragePrice', 'printStations', 'productionCenterId', 'S-1', 'bundleProducts', 'components', 'image', 'gallery', 'internalFileName', 'integrations', 'colors', 'dining', 'toCheck', 'favoriteHandheld', 'placeEditable', 'stock', 'warnings']) {
      assert.ok(!text.includes(`"${forbidden}"`), `${forbidden} is not given to an integration`);
    }
    const first = listed.body.data.find((item: { id: string }) => item.id === hex(mine));
    assert.deepEqual(Object.keys(first).sort(), ['attributeIds', 'availability', 'barcodes', 'brandId', 'categoryIds', 'code', 'createdAt', 'description', 'duration', 'editable', 'family', 'favorite', 'featured', 'generic', 'id', 'isModifier', 'loadUnit', 'maxConcurrent', 'modifierCategoryIds', 'modifierChoices', 'modifierIds', 'modularPriceRule', 'menu', 'name', 'noDiscount', 'places', 'plu', 'position', 'prices', 'requiredModifierIds', 'excludedModifierIds', 'scaleType', 'shipping', 'shortDescription', 'shortName', 'status', 'trashedAt', 'type', 'unloadUnit', 'conversionRatio', 'updatedAt', 'validFrom', 'validTo'].sort());
    assert.deepEqual(first.places, [{ placeId: hex(own()), favorite: true, position: 2 }]);
    assert.equal(first.status, 'active');
    assert.ok(!ids(listed).includes(hex(trashed)) && !ids(listed).includes(hex(disabled)));
    // A key of one place reaches the products of its place and the ones for every place, and nothing of another.
    const restricted = await get('/products', placeKey);
    assert.deepEqual(new Set(ids(restricted)), new Set([hex(everyone), hex(mine), hex(shared)]));
    assert.deepEqual(restricted.body.data.find((item: { id: string }) => item.id === hex(shared)).places.map((place: { placeId: string }) => place.placeId), [hex(own())], 'only its own place of the availability');
    assert.equal(restricted.body.data.find((item: { id: string }) => item.id === hex(shared)).editable, false);
    assert.deepEqual(new Set(ids(await get('/products', companyKey))), new Set(ids(restricted)), 'the company of the place has the places of the company');
    assert.equal((await get(`/products/${hex(elsewhere)}`, placeKey)).status, 404);
    assert.equal((await get(`/products/${hex(elsewhere)}`, companyKey)).status, 404);
  });

  it('is asked for a family, the e-commerce and a page, and for the changes since an instant, which include the disabled and the trashed ones, oldest first', async () => {
    const old = await seed({ name: { it: 'Vecchio' }, updateDate: at(1) });
    const service = await seed({ name: { it: 'Servizio' }, type: 'service', updateDate: at(2), availability: { pos: true, warehouse: false, scales: false, ecommerce: true } });
    const modifier = await seed({ name: { it: 'Variante' }, variant: { status: true, type: 'pm', pricePercentagePlus: 1, pricePercentageMinus: null, description: { it: 'Extra' } }, updateDate: at(3) });
    const trashed = await seed({ name: { it: 'Cestinato' }, trash: true, updateDate: at(5) });
    const disabled = await seed({ name: { it: 'Spento' }, status: false, updateDate: at(4) });
    const tgm = await seed({ name: { it: 'Tabacco' }, type: 'tobaccos', updateDate: at(7) });
    assert.deepEqual(ids(await get('/products?family=services')), [hex(service)]);
    assert.deepEqual(ids(await get('/products?family=modifiers')), [hex(modifier)]);
    assert.deepEqual(ids(await get('/products?family=tgm')), [hex(tgm)]);
    assert.deepEqual(ids(await get('/products?ecommerce=true')), [hex(service)]);
    assert.equal((await get('/products?ecommerce=false')).status, 422);
    const since = await get('/products?updatedSince=2026-01-03T00:00:00.000Z');
    assert.deepEqual(ids(since), [hex(modifier), hex(disabled), hex(trashed), hex(tgm)], 'oldest first, the disabled and the trashed ones included');
    assert.deepEqual(since.body.data.map((item: { status: string }) => item.status), ['active', 'disabled', 'trashed', 'active']);
    assert.ok(since.body.data[2].trashedAt === null || typeof since.body.data[2].trashedAt === 'string');
    assert.deepEqual(ids(await get('/products?updatedSince=2026-01-04&family=products')), [hex(disabled), hex(trashed)]);
    const modifierItem = since.body.data[0];
    assert.deepEqual(modifierItem.modifier, { type: 'addRemove', pricePercentagePlus: 1, pricePercentageMinus: null, description: { it: 'Extra' } });
    assert.ok(!('menu' in modifierItem) && !('requiredModifierIds' in modifierItem));
    const pages = await pagesOf('/products');
    assert.deepEqual(new Set(pages.flatMap((page) => page.data.map((item) => item.id))), new Set([hex(old), hex(service), hex(modifier), hex(tgm)]), 'the whole active catalog, once');
    for (const query of ['?limit=0', '?limit=51', '?family=none', '?updatedSince=ieri', '?q=a', '?sort=name', '?trashed=true', '?placeId=x', '?cursor=zz']) {
      assert.equal((await get(`/products${query}`)).status, 422, query);
    }
    assert.equal((await get(`/stock?cursor=zz`)).status, 422);
  });

  it('shows the product with its version, and 404 for one of another place, in the trash it is shown as such', async () => {
    const brand = new ObjectId();
    const category = await seedCategory({});
    const id = await seed({ name: { it: 'Dettaglio' }, brandId: brand, categories: [category], attributes: ['attr-1'], placesAvailability: [placeEntry(own())] });
    const read = await get(`/products/${hex(id)}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(tagOf(read));
    assert.equal(read.body.data.brandId, hex(brand));
    assert.deepEqual(read.body.data.categoryIds, [hex(category)]);
    assert.deepEqual(read.body.data.attributeIds, ['attr-1']);
    assert.deepEqual(read.body.data.warnings ?? [], []);
    assert.equal((await get(`/products/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get('/products/zz')).status, 422);
    assert.equal((await get(`/products/${hex(id)}?x=1`)).status, 422);
    const gone = await seed({ trash: true });
    assert.equal((await get(`/products/${hex(gone)}`)).body.data.status, 'trashed');
    // A product that has only a barcode: the code is a warning only when another product uses it.
    const twin = await seed({ code: 'DUP', placesAvailability: [placeEntry(own())] });
    await seed({ code: 'DUP', placesAvailability: [placeEntry(other())] });
    const warned = await get(`/products/${hex(twin)}`);
    assert.deepEqual(warned.body.data.warnings, [{ field: 'code', issue: 'duplicate' }, { field: 'barcodes.0', issue: 'duplicate' }], 'the field and nothing else: never the other products');
  });

  it('shows the prices in cents with tax included, with the rate and the conditions of the rule', async () => {
    const taxId = (await taxOf())['id'] as string;
    const list = await priceListId();
    const rule = legacyPrice({ id: 'p-1', listId: list, price: new Double(10), taxed: new Double(12.2), tax: 22, taxData: { id: taxId, value: 22, department: 1, description: 'Ordinaria', natura: null }, discount: 5, startDate: at(1), endDate: at(9), startTimeDaily: '08:00', endTimeDaily: '12:30', weekDays: [1, 2], fromQt: 3, maxQtSell: 10 });
    const odd = legacyPrice({ id: 'p-2', listId: list, price: null, taxed: new Double(1.225), tax: 'x', taxData: null });
    const id = await seed({ prices: [rule, odd] });
    const read = await get(`/products/${hex(id)}`);
    assert.deepEqual(read.body.data.prices[0], { id: 'p-1', priceListId: list, currency: 'EUR', taxId, taxRatePercent: 22, grossCents: 1220, discountPercent: 5, validFrom: at(1).toISOString(), validTo: at(9).toISOString(), dailyFrom: '08:00', dailyTo: '12:30', weekDays: [1, 2], fromQuantity: 3, maxSaleQuantity: 10 });
    assert.deepEqual([read.body.data.prices[1].grossCents, read.body.data.prices[1].taxRatePercent, read.body.data.prices[1].taxId], [123, null, null], 'a gross amount that is not a whole number of cents is rounded to the cent');
    const missing = await seed({ prices: [legacyPrice({ id: 'p-3', taxed: null })] });
    assert.equal((await get(`/products/${hex(missing)}`)).body.data.prices[0].grossCents, null);
  });

  it('shows the references to other products only when the key reaches them', async () => {
    const category = await seedCategory({});
    const modifierMine = await seed({ name: { it: 'Mia variante' }, variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, placesAvailability: [placeEntry(own())] });
    const modifierElsewhere = await seed({ name: { it: 'Altra variante' }, variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, placesAvailability: [placeEntry(other())] });
    const choiceMine = await seed({ name: { it: 'Scelta' }, placesAvailability: [placeEntry(own())] });
    const choiceElsewhere = await seed({ name: { it: 'Altra scelta' }, placesAvailability: [placeEntry(other())] });
    const id = await seed({
      name: { it: 'Menu' },
      placesAvailability: [placeEntry(own())],
      variants: [modifierMine, modifierElsewhere],
      variantsRequired: [modifierMine],
      variantsExcluded: [modifierElsewhere],
      selectableBundleProducts: [{ categoryId: category, quantity: 1, exit: 0, products: [{ _id: choiceMine }, { _id: choiceElsewhere }] }],
      selectableVariantsBundleProducts: [{ categoryId: category, freeQt: 1, priceType: 'h', products: [{ _id: modifierMine }, { _id: modifierElsewhere }] }],
    });
    const seen = async (key: MadeKey) => (await get(`/products/${hex(id)}`, key)).body.data;
    const whole = await seen(admin);
    assert.deepEqual([whole.modifierIds.length, whole.menu[0].productIds.length, whole.modifierChoices[0].productIds.length], [2, 2, 2]);
    const narrow = await seen(placeKey);
    assert.deepEqual(narrow.modifierIds, [hex(modifierMine)]);
    assert.deepEqual(narrow.requiredModifierIds, [hex(modifierMine)]);
    assert.deepEqual(narrow.excludedModifierIds, []);
    assert.deepEqual(narrow.menu, [{ categoryId: hex(category), quantity: 1, productIds: [hex(choiceMine)] }]);
    assert.deepEqual(narrow.modifierChoices, [{ categoryId: hex(category), freeQuantity: 1, priceRule: 'highest', productIds: [hex(modifierMine)] }]);
    assert.ok(!JSON.stringify(narrow).includes(hex(modifierElsewhere)) && !JSON.stringify(narrow).includes(hex(choiceElsewhere)));
  });

  it('leaves out the fields of the functions the group does not have', async () => {
    await groups().updateOne({ _id: gid() }, { $set: settings(NONE) });
    const id = await seed({ name: { it: 'Semplice' }, quantity: { [`__${hex(own())}`]: { [`__${'a'.repeat(24)}`]: { value: 4 } } } });
    const read = (await get(`/products/${hex(id)}`)).body.data;
    for (const field of ['plu', 'duration', 'maxConcurrent', 'availability', 'featured', 'modifierIds', 'requiredModifierIds', 'scaleType', 'loadUnit', 'unloadUnit', 'conversionRatio', 'modifierChoices']) {
      assert.ok(!(field in read), `${field} needs a function the group does not have`);
    }
    assert.deepEqual(read.menu, []);
    assert.equal((await get(`/products/${hex(id)}/stock`)).body.error.code, 'FEATURE_DISABLED');
    assert.equal((await get('/stock')).body.error.code, 'FEATURE_DISABLED');
    assert.equal((await get('/departments')).body.error.code, 'FEATURE_DISABLED');
    assert.equal((await get(`/departments/${hex(new ObjectId())}`)).body.error.code, 'FEATURE_DISABLED');
  });
});

describe('the catalog of the public API: the stock', () => {
  it('gives the quantities by place and storage, read only, for the places of the key', async () => {
    const storage = 'a'.repeat(24);
    const moving = await seed({ name: { it: 'Con giacenza' }, code: 'W-1', availability: { pos: true, warehouse: true, scales: false, ecommerce: false }, quantity: { [`__${hex(own())}`]: { [`__${storage}`]: { value: 4, min: 1, max: 9, location: 'A1' } }, [`__${hex(other())}`]: { [`__${storage}`]: { value: 7 } } } });
    await seed({ name: { it: 'Senza magazzino' } });
    await seed({ name: { it: 'Cestinato' }, trash: true, availability: { pos: true, warehouse: true, scales: false, ecommerce: false } });
    const one = await get(`/products/${hex(moving)}/stock`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(one.body.data.productId, hex(moving));
    assert.deepEqual(new Set(one.body.data.stock.map((row: { placeId: string }) => row.placeId)), new Set([hex(own()), hex(other())]));
    assert.deepEqual(one.body.data.stock.find((row: { placeId: string }) => row.placeId === hex(own())), { placeId: hex(own()), storageId: storage, quantity: 4, min: 1, max: 9, location: 'A1' });
    const mine = await get(`/products/${hex(moving)}/stock`, placeKey);
    assert.deepEqual(mine.body.data.stock.map((row: { placeId: string }) => row.placeId), [hex(own())]);
    const list = await get('/stock');
    assert.deepEqual(list.body.data.map((item: { productId: string }) => item.productId), [hex(moving)], 'only the products that move the warehouse and are not in the trash');
    assert.deepEqual(list.body.data[0].code, 'W-1');
    assert.deepEqual((await get('/stock', placeKey)).body.data[0].stock.map((row: { placeId: string }) => row.placeId), [hex(own())]);
    // The stock has no write: neither the quantity nor the route.
    assert.equal((await send(admin, 'PATCH', `/products/${hex(moving)}`, { stock: {} }, { 'if-match': tagOf(await get(`/products/${hex(moving)}`)) })).status, 422);
    for (const [method, path] of [['PUT', `/products/${hex(moving)}/stock`], ['POST', '/stock'], ['PATCH', `/products/${hex(moving)}/stock`]] as const) {
      assert.equal((await send(admin, method, path, {})).status, 405, `${method} ${path}`);
    }
  });
});

describe('the catalog of the public API: brands, groups of attributes and departments', () => {
  it('lists the active ones and, since an instant, the disabled ones too, one by one, in the perimeter of the key', async () => {
    const everyone = legacyBrand({ name: { it: 'Per tutti' }, updateDate: at(1) });
    const mine = legacyBrand({ name: { it: 'Mia' }, placesAvailability: [own()], updateDate: at(2), medias: { images: { main: { _id: new ObjectId() } } } });
    const elsewhere = legacyBrand({ name: { it: 'Altrove' }, placesAvailability: [other()], updateDate: at(3) });
    const off = legacyBrand({ name: { it: 'Spenta' }, status: false, updateDate: at(4) });
    await db.brands.insertMany([everyone, mine, elsewhere, off]);
    const all = await get('/brands');
    assert.deepEqual(ids(all), [hex(everyone['_id']), hex(mine['_id']), hex(elsewhere['_id'])]);
    assert.deepEqual(Object.keys(all.body.data[1]).sort(), ['createdAt', 'description', 'id', 'name', 'placeIds', 'status', 'updatedAt']);
    assert.deepEqual(ids(await get('/brands', placeKey)), [hex(everyone['_id']), hex(mine['_id'])]);
    const since = await get('/brands?updatedSince=2026-01-03');
    assert.deepEqual(since.body.data.map((item: { status: string }) => item.status), ['active', 'disabled']);
    assert.equal((await pagesOf('/brands')).flatMap((page) => page.data).length, 3);
    const one = await get(`/brands/${hex(mine['_id'])}`);
    assert.equal(one.status, 200);
    assert.ok(tagOf(one));
    assert.equal((await get(`/brands/${hex(elsewhere['_id'])}`, placeKey)).status, 404);
    assert.equal((await get(`/brands/${hex(new ObjectId())}`)).status, 404);
    assert.equal((await get('/brands?q=a')).status, 422);
    // Read only.
    for (const [method, path] of [['POST', '/brands'], ['PATCH', `/brands/${hex(mine['_id'])}`], ['DELETE', `/brands/${hex(mine['_id'])}`], ['PUT', '/brands'], ['POST', '/attribute-groups'], ['DELETE', '/departments'], ['PATCH', `/attribute-groups/${hex(new ObjectId())}`], ['POST', '/departments']] as const) {
      assert.equal((await send(admin, method, path, { name: { it: 'x' } })).status, 405, `${method} ${path}`);
    }
    assert.equal(await db.brands.countDocuments({}), 4);
  });

  it('gives the groups of attributes and the departments in their public shape', async () => {
    const colors = legacyAttributeGroup({ name: { it: 'Colori' }, updateDate: at(1) });
    const sizes = legacyAttributeGroup({ name: { it: 'Taglie' }, updateDate: at(3) });
    await db.attributes.insertMany([sizes, colors]);
    const groupsReply = await get('/attribute-groups');
    assert.deepEqual(ids(groupsReply), [hex(colors['_id']), hex(sizes['_id'])]);
    assert.deepEqual(groupsReply.body.data[0], { id: hex(colors['_id']), name: { it: 'Colori' }, attributes: [{ id: 'attr-1', name: { it: 'Rosso' } }, { id: 'attr-2', name: { it: 'Blu' } }], createdAt: null, updatedAt: groupsReply.body.data[0].updatedAt });
    assert.deepEqual(ids(await get('/attribute-groups?updatedSince=2026-01-02')), [hex(sizes['_id'])]);
    assert.equal((await pagesOf('/attribute-groups')).flatMap((page) => page.data).length, 2);
    assert.equal((await get(`/attribute-groups/${hex(colors['_id'])}`)).status, 200);
    assert.equal((await get(`/attribute-groups/${hex(new ObjectId())}`)).status, 404);

    const taxId = (await taxOf())['id'] as string;
    const first = legacyDepartment({ code: 7, name: { it: 'Alimentari' }, tax: { id: taxId, value: 22, department: 1, description: 'Ordinaria', natura: null }, updateDate: at(1), secondaryFiscalPrinter: true });
    const off = legacyDepartment({ code: 8, name: { it: 'Spento' }, status: false, updateDate: at(4) });
    const elsewhere = legacyDepartment({ code: 9, name: { it: 'Altrove' }, placesAvailability: [other()], updateDate: at(2) });
    await db.departments.insertMany([first, off, elsewhere]);
    const departments = await get('/departments');
    assert.deepEqual(ids(departments), [hex(first['_id']), hex(elsewhere['_id'])]);
    assert.deepEqual(departments.body.data[0], { id: hex(first['_id']), code: 7, name: { it: 'Alimentari' }, description: { it: '' }, status: 'active', taxId, taxRatePercent: 22, noDiscount: false, placeIds: [], createdAt: departments.body.data[0].createdAt, updatedAt: at(1).toISOString() });
    assert.deepEqual(ids(await get('/departments', placeKey)), [hex(first['_id'])]);
    assert.deepEqual((await get('/departments?updatedSince=2026-01-03')).body.data.map((item: { status: string }) => item.status), ['disabled']);
    assert.equal((await pagesOf('/departments')).flatMap((page) => page.data).length, 2);
    assert.equal((await get(`/departments/${hex(first['_id'])}`)).status, 200);
    assert.equal((await get(`/departments/${hex(elsewhere['_id'])}`, placeKey)).status, 404);
  });
});

describe('the catalog of the public API: the activity log and the limits', () => {
  it('knows the metadata the entries of the writes carry', () => {
    for (const action of ['product.created', 'product.updated', 'product.trashed', 'product.restored', 'productCategory.created', 'productCategory.updated', 'productCategory.deleted']) {
      assert.ok(ACTION_CATALOG.get(action)!.metadataKeys.includes('keyHint'), action);
    }
    for (const action of ['productBrand.created', 'productBrand.updated', 'productBrand.deleted']) {
      assert.ok(ACTION_CATALOG.get(action)!.metadataKeys.includes('operatorId'), action);
      assert.ok(!ACTION_CATALOG.get(action)!.metadataKeys.includes('keyHint'), action);
    }
    assert.ok(!ACTION_CATALOG.get('product.duplicated')!.metadataKeys.includes('keyHint'));
  });

  it('is limited per key on the writes, with 429 before the body is read, and the reads are not', async () => {
    const small = await openTestDatabases();
    const keys = await startKeysWorld(small, { env: { RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY: '2' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await keys.makeKey(0, { permissions: ['catalog:read', 'catalog:write'] });
      const statuses: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        statuses.push((await keys.asKey(key.secret, '/categories', { 'idempotency-key': randomUUID() }, 'POST', { name: { it: `C${String(index)}` } })).status);
      }
      assert.deepEqual(statuses, [201, 201, 429]);
      const refused = await keys.asKey(key.secret, '/categories', { 'idempotency-key': randomUUID(), 'content-type': 'text/plain' }, 'POST');
      assert.equal(refused.status, 429, 'the limit runs before the body is read');
      assert.ok(refused.headers.get('retry-after'));
      for (let index = 0; index < 4; index += 1) {
        assert.equal((await keys.asKey(key.secret, '/categories')).status, 200);
      }
      assert.ok(keys.office.activity.entries.some((entry) => entry.action === 'rateLimit.exceeded' && entry.actor.kind === 'apiKey' && entry.metadata?.['bucket'] === 'public-catalog-write:key'));
    } finally {
      await keys.office.close();
      await small.cleanup();
    }
  });

  it('counts the writes in the daily quota and in the usage of the key, and answers 429 once the quota is used up', async () => {
    const key = await world.makeKey(0, { name: 'Quota', permissions: ['catalog:read', 'catalog:write'], dailyQuota: 4 });
    assert.equal((await send(key, 'POST', '/categories', { name: { it: 'Uno' } }, { 'idempotency-key': randomUUID() })).status, 201);
    assert.equal((await send(key, 'POST', '/products', { name: { it: 'Due' } }, { 'idempotency-key': randomUUID() })).status, 201);
    assert.equal((await send(key, 'POST', '/products', { name: { it: 'Due' }, unknown: 1 }, { 'idempotency-key': randomUUID() })).status, 422);
    assert.equal((await get('/categories', key)).status, 200);
    const exceeded = await send(key, 'POST', '/products', { name: { it: 'Tre' } }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([exceeded.status, exceeded.body.error.code], [429, 'QUOTA_EXCEEDED']);
    assert.equal(await db.products.countDocuments({}), 1);
    await world.office.meter.flush();
    const rows = await ctx.databases.common().collection('apiUsage').find({ keyId: new ObjectId(key.id) }, { projection: { _id: 0, route: 1, calls: 1, errors4xx: 1, rateLimited: 1 } }).sort({ route: 1 }).toArray();
    assert.deepEqual(rows, [
      { route: 'GET /public/v1/categories', calls: 1, errors4xx: 0, rateLimited: 0 },
      { route: 'POST /public/v1/categories', calls: 1, errors4xx: 0, rateLimited: 0 },
      { route: 'POST /public/v1/products', calls: 3, errors4xx: 1, rateLimited: 1 },
    ]);
  });
});

describe('the catalog of the public API: writing products', () => {
  it('creates a product with prices in cents, replays a retry, answers 201 with Location and ETag and keeps what was sent', async () => {
    const list = await priceListId();
    const tax = await taxOf();
    const mark = world.office.activity.entries.length;
    const key = randomUUID();
    const body = { name: { it: 'Birra' }, code: 'BR-1', status: 'disabled', favorite: true, barcodes: [{ value: '8000000000999', saleQuantity: 1 }], prices: [{ priceListId: list, currency: 'EUR', taxId: tax['id'], grossCents: 1999, discountPercent: 10, validFrom: '2026-01-01T00:00:00.000Z', dailyFrom: '08:00', dailyTo: '12:00', weekDays: [1, 2], fromQuantity: 2, maxSaleQuantity: 6 }], places: [{ placeId: hex(own()), favorite: true, position: 4 }] };
    const first = await send(admin, 'POST', '/products', body, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const id = first.body.data.id as string;
    assert.equal(first.headers.get('location'), `/public/v1/products/${id}`);
    assert.ok(tagOf(first));
    assert.equal(first.body.data.status, 'disabled');
    assert.equal(first.body.data.prices[0].grossCents, 1999);
    assert.equal(first.body.data.prices[0].taxRatePercent, tax['value']);
    assert.deepEqual(first.body.data.places, [{ placeId: hex(own()), favorite: true, position: 4 }]);
    const replay = await send(admin, 'POST', '/products', body, { 'idempotency-key': key });
    assert.deepEqual([replay.status, replay.body], [201, first.body]);
    assert.equal(await db.products.countDocuments({}), 1);
    const stored = (await db.products.findOne({ _id: new ObjectId(id) }))!;
    assert.equal(stored['status'], false);
    assert.equal(stored['prices'][0]['taxed'], 19.99);
    assert.equal(stored['prices'][0]['price'], netOf(19.99, tax['value'] as number));
    assert.equal(stored['prices'][0]['discount'], 10);
    assert.deepEqual(stored['barcode'].map((barcode: Document) => barcode['value']), ['8000000000999']);
    // The same key with another body is a conflict, and another key is another product.
    assert.deepEqual([(await send(admin, 'POST', '/products', { ...body, code: 'BR-2' }, { 'idempotency-key': key })).status], [409]);
    assert.equal((await send(reader, 'POST', '/products', body, { 'idempotency-key': key })).status, 403);
    assert.equal((await send(placeKey, 'POST', '/products', body, { 'idempotency-key': key })).status, 201, 'the keys are scoped to the key that sent them');
    assert.equal(await db.products.countDocuments({}), 2);
    // The activity log: the key is the actor, with its indicator, never its secret.
    const [event] = entries('product.created', mark);
    assert.equal(event!.actor.kind, 'apiKey');
    assert.equal(event!.actor.id?.toHexString(), admin.id);
    assert.equal(event!.metadata?.['keyHint'], admin.secret.slice(6, 12));
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(admin.secret));
  });

  it('turns cents into amounts and back without loss, and a price sent back as it was read changes nothing', async () => {
    const list = await priceListId();
    const tax = await taxOf();
    for (const cents of [0, 1, 7, 99, 100, 1999, 12345, 100_000, 99_999_999]) {
      const made = await create({ prices: [{ priceListId: list, currency: 'EUR', taxId: tax['id'], grossCents: cents }] });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const stored = (await db.products.findOne({ _id: new ObjectId(made.body.data.id as string) }))!;
      assert.equal(stored['prices'][0]['taxed'], cents / 100, String(cents));
      assert.equal(stored['prices'][0]['price'], netOf(cents / 100, tax['value'] as number), String(cents));
      const read = await get(`/products/${made.body.data.id}`);
      assert.equal(read.body.data.prices[0].grossCents, cents, `${String(cents)} cents come back as read`);
      const { taxRatePercent: _rate, ...writable } = read.body.data.prices[0];
      const same = await send(admin, 'PATCH', `/products/${read.body.data.id}`, { prices: [writable] }, { 'if-match': tagOf(read) });
      assert.equal(same.status, 200, JSON.stringify(same.body));
      assert.equal(tagOf(same), tagOf(read), `${String(cents)}: nothing changes, nothing is written`);
      assert.equal(same.body.data.updatedAt, read.body.data.updatedAt);
    }
    // A new rule next to the old one, and the old one dropped by leaving it out.
    const made = await create({ prices: [{ priceListId: list, currency: 'EUR', taxId: tax['id'], grossCents: 500 }] });
    const rule = made.body.data.prices[0];
    const changed = await send(admin, 'PATCH', `/products/${made.body.data.id}`, { prices: [{ id: rule.id, priceListId: list, currency: 'EUR', taxId: tax['id'], grossCents: 550 }, { priceListId: list, currency: 'EUR', taxId: tax['id'], grossCents: 450, fromQuantity: 10 }] }, { 'if-match': tagOf(made) });
    assert.deepEqual(changed.body.data.prices.map((price: { grossCents: number }) => price.grossCents), [550, 450]);
    const dropped = await send(admin, 'PATCH', `/products/${made.body.data.id}`, { prices: [] }, { 'if-match': tagOf(changed) });
    assert.deepEqual(dropped.body.data.prices, []);
  });

  it('refuses what an integration may not write and the prices that are not whole cents, with 422 on the fields', async () => {
    const list = await priceListId();
    const taxId = (await taxOf())['id'];
    const price = { priceListId: list, currency: 'EUR', taxId, grossCents: 100 };
    const forbidden: Document[] = [
      { simpleCost: 1 },
      { suppliers: [] },
      { image: null },
      { gallery: [] },
      { internalFileName: 'x' },
      { externalUrl: 'https://example.com' },
      { printStations: {} },
      { counterPrintStations: {} },
      { stock: {} },
      { components: [] },
      { productionValue: 1 },
      { colors: { text: '#000000' } },
      { dining: { halfPortion: true } },
      { integrations: { yellgo: true } },
      { toCheck: true },
      { favoriteHandheld: true },
      { enabled: true },
      { costs: {} },
      { places: [{ placeId: hex(own()), productionCenterId: 'pc' }] },
      { places: [{ placeId: hex(own()), favoriteHandheld: true }] },
      { barcodes: [{ value: '1', loadQuantity: 2 }] },
      { prices: [{ ...price, gross: 1 }] },
      { prices: [{ ...price, net: 1 }] },
      { prices: [{ ...price, taxRatePercent: 22 }] },
      { prices: [{ ...price, grossCents: 12.5 }] },
      { prices: [{ ...price, grossCents: -1 }] },
      { prices: [{ ...price, grossCents: '100' }] },
      { prices: [{ ...price, grossCents: 100_000_000_001 }] },
      { prices: [{ priceListId: list, currency: 'EUR', taxId }] },
      { prices: [{ ...price, currency: 'euro' }] },
      { status: 'trashed' },
      { status: 'enabled' },
      { name: { it: '' } },
      { unknownField: 1 },
    ];
    for (const extra of forbidden) {
      const reply = await create(extra);
      assert.deepEqual([reply.status, reply.body.error.code], [422, 'VALIDATION_ERROR'], JSON.stringify(extra));
    }
    assert.equal(await db.products.countDocuments({}), 0);
    const made = await create({});
    for (const extra of forbidden.filter((entry) => !('name' in entry))) {
      assert.equal((await send(admin, 'PATCH', `/products/${made.body.data.id}`, extra, { 'if-match': tagOf(made) })).status, 422, `PATCH ${JSON.stringify(extra)}`);
    }
    // A price on a list or a tax that the group does not have is refused by the same rules as the backoffice.
    assert.equal((await create({ prices: [{ ...price, taxId: 'nessuna' }] })).status, 422);
    assert.equal((await create({ prices: [{ ...price, priceListId: 'nessuno' }] })).status, 422);
    assert.equal((await create({ categoryIds: [hex(new ObjectId())] })).status, 422);
    assert.equal((await create({ places: [{ placeId: hex(new ObjectId()) }] })).status, 422);
    assert.equal((await create({ brandId: hex(new ObjectId()) })).status, 422);
  });

  it('answers the way of the contract: Idempotency-Key, If-Match, 412, the size and the media type of the body', async () => {
    assert.equal((await send(admin, 'POST', '/products', { name: { it: 'x' } })).status, 422, 'a creation needs its Idempotency-Key');
    assert.equal((await send(admin, 'POST', '/products', { name: { it: 'x' } }, { 'idempotency-key': 'not-a-uuid' })).status, 422);
    const made = await create({ code: 'V-1' });
    const id = made.body.data.id as string;
    assert.equal((await send(admin, 'PATCH', `/products/${id}`, { code: 'V-2' })).status, 422, 'If-Match is required');
    assert.equal((await send(admin, 'PATCH', `/products/${id}`, { code: 'V-2' }, { 'if-match': '*' })).status, 422);
    assert.equal((await send(admin, 'PATCH', `/products/${id}`, {}, { 'if-match': tagOf(made) })).status, 422, 'a modification names a field');
    const changed = await send(admin, 'PATCH', `/products/${id}`, { code: 'V-2' }, { 'if-match': tagOf(made) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.code, 'V-2');
    assert.notEqual(tagOf(changed), tagOf(made));
    assert.equal((await send(admin, 'PATCH', `/products/${id}`, { code: 'V-3' }, { 'if-match': tagOf(made) })).status, 412);
    assert.equal((await send(admin, 'POST', `/products/${id}/trash`, undefined, { 'if-match': tagOf(made) })).status, 412);
    assert.equal((await send(admin, 'POST', `/products/${id}/trash`)).status, 422);
    const big = await send(admin, 'POST', '/products', { name: { it: 'x'.repeat(Number.parseInt(PRODUCT_BODY_LIMIT, 10) * 1024) } }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([big.status, big.body.error.code], [413, 'PAYLOAD_TOO_LARGE']);
    const text = await fetch(`${world.office.app.baseUrl}/public/v1/products`, { method: 'POST', headers: { 'x-api-key': admin.secret, 'content-type': 'text/plain', 'idempotency-key': randomUUID() }, body: 'name' });
    assert.equal(text.status, 415);
    const broken = await fetch(`${world.office.app.baseUrl}/public/v1/products`, { method: 'POST', headers: { 'x-api-key': admin.secret, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{"name":' });
    assert.equal(broken.status, 400);
    assert.equal(await db.products.countDocuments({}), 1);
  });

  it('trashes and restores a product, and has no way to delete one for good, to duplicate it or to empty the trash', async () => {
    const mark = world.office.activity.entries.length;
    const made = await create({ code: 'T-1' });
    const id = made.body.data.id as string;
    const trashed = await send(admin, 'POST', `/products/${id}/trash`, undefined, { 'if-match': tagOf(made) });
    assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
    assert.equal(trashed.body.data.status, 'trashed');
    assert.notEqual(trashed.body.data.trashedAt, null);
    assert.equal((await send(admin, 'POST', `/products/${id}/trash`, undefined, { 'if-match': tagOf(trashed) })).status, 409);
    assert.equal((await send(admin, 'PATCH', `/products/${id}`, { code: 'x' }, { 'if-match': tagOf(trashed) })).status, 409, 'a product in the trash is not modified');
    assert.deepEqual(ids(await get('/products')), []);
    assert.deepEqual(ids(await get('/products?updatedSince=2000-01-01')), [id], 'a client that keeps a copy is told: the trashed one is there, as such');
    const restored = await send(admin, 'POST', `/products/${id}/restore`, undefined, { 'if-match': tagOf(trashed) });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.data.status, 'active');
    assert.equal((await send(admin, 'POST', `/products/${id}/restore`, undefined, { 'if-match': tagOf(restored) })).status, 409);
    for (const action of ['product.created', 'product.trashed', 'product.restored']) {
      assert.ok(entries(action, mark).every((entry) => entry.actor.kind === 'apiKey' && entry.metadata?.['keyHint'] === admin.secret.slice(6, 12)), action);
    }
    for (const [method, path] of [['DELETE', `/products/${id}`], ['POST', '/products/trash'], ['PUT', `/products/${id}`], ['DELETE', '/products'], ['POST', `/products/${id}/delete`], ['POST', `/products/${id}/duplicate`], ['DELETE', '/trash'], ['POST', '/products/empty-trash']] as const) {
      const reply = await send(admin, method, path, {}, { 'if-match': tagOf(restored), 'idempotency-key': randomUUID() });
      assert.ok([404, 405].includes(reply.status), `${method} ${path}: ${String(reply.status)}`);
    }
    assert.equal(await db.products.countDocuments({ _id: new ObjectId(id) }), 1);
    await db.products.updateOne({ _id: new ObjectId(id) }, { $set: { trash: true } });
    assert.equal((await send(admin, 'DELETE', `/products/${id}`, undefined, { 'if-match': tagOf(restored) })).status, 405, 'not even from the trash');
  });

  it('writes with the perimeter of a place administrator of the places of the key, and with the one of a group administrator for a key without restrictions', async () => {
    const everyone = await seed({ name: { it: 'Per tutti' } });
    const shared = await seed({ name: { it: 'Condiviso' }, placesAvailability: [placeEntry(own()), placeEntry(other())] });
    const elsewhere = await seed({ name: { it: 'Altrove' }, placesAvailability: [placeEntry(other())] });
    const mine = await seed({ name: { it: 'Mio' }, placesAvailability: [placeEntry(own())] });
    for (const key of [placeKey, companyKey]) {
      const tag = async (id: ObjectId) => tagOf(await get(`/products/${hex(id)}`, key));
      const created = await send(key, 'POST', '/products', { name: { it: 'Nuovo' }, places: [{ placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.editable, true);
      const outside = await send(key, 'POST', '/products', { name: { it: 'x' }, places: [{ placeId: hex(other()) }] }, { 'idempotency-key': randomUUID() });
      assert.deepEqual([outside.status, outside.body.error.code], [403, 'FORBIDDEN']);
      assert.equal((await send(key, 'POST', '/products', { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 403, 'a product for every place is not its to make');
      assert.equal((await send(key, 'PATCH', `/products/${hex(mine)}`, { name: { it: 'Cambiato' } }, { 'if-match': await tag(mine) })).status, 200, 'a product only of its places is wholly its own');
      const refused = await send(key, 'PATCH', `/products/${hex(shared)}`, { name: { it: 'Nuovo' } }, { 'if-match': await tag(shared) });
      assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details], [403, 'FORBIDDEN', [{ field: 'name', issue: 'notAllowed' }]], 'a shared product: not its fields');
      const placeData = await send(key, 'PATCH', `/products/${hex(shared)}`, { places: [{ placeId: hex(own()), favorite: true }] }, { 'if-match': await tag(shared) });
      assert.equal(placeData.status, 200, JSON.stringify(placeData.body));
      assert.equal((await send(key, 'PATCH', `/products/${hex(everyone)}`, { name: { it: 'x' } }, { 'if-match': await tag(everyone) })).status, 403, 'a product for every place: not its fields');
      assert.equal((await send(key, 'PATCH', `/products/${hex(elsewhere)}`, { name: { it: 'x' } }, { 'if-match': tagOf(created) })).status, 404);
      assert.equal((await send(key, 'POST', `/products/${hex(elsewhere)}/trash`, undefined, { 'if-match': tagOf(created) })).status, 404);
      assert.equal((await send(key, 'POST', `/products/${hex(shared)}/trash`, undefined, { 'if-match': await tag(shared) })).status, 403, 'a shared product is not trashed by one of its places');
      const trashed = await send(key, 'POST', `/products/${created.body.data.id}/trash`, undefined, { 'if-match': tagOf(created) });
      assert.equal(trashed.status, 200);
      assert.equal((await send(key, 'POST', `/products/${created.body.data.id}/restore`, undefined, { 'if-match': tagOf(trashed) })).status, 200);
    }
    // A key without restrictions is a group administrator: it changes the products of every place, for every place included.
    assert.equal((await send(admin, 'PATCH', `/products/${hex(everyone)}`, { name: { it: 'Cambiato' } }, { 'if-match': tagOf(await get(`/products/${hex(everyone)}`)) })).status, 200);
    assert.equal((await send(admin, 'PATCH', `/products/${hex(shared)}`, { name: { it: 'Cambiato' } }, { 'if-match': tagOf(await get(`/products/${hex(shared)}`)) })).status, 200);
    assert.equal((await send(admin, 'PATCH', `/products/${hex(elsewhere)}`, { name: { it: 'Cambiato' } }, { 'if-match': tagOf(await get(`/products/${hex(elsewhere)}`)) })).status, 200);
    const forAll = await send(admin, 'POST', '/products', { name: { it: 'Per tutti' } }, { 'idempotency-key': randomUUID() });
    assert.equal(forAll.status, 201);
    assert.deepEqual(forAll.body.data.places, []);
  });

  it('gives a key of the only place of a group the products for every place, and takes it back with a second place', async () => {
    const everyone = await seed({ name: { it: 'Per tutti' } });
    await Promise.all([copies().updateOne({ _id: other() }, { $set: { trash: true } }), originals().updateOne({ _id: other() }, { $set: { trash: true } })]);
    try {
      const read = await get(`/products/${hex(everyone)}`, placeKey);
      assert.equal(read.body.data.editable, true);
      assert.equal((await send(placeKey, 'PATCH', `/products/${hex(everyone)}`, { name: { it: 'Mio' } }, { 'if-match': tagOf(read) })).status, 200);
      assert.equal((await send(placeKey, 'POST', '/products', { name: { it: 'Per tutti' } }, { 'idempotency-key': randomUUID() })).status, 201);
    } finally {
      await Promise.all([copies().updateOne({ _id: other() }, { $set: { trash: false } }), originals().updateOne({ _id: other() }, { $set: { trash: false } })]);
    }
    const back = await get(`/products/${hex(everyone)}`, placeKey);
    assert.equal(back.body.data.editable, false);
    assert.equal((await send(placeKey, 'PATCH', `/products/${hex(everyone)}`, { name: { it: 'x' } }, { 'if-match': tagOf(back) })).status, 403);
  });

  it('refuses a field the group has no function for, as the backoffice does', async () => {
    await groups().updateOne({ _id: gid() }, { $set: settings(NONE) });
    for (const extra of [{ plu: '12' }, { duration: '01:00' }, { availability: { ecommerce: true } }, { featured: true }, { scaleType: 'weight' }, { loadUnit: 'kg' }]) {
      const reply = await create(extra);
      assert.equal(reply.status, 422, JSON.stringify(extra));
      assert.ok(reply.body.error.details.some((detail: { issue: string }) => detail.issue === 'notAllowed'), JSON.stringify(reply.body));
    }
    assert.equal((await create({})).status, 201);
  });
});

describe('the catalog of the public API: categories', () => {
  it('lists the active ones and, since an instant, the disabled ones too; the tree and one by one, in the perimeter of the key', async () => {
    const modifierMine = await seed({ variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, placesAvailability: [placeEntry(own())] });
    const modifierElsewhere = await seed({ variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, placesAvailability: [placeEntry(other())] });
    const root = await seedCategory({ name: { it: 'Radice' }, position: 1, updateDate: at(1), variants: [modifierMine, modifierElsewhere] });
    const child = await seedCategory({ name: { it: 'Figlia' }, parentId: root, position: 2, updateDate: at(2), placesAvailability: [{ id: own(), position: 5, productionCenterId: 'pc-1' }] });
    const elsewhere = await seedCategory({ name: { it: 'Altrove' }, position: 3, updateDate: at(3), placesAvailability: [{ id: other(), position: 1, productionCenterId: null }] });
    const off = await seedCategory({ name: { it: 'Spenta' }, status: false, position: 4, updateDate: at(4) });
    const listed = await get('/categories');
    assert.deepEqual(ids(listed), [hex(root), hex(child), hex(elsewhere)].map((id) => id), 'oldest change first, the active ones');
    const text = JSON.stringify(listed.body);
    for (const forbidden of ['image', 'icon', 'printStations', 'counterPrintStations', 'productionCenterId', 'integrations', 'dining', 'productionValue', 'backgroundColor', 'textColor', 'secondaryFiscalPrinter', 'internalFileName', 'externalUrl', 'parentHidden', 'depth']) {
      assert.ok(!text.includes(`"${forbidden}"`), forbidden);
    }
    assert.deepEqual(listed.body.data[1].places, [{ placeId: hex(own()), position: 5 }]);
    assert.equal(listed.body.data[1].parentId, hex(root));
    assert.deepEqual(listed.body.data[0].modifierIds.length, 2);
    const narrow = await get('/categories', placeKey);
    assert.deepEqual(narrow.body.data[0].modifierIds, [hex(modifierMine)], 'only the modifiers the key reaches');
    assert.ok(!ids(narrow).includes(hex(elsewhere)));
    const since = await get('/categories?updatedSince=2026-01-03');
    assert.deepEqual(since.body.data.map((item: { status: string }) => item.status), ['active', 'disabled']);
    assert.equal((await pagesOf('/categories')).flatMap((page) => page.data).length, 3);
    const tree = await get('/categories/tree');
    assert.equal(tree.status, 200);
    assert.deepEqual(tree.body.data.map((node: { id: string }) => node.id), [hex(root), hex(elsewhere), hex(off)]);
    assert.deepEqual(tree.body.data[0], { id: hex(root), name: 'Radice', parentId: null, position: 1, status: 'active', children: [{ id: hex(child), name: 'Figlia', parentId: hex(root), position: 2, status: 'active', children: [] }] });
    assert.equal(tree.body.data[2].status, 'disabled');
    const revalidated = await world.asKey(admin.secret, '/categories/tree', { 'if-none-match': tree.headers.get('etag')! });
    assert.equal(revalidated.status, 304);
    const one = await get(`/categories/${hex(child)}`);
    assert.equal(one.status, 200);
    assert.ok(tagOf(one));
    assert.equal((await get(`/categories/${hex(elsewhere)}`, placeKey)).status, 404);
    assert.equal((await get(`/categories/${hex(new ObjectId())}`)).status, 404);
    for (const query of ['?q=a', '?sort=name', '?limit=101', '?enabled=true']) {
      assert.equal((await get(`/categories${query}`)).status, 422, query);
    }
    assert.equal((await get('/categories/tree?x=1')).status, 422);
  });

  it('creates, changes and deletes a category, with the rules of the backoffice, and records the key', async () => {
    const mark = world.office.activity.entries.length;
    const key = randomUUID();
    const body = { name: { it: 'Bevande' }, status: 'disabled', position: 3, availability: { ecommerce: true }, places: [{ placeId: hex(own()), position: 2 }] };
    const created = await send(admin, 'POST', '/categories', body, { 'idempotency-key': key });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    assert.equal(created.headers.get('location'), `/public/v1/categories/${id}`);
    assert.deepEqual(created.body.data.status, 'disabled');
    assert.deepEqual((await send(admin, 'POST', '/categories', body, { 'idempotency-key': key })).body, created.body);
    assert.equal(await db.categories.countDocuments({}), 1);
    const changed = await send(admin, 'PATCH', `/categories/${id}`, { name: { it: 'Bibite' }, status: 'active' }, { 'if-match': tagOf(created) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.deepEqual([changed.body.data.name, changed.body.data.status], [{ it: 'Bibite' }, 'active']);
    assert.equal((await send(admin, 'PATCH', `/categories/${id}`, { name: { it: 'Altro' } }, { 'if-match': tagOf(created) })).status, 412);
    assert.equal((await send(admin, 'PATCH', `/categories/${id}`, { name: { it: 'Altro' } })).status, 422);
    assert.equal((await send(admin, 'PATCH', `/categories/${id}`, {}, { 'if-match': tagOf(changed) })).status, 422);
    assert.equal((await send(admin, 'PATCH', `/categories/${id}`, { parentId: id }, { 'if-match': tagOf(changed) })).status, 422, 'no cycle');
    const child = await send(admin, 'POST', '/categories', { name: { it: 'Figlia' }, parentId: id }, { 'idempotency-key': randomUUID() });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const inUse = await send(admin, 'DELETE', `/categories/${id}`);
    assert.deepEqual([inUse.status, inUse.body.error.code], [409, 'CONFLICT'], 'no cascade, the child refers to it');
    const loop = await send(admin, 'PATCH', `/categories/${id}`, { parentId: child.body.data.id }, { 'if-match': tagOf(changed) });
    assert.equal(loop.status, 422, 'no cycle through a child');
    await seed({ categories: [new ObjectId(child.body.data.id as string)] });
    assert.equal((await send(admin, 'DELETE', `/categories/${child.body.data.id}`)).status, 409, 'a product has it');
    await db.products.deleteMany({});
    assert.equal((await send(admin, 'DELETE', `/categories/${child.body.data.id}`)).status, 204);
    assert.equal((await send(admin, 'DELETE', `/categories/${id}`)).status, 204);
    assert.equal(await db.categories.countDocuments({}), 0);
    for (const action of ['productCategory.created', 'productCategory.updated', 'productCategory.deleted']) {
      assert.ok(entries(action, mark).every((entry) => entry.actor.kind === 'apiKey' && entry.metadata?.['keyHint'] === admin.secret.slice(6, 12)), action);
    }
  });

  it('refuses the fields an integration may not write and keeps the categories of others out of the hands of a restricted key', async () => {
    const forbidden: Document[] = [{ image: null }, { icon: null }, { internalFileName: 'x' }, { externalUrl: 'https://example.com' }, { printStations: {} }, { counterPrintStations: {} }, { integrations: { yellgo: true } }, { dining: { endOfMeal: true } }, { productionValue: 1 }, { secondaryFiscalPrinter: true }, { backgroundColor: '#000000' }, { textColor: '#000000' }, { enabled: true }, { status: 'trashed' }, { places: [{ placeId: hex(own()), productionCenterId: 'pc' }] }];
    for (const extra of forbidden) {
      assert.equal((await send(admin, 'POST', '/categories', { name: { it: 'x' }, ...extra }, { 'idempotency-key': randomUUID() })).status, 422, JSON.stringify(extra));
    }
    assert.equal(await db.categories.countDocuments({}), 0);
    const everyone = await seedCategory({ name: { it: 'Tutti' } });
    const shared = await seedCategory({ name: { it: 'Condivisa' }, placesAvailability: [{ id: own(), position: 1, productionCenterId: null }, { id: other(), position: 1, productionCenterId: null }] });
    const elsewhere = await seedCategory({ name: { it: 'Altrove' }, placesAvailability: [{ id: other(), position: 1, productionCenterId: null }] });
    for (const key of [placeKey, companyKey]) {
      for (const id of [everyone, shared]) {
        const read = await get(`/categories/${hex(id)}`, key);
        assert.equal(read.body.data.editable, false);
        assert.equal((await send(key, 'PATCH', `/categories/${hex(id)}`, { name: { it: 'x' } }, { 'if-match': tagOf(read) })).status, 403);
        assert.equal((await send(key, 'DELETE', `/categories/${hex(id)}`)).status, 403);
      }
      assert.equal((await send(key, 'PATCH', `/categories/${hex(elsewhere)}`, { name: { it: 'x' } }, { 'if-match': tagOf(await get(`/categories/${hex(everyone)}`)) })).status, 404);
      assert.equal((await send(key, 'DELETE', `/categories/${hex(elsewhere)}`)).status, 404);
      assert.equal((await send(key, 'POST', '/categories', { name: { it: 'Per tutti' } }, { 'idempotency-key': randomUUID() })).status, 403, 'a category for every place is not its to make');
      const mine = await send(key, 'POST', '/categories', { name: { it: 'Mia' }, places: [{ placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() });
      assert.equal(mine.status, 201, JSON.stringify(mine.body));
      assert.equal((await send(key, 'POST', '/categories', { name: { it: 'x' }, parentId: mine.body.data.id, places: [{ placeId: hex(other()) }] }, { 'idempotency-key': randomUUID() })).status, 403);
      assert.equal((await send(key, 'DELETE', `/categories/${mine.body.data.id}`)).status, 204);
    }
    assert.equal(await db.categories.countDocuments({}), 3);
    assert.equal((await send(admin, 'DELETE', `/categories/${hex(everyone)}`)).status, 204, 'a key without restrictions deletes the ones of every place');
  });
});

describe('the catalog of the public API: the details of the bodies and of the views', () => {
  it('refuses a barcode or a place named twice, and changes the status of a product and of a category', async () => {
    const duplicates: Document[] = [{ barcodes: [{ value: '1' }, { value: '1' }] }, { places: [{ placeId: hex(own()) }, { placeId: hex(own()) }] }];
    for (const extra of duplicates) {
      const reply = await create(extra);
      assert.equal(reply.status, 422, JSON.stringify(extra));
      assert.ok(reply.body.error.details.some((detail: { issue: string }) => detail.issue === 'incorrect'));
    }
    const twice = await send(admin, 'POST', '/categories', { name: { it: 'x' }, places: [{ placeId: hex(own()) }, { placeId: hex(own()) }] }, { 'idempotency-key': randomUUID() });
    assert.equal(twice.status, 422);
    const made = await create({});
    const off = await send(admin, 'PATCH', `/products/${made.body.data.id}`, { status: 'disabled' }, { 'if-match': tagOf(made) });
    assert.equal(off.body.data.status, 'disabled');
    const on = await send(admin, 'PATCH', `/products/${made.body.data.id}`, { status: 'active', barcodes: [{ value: '7', saleQuantity: 2 }] }, { 'if-match': tagOf(off) });
    assert.deepEqual([on.body.data.status, on.body.data.barcodes], ['active', [{ value: '7', saleQuantity: 2 }]]);
  });

  it('refuses with 412 a modification whose version is not the one the completion was made on, for a product and for a category', async () => {
    const product = await create({ code: 'V-1' });
    const category = await send(admin, 'POST', '/categories', { name: { it: 'V' } }, { 'idempotency-key': randomUUID() });
    await send(admin, 'PATCH', `/products/${product.body.data.id}`, { code: 'V-2' }, { 'if-match': tagOf(product) });
    await send(admin, 'PATCH', `/categories/${category.body.data.id}`, { position: 2 }, { 'if-match': tagOf(category) });
    assert.equal((await send(admin, 'PATCH', `/products/${product.body.data.id}`, { code: 'V-3' }, { 'if-match': tagOf(product) })).status, 412);
    assert.equal((await send(admin, 'PATCH', `/categories/${category.body.data.id}`, { position: 3 }, { 'if-match': tagOf(category) })).status, 412);
    assert.equal((await db.products.findOne({ _id: new ObjectId(product.body.data.id as string) }))!['code'], 'V-2');
  });

  it('changes a category of a group without the functions, which has no modifiers to keep', async () => {
    await groups().updateOne({ _id: gid() }, { $set: settings(NONE) });
    const category = await seedCategory({});
    const read = await get(`/categories/${hex(category)}`);
    const changed = await send(admin, 'PATCH', `/categories/${hex(category)}`, { position: 4 }, { 'if-match': tagOf(read) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.position, 4);
  });

  it('shows a category and a department of a group without the functions of the groups, and a department whose tax is not a rate', async () => {
    await groups().updateOne({ _id: gid() }, { $set: settings(NONE) });
    const category = await seedCategory({ availability: undefined });
    const read = await get(`/categories/${hex(category)}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(!('availability' in read.body.data) && !('featured' in read.body.data) && !('modifierIds' in read.body.data));
    await groups().updateOne({ _id: gid() }, { $set: settings(ALL) });
    const department = legacyDepartment({ tax: null });
    await db.departments.insertOne(department);
    const shown = await get(`/departments/${hex(department['_id'] as ObjectId)}`);
    assert.deepEqual([shown.body.data.taxId, shown.body.data.taxRatePercent], [null, null]);
  });
});

describe('the catalog of the public API: what a key does not see stays as it is', () => {
  const hiddenWorld = async () => {
    const mod = (overrides: Document = {}) => ({ variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, ...overrides });
    const modMine = await seed(mod({ name: { it: 'Mia' }, placesAvailability: [placeEntry(own())] }));
    const modElsewhere = await seed(mod({ name: { it: 'Altrove' }, placesAvailability: [placeEntry(other())] }));
    const modTrashed = await seed(mod({ name: { it: 'Cestinata' }, trash: true }));
    const choiceMine = await seed({ name: { it: 'Scelta' }, placesAvailability: [placeEntry(own())] });
    const choiceElsewhere = await seed({ name: { it: 'Altra' }, placesAvailability: [placeEntry(other())] });
    const category = await seedCategory({});
    const list = await priceListId();
    const taxId = (await taxOf())['id'] as string;
    const tax = { id: taxId, value: 22, department: 1, description: null, natura: null };
    const prices = [
      legacyPrice({ id: 'p-a', listId: list, taxed: new Double(0.125), price: new Double(netOf(0.125, 22)), taxData: tax }),
      legacyPrice({ id: 'p-b', listId: list, taxed: new Double(999_999_999.99), price: new Double(netOf(999_999_999.99, 22)), taxData: tax }),
    ];
    const everyone = await seed({
      name: { it: 'Completo' },
      barcode: [{ value: '111', qtLoad: 6, qtSale: 1 }],
      placesAvailability: [placeEntry(own(), { favoriteHandheld: true, productionCenterId: 'pc-1', position: 3 })],
      prices,
      variants: [modElsewhere, modMine, modTrashed],
      variantsRequired: [modTrashed, modMine],
      variantsExcluded: [modElsewhere],
      selectableBundleProducts: [{ categoryId: category, quantity: new Int32(1), exit: new Int32(2), products: [{ _id: choiceElsewhere }, { _id: choiceMine }, { _id: modTrashed }] }],
      selectableVariantsBundleProducts: [{ categoryId: category, freeQt: 1, priceType: 'l', products: [{ _id: modElsewhere }, { _id: modMine }] }],
    });
    return { everyone, modMine, modElsewhere, modTrashed };
  };
  const sections = (read: Document): Document => ({
    barcodes: read['barcodes'],
    places: read['places'],
    prices: read['prices'].map(({ taxRatePercent: _rate, ...writable }: Document) => writable),
    requiredModifierIds: read['requiredModifierIds'],
    modifierIds: read['modifierIds'],
    excludedModifierIds: read['excludedModifierIds'],
    menu: read['menu'],
    modifierChoices: read['modifierChoices'],
  });

  it('writes nothing, with the same version, when a product read by a key is sent back as it was read: the barcodes, places, courses, references and prices it does not see or round stay', async () => {
    for (const key of [admin, placeKey, companyKey]) {
      await db.products.deleteMany({});
      const { everyone } = await hiddenWorld();
      const before = (await db.products.findOne({ _id: everyone }))!;
      const read = await get(`/products/${hex(everyone)}`, key);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.data.prices[0].grossCents, 13, 'a fraction of a cent is shown rounded');
      assert.equal(read.body.data.prices[1].grossCents, 99_999_999_999);
      const same = await send(key, 'PATCH', `/products/${hex(everyone)}`, sections(read.body.data), { 'if-match': tagOf(read) });
      assert.equal(same.status, 200, JSON.stringify(same.body));
      const after = (await db.products.findOne({ _id: everyone }))!;
      assert.deepEqual(Object.keys(after).filter((field) => JSON.stringify(after[field]) !== JSON.stringify(before[field])), [], 'fields changed');
      assert.equal(tagOf(same), tagOf(read));
      assert.deepEqual(await db.products.findOne({ _id: everyone }), before, 'not a field of the stored product changed');
    }
  });

  it('keeps what the key does not see when it changes something else in the same lists, and writes the amount it is given when it is another cent', async () => {
    const { everyone, modMine, modElsewhere, modTrashed } = await hiddenWorld();
    const read = await get(`/products/${hex(everyone)}`, placeKey);
    const body = sections(read.body.data);
    const changed = await send(placeKey, 'PATCH', `/products/${hex(everyone)}`, { ...body, modifierIds: [], barcodes: [{ value: '111', saleQuantity: 5 }], places: [{ placeId: hex(own()), position: 9 }], prices: [{ ...body['prices'][0], grossCents: 14 }, body['prices'][1]] }, { 'if-match': tagOf(read) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const stored = (await db.products.findOne({ _id: everyone }))!;
    assert.deepEqual(stored['variants'].map((id: ObjectId) => hex(id)), [hex(modElsewhere), hex(modTrashed)], 'the modifiers it does not reach stay where they were');
    assert.deepEqual(stored['barcode'].map((barcode: Document) => [barcode['qtLoad'], barcode['qtSale']]), [[6, 5]]);
    assert.deepEqual([stored['placesAvailability'][0]['productionCenterId'], stored['placesAvailability'][0]['favoriteHandheld'], stored['placesAvailability'][0]['position']], ['pc-1', true, 9]);
    assert.deepEqual(stored['prices'].map((price: Document) => price['taxed']), [0.14, 999_999_999.99]);
    assert.deepEqual(stored['variantsRequired'].map((id: ObjectId) => hex(id)), [hex(modTrashed), hex(modMine)]);
    assert.equal(hex(stored['selectableBundleProducts'][0]['products'][2]['_id']), hex(modTrashed));
    assert.equal(stored['selectableBundleProducts'][0]['exit'], 2, 'the course of the choice stays');
    // A key sees only the menu and the choices that exist for it, and what is hidden in a list stays when the list is sent again.
    const menuOnly = await send(placeKey, 'PATCH', `/products/${hex(everyone)}`, { menu: [{ categoryId: read.body.data.menu[0].categoryId, quantity: 2, productIds: [] }, { categoryId: read.body.data.menu[0].categoryId, quantity: 1 }] }, { 'if-match': tagOf(changed) });
    assert.equal(menuOnly.status, 200, JSON.stringify(menuOnly.body));
    const menu = (await db.products.findOne({ _id: everyone }))!['selectableBundleProducts'];
    assert.deepEqual([menu[0]['exit'], menu[0]['products'].length, menu[1]['exit'] ?? null, menu[1]['products'].length], [2, 2, null, 0]);
  });

  it('keeps the hidden data of a shared product and of a category when the key sends back the places and the modifiers it reads', async () => {
    const shared = await seed({ name: { it: 'Condiviso' }, placesAvailability: [placeEntry(own(), { productionCenterId: 'pc-1', favoriteHandheld: true }), placeEntry(other(), { productionCenterId: 'pc-2', favoriteHandheld: true })] });
    const read = await get(`/products/${hex(shared)}`, placeKey);
    const before = (await db.products.findOne({ _id: shared }))!;
    const same = await send(placeKey, 'PATCH', `/products/${hex(shared)}`, { places: read.body.data.places }, { 'if-match': tagOf(read) });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.deepEqual(await db.products.findOne({ _id: shared }), before, 'the other place and the data of its own that the key does not see are as they were');

    const modMine = await seed({ variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, placesAvailability: [placeEntry(own())] });
    const modElsewhere = await seed({ variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, placesAvailability: [placeEntry(other())] });
    const modTrashed = await seed({ variant: { status: true, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, trash: true });
    for (const key of [admin, placeKey]) {
      const category = await seedCategory({ placesAvailability: [{ id: own(), position: 5, productionCenterId: 'pc-9' }], variants: [modElsewhere, modMine, modTrashed] });
      const seen = await get(`/categories/${hex(category)}`, key);
      const stored = (await db.categories.findOne({ _id: category }))!;
      const same = await send(key, 'PATCH', `/categories/${hex(category)}`, { places: seen.body.data.places, modifierIds: seen.body.data.modifierIds }, { 'if-match': tagOf(seen) });
      assert.equal(same.status, 200, JSON.stringify(same.body));
      assert.equal(tagOf(same), tagOf(seen));
      assert.deepEqual(await db.categories.findOne({ _id: category }), stored);
      const emptied = await send(key, 'PATCH', `/categories/${hex(category)}`, { modifierIds: [] }, { 'if-match': tagOf(same) });
      assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
      const left = (await db.categories.findOne({ _id: category }))!['variants'].map((id: ObjectId) => hex(id));
      assert.deepEqual(left, key === admin ? [hex(modTrashed)] : [hex(modElsewhere), hex(modTrashed)], 'what the key does not reach stays');
      await db.categories.deleteMany({});
    }
  });
});

describe('the catalog of the public API: more refusals', () => {
  it('does not take a public key on the routes of the store, as a Bearer token or as X-Api-Key', async () => {
    for (const headers of [{ authorization: `Bearer ${admin.secret}` }, { 'x-api-key': admin.secret }, { authorization: `Bearer ${admin.secret}`, 'x-api-key': admin.secret }]) {
      for (const path of ['/store-context/catalog/products', '/store-context/catalog/brands', '/store-context/catalog/categories/tree', '/store-context']) {
        const reply = await fetch(`${world.office.app.baseUrl}/v1${path}`, { headers });
        assert.equal(reply.status, 401, `${path} ${Object.keys(headers).join('+')}`);
      }
    }
    const write = await fetch(`${world.office.app.baseUrl}/v1/store-context/catalog/products`, { method: 'POST', headers: { authorization: `Bearer ${admin.secret}`, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'x-operator-id': hex(new ObjectId()) }, body: '{"name":{"it":"x"}}' });
    assert.equal(write.status, 401);
    assert.equal(await db.products.countDocuments({}), 0);
  });

  it('refuses a revoked key and an expired key on the routes of the catalog, reads and writes', async () => {
    const revoked = await world.makeKey(0, { name: 'Revoked', permissions: ['catalog:read', 'catalog:write'] });
    const expiring = await world.makeKey(0, { name: 'Expiring', permissions: ['catalog:read', 'catalog:write'], expiresAt: new Date(world.office.clock.now() + 3600_000).toISOString() });
    assert.equal((await get('/products', revoked)).status, 200);
    assert.equal((await get('/products', expiring)).status, 200);
    assert.equal((await world.as.call(world.office.cluster.psa, 'POST', world.keysPath(0, `/${revoked.id}/revoke`))).status, 200);
    await ctx.databases.common().collection('apiKeys').updateOne({ _id: new ObjectId(expiring.id) }, { $set: { expiresAt: new Date(world.office.clock.now()) } });
    for (const key of [revoked, expiring]) {
      assert.deepEqual([(await get('/products', key)).status, (await get('/stock', key)).status, (await get('/categories/tree', key)).status], [401, 401, 401]);
      assert.equal((await send(key, 'POST', '/products', { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 401);
      assert.equal((await send(key, 'DELETE', `/categories/${hex(new ObjectId())}`)).status, 401);
    }
    assert.equal(await db.products.countDocuments({}), 0);
  });

  it('refuses the operators of MongoDB and the keys with a dot in the bodies and the queries, and writes nothing', async () => {
    const made = await create({});
    const tag = tagOf(made);
    const bodies: unknown[] = [
      { $set: { name: { it: 'x' } } },
      { name: { it: 'x' }, code: { $ne: '' } },
      { name: { it: 'x' }, $where: '1' },
      { name: { 'it.x': 'a' } },
      { name: { $gt: 'a' } },
      { name: { it: 'x' }, prices: [{ priceListId: { $ne: null }, currency: 'EUR', taxId: 't', grossCents: 1 }] },
      { name: { it: 'x' }, places: [{ placeId: { $in: [] } }] },
      { name: { it: 'x' }, 'places.0': 1 },
      { name: { it: 'x' }, categoryIds: [{ $ne: 1 }] },
    ];
    for (const body of bodies) {
      assert.equal((await create(body as Document)).status, 422, JSON.stringify(body));
      assert.equal((await send(admin, 'PATCH', `/products/${made.body.data.id}`, body, { 'if-match': tag })).status, 422, `PATCH ${JSON.stringify(body)}`);
      assert.equal((await send(admin, 'POST', '/categories', body, { 'idempotency-key': randomUUID() })).status, 422, `category ${JSON.stringify(body)}`);
    }
    const raw = await fetch(`${world.office.app.baseUrl}/public/v1/products`, { method: 'POST', headers: { 'x-api-key': admin.secret, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: '{"name":{"it":"x"},"__proto__":{"admin":true},"constructor":{"prototype":{}}}' });
    assert.equal(raw.status, 422);
    for (const query of ['?family[$ne]=x', '?updatedSince[$gt]=2020-01-01', '?limit[$gt]=1', '?cursor[$ne]=a', '?$where=1', '?family.x=1']) {
      assert.equal((await get(`/products${query}`)).status, 422, query);
      assert.equal((await get(`/categories${query}`)).status, 422, query);
    }
    assert.equal(await db.products.countDocuments({}), 1);
    assert.equal(await db.categories.countDocuments({}), 0);
    assert.equal((await db.products.findOne({}))!['name']['it'], 'Acqua');
  });

  it('has exactly these routes on /public/v1, each with its permission', () => {
    const modules = createBackofficeModules({ config: testConfig(), databases: ctx.databases, activityLog: memoryActivityLog(), logger: memoryLogger().logger, rateLimiter: memoryRateLimiter() });
    const publicApi = createPublicApiModules({ config: testConfig(), databases: ctx.databases, activityLog: memoryActivityLog(), logger: memoryLogger().logger, rateLimiter: memoryRateLimiter(), catalog: modules.catalog });
    const listed = publicApi.routes.map((route) => `${route.method} ${route.path} ${route.auth.kind === 'apiKey' ? String(route.auth.permission) : route.auth.kind}${route.rateLimit === undefined ? '' : ' +writeLimit'}`).sort();
    assert.deepEqual(listed, [
      'DELETE /categories/:categoryId catalog:write +writeLimit',
      'GET /attribute-groups catalog:read',
      'GET /attribute-groups/:attributeGroupId catalog:read',
      'GET /brands catalog:read',
      'GET /brands/:brandId catalog:read',
      'GET /categories catalog:read',
      'GET /categories/:categoryId catalog:read',
      'GET /categories/tree catalog:read',
      'GET /companies companies:read',
      'GET /companies/:companyId companies:read',
      'GET /departments catalog:read',
      'GET /departments/:departmentId catalog:read',
      'GET /me null',
      'GET /places places:read',
      'GET /places/:placeId places:read',
      'GET /price-lists catalog:read',
      'GET /products catalog:read',
      'GET /products/:productId catalog:read',
      'GET /products/:productId/stock catalog:read',
      'GET /stock catalog:read',
      'GET /taxes catalog:read',
      'PATCH /categories/:categoryId catalog:write +writeLimit',
      'PATCH /products/:productId catalog:write +writeLimit',
      'POST /categories catalog:write +writeLimit',
      'POST /products catalog:write +writeLimit',
      'POST /products/:productId/restore catalog:write +writeLimit',
      'POST /products/:productId/trash catalog:write +writeLimit',
    ]);
    assert.ok(publicApi.routes.every((route) => route.auth.kind === 'apiKey'));
    assert.ok(publicApi.routes.filter((route) => route.method !== 'GET').every((route) => route.rateLimit?.[0]?.bucket === 'public-catalog-write:key'));
    assert.ok(publicApi.routes.filter((route) => route.auth.kind === 'apiKey' && (route.auth.permission === 'catalog:read' || route.auth.permission === 'catalog:write') && route.path !== '/price-lists' && route.path !== '/taxes').every((route) => (route.auth as { group?: true }).group === true));
  });
});

describe('the catalog of the public API: the activity log as it is stored', () => {
  it('keeps the six characters of the key after fc_pk_ and the operator, redacts nothing and is refused by nothing, with the group on the events of the key', async () => {
    const mark = world.office.activity.entries.length;
    const product = await create({ code: 'L-1' });
    const changed = await send(admin, 'PATCH', `/products/${product.body.data.id}`, { code: 'L-2' }, { 'if-match': tagOf(product) });
    const trashed = await send(admin, 'POST', `/products/${product.body.data.id}/trash`, undefined, { 'if-match': tagOf(changed) });
    await send(admin, 'POST', `/products/${product.body.data.id}/restore`, undefined, { 'if-match': tagOf(trashed) });
    const category = await send(admin, 'POST', '/categories', { name: { it: 'Log' } }, { 'idempotency-key': randomUUID() });
    const renamed = await send(admin, 'PATCH', `/categories/${category.body.data.id}`, { position: 2 }, { 'if-match': tagOf(category) });
    assert.equal(renamed.status, 200);
    assert.equal((await send(admin, 'DELETE', `/categories/${category.body.data.id}`)).status, 204);
    const { stored, refused } = await throughRealLog(ctx, world.office.activity.entries.slice(mark));
    assert.deepEqual(refused, [], 'the real log refuses no entry');
    assert.deepEqual(stored.map((entry) => entry['action']), ['product.created', 'product.updated', 'product.trashed', 'product.restored', 'productCategory.created', 'productCategory.updated', 'productCategory.deleted']);
    for (const entry of stored) {
      assert.equal(entry['metadata']['keyHint'], admin.secret.slice('fc_pk_'.length, 'fc_pk_'.length + 6), entry['action']);
      assert.equal(entry['actor'].kind, 'apiKey');
      assert.equal(entry['actor'].id.toHexString(), admin.id);
    }
    assert.ok(!JSON.stringify(stored).includes('REDACTED'));
    assert.ok(!JSON.stringify(stored).includes(admin.secret));
  });

  it('puts the group of the key on the excess of a limit, before the access to the group is issued', async () => {
    const small = await openTestDatabases();
    const keys = await startKeysWorld(small, { env: { RATE_LIMIT_PUBLIC_CATALOG_WRITE_PER_KEY: '1' }, rateLimiter: memoryRateLimiter() });
    try {
      const key = await keys.makeKey(0, { permissions: ['catalog:read', 'catalog:write'] });
      for (let index = 0; index < 2; index += 1) {
        await keys.asKey(key.secret, '/categories', { 'idempotency-key': randomUUID() }, 'POST', { name: { it: `C${String(index)}` } });
      }
      const entry = keys.office.activity.entries.find((candidate) => candidate.action === 'rateLimit.exceeded' && candidate.metadata?.['bucket'] === 'public-catalog-write:key')!;
      assert.equal(entry.groupId?.toHexString(), hex(keys.group(0).groupId));
      const { refused } = await throughRealLog(small, [entry]);
      assert.deepEqual(refused, []);
    } finally {
      await keys.office.close();
      await small.cleanup();
    }
  });
});
