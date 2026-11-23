import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { fixtureId, legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startPlacesWorld } from '../helpers/places.ts';
import type { PlacesWorld } from '../helpers/places.ts';
import { catalogCollections, legacyCategory, seedImage } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { legacyFullProduct, legacyPrice, placeEntry } from '../helpers/products.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';
import { createTaxProducts } from '../../src/modules/products/products.tax.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';

let ctx: TestDatabases;
let world: PlacesWorld;
let db: CatalogCollections;
const call = (...args: Parameters<PlacesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const gid = () => world.group(0).groupId;
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/products`;
const one = (id: string | ObjectId, index = 0) => `${base(index)}/${typeof id === 'string' ? id : hex(id)}`;
const tag = (reply: Awaited<ReturnType<typeof call>>) => reply.headers.get('etag')!;
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const groups = () => ctx.databases.common().collection('groups');
const features = (value: Document) => groups().updateOne({ _id: gid() }, { $set: Object.fromEntries(Object.entries(value).map(([key, flag]) => [`settings.${key}`, flag])) });
const ALL = { cash: true, warehouse: true, customersApp: true, tobaccosGamesMonopoly: true, productsVariants: true, services: true, scales: true, ordering: true, rooms: true, media: true };
const NONE = Object.fromEntries(Object.keys(ALL).map((key) => [key, false]));
const stored = (id: string | ObjectId) => db.products.findOne({ _id: typeof id === 'string' ? new ObjectId(id) : id }, { ...EXACT_TYPES });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
let listId = '';
let taxId = '';

async function create(body: Document = {}, actor = sa(), headers: Record<string, string> = {}) {
  const reply = await call(actor, 'POST', base(), { name: { it: 'Acqua' }, ...body }, { 'idempotency-key': randomUUID(), ...headers });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply;
}
const seed = async (overrides: Document = {}) => {
  const document = legacyFullProduct(overrides);
  await db.products.insertOne(document);
  return document['_id'] as ObjectId;
};

before(async () => {
  ctx = await openTestDatabases();
  world = await startPlacesWorld(ctx);
  db = catalogCollections(ctx, world);
  await features(ALL);
  const group = (await groups().findOne({ _id: gid() }))!;
  listId = Object.keys(group['priceLists'] as Document)[0]!;
  taxId = (group['taxes'] as Document[])[0]!['id'] as string;
  await db.places.updateOne(
    { _id: own() },
    { $set: { printStations: [{ id: 'st-1' }, { id: 'st-2' }], productionCenter: [{ id: 'pc-1' }], storages: [{ id: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'), name: 'Cassa' }, { id: 'text', name: 'senza ObjectId' }, 4] } },
  );
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const log = (action: string, mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const post = (body: Document, actor = sa()) => call(actor, 'POST', base(), body, { 'idempotency-key': randomUUID() });
const patch = async (id: string, body: Document, actor = sa(), reference?: Awaited<ReturnType<typeof call>>) =>
  call(actor, 'PATCH', one(id), body, { 'if-match': tag(reference ?? (await call(actor, 'GET', one(id)))) });
const fields = (reply: ReturnType<typeof failure>) => ((reply.details ?? assert.fail(JSON.stringify(reply))) as Array<{ field: string }>).map((detail) => detail.field);
const reset = () => db.products.deleteMany({});
const LEGACY = new Date('2024-03-01T09:00:00.000Z');
const okay = (reply: Awaited<ReturnType<typeof call>>, status = 200) => assert.equal(reply.status, status, JSON.stringify(reply.body));

describe('products: access', () => {
  it('lets the roles that update products write, refuses the others and keeps the groups apart', async () => {
    for (const actor of [psa(), world.office.cluster.dealerA, sa()]) {
      const created = await create({}, actor);
      assert.equal(created.body.data.editable, true);
    }
    const created = await create();
    assert.equal((await world.office.call('GET', base(), undefined)).status, 401);
    assert.equal((await world.office.call('POST', base(), undefined)).status, 401);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'GET', base())).status, 404);
    assert.equal(failure(await call(world.office.cluster.dealerB, 'POST', base(), { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 1))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'GET', one(created.body.data.id, 0))).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'POST', `${one(created.body.data.id, 1)}/duplicate`, undefined, { 'idempotency-key': randomUUID() })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'PATCH', one(created.body.data.id, 1), { enabled: false }, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'POST', `${one(created.body.data.id, 1)}/trash`, undefined, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(world.group(1).sa, 'DELETE', one(created.body.data.id, 1), undefined, { 'if-match': tag(created) })).status, 404);
    assert.equal(failure(await call(sa(), 'GET', one('not-an-id'))).status, 422);
    assert.equal(failure(await call(sa(), 'GET', `${base()}?x=1`)).status, 422);
    assert.equal(failure(await call(sa(), 'PATCH', one(created.body.data.id), { enabled: false })).status, 422);
    assert.equal(failure(await call(sa(), 'PATCH', one(created.body.data.id), {}, { 'if-match': tag(created) })).status, 422);
    assert.equal(failure(await call(sa(), 'POST', base(), { name: { it: 'x' } })).status, 422);
    // A user who reads the products does not write them, one who does not read them does not even list them.
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: true, w: false } } }) });
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: false, w: false } } }) });
    assert.equal((await call(reader.id, 'GET', base())).status, 200);
    assert.equal(failure(await call(reader.id, 'POST', base(), { name: { it: 'x' } }, { 'idempotency-key': randomUUID() })).status, 403);
    assert.equal(failure(await call(reader.id, 'PATCH', one(created.body.data.id), { enabled: false }, { 'if-match': tag(created) })).status, 403);
    assert.equal(failure(await call(reader.id, 'POST', `${base()}/trash`, { ids: [created.body.data.id] })).status, 403);
    assert.equal(failure(await call(blind.id, 'GET', one(created.body.data.id))).status, 403);
  });
});

describe('products: creation', () => {
  it('creates a product in the legacy shape with 201, Location and ETag, replays a retry and records it', async () => {
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const body = {
      name: { it: '  Pizza  ' },
      shortName: { it: 'Pizza' },
      description: { it: 'Tonda' },
      shortDescription: { it: 'Tonda' },
      code: 'PZ-1',
      plu: '12',
      type: 'exempt',
      favorite: true,
      favoriteHandheld: true,
      generic: true,
      toCheck: true,
      noDiscount: true,
      availability: { pos: false, warehouse: true, scales: true, ecommerce: true },
      featured: true,
      integrations: { floodOrders: true, leggimenu: true },
      position: 3,
      productionValue: 4,
      validFrom: '2026-01-01T00:00:00Z',
      validTo: '2026-12-31T23:59:59.000Z',
      scaleType: 'piece',
      loadUnit: 'pz',
      unloadUnit: 'pz',
      conversionRatio: 2.5,
      colors: { text: '#FFFFFF', background: '#AA00BB' },
      dining: { halfPortion: true, feePercentage: 2.5, hiddenOnHandheld: true, affiliatedMenu: true, reversePrint: true },
      simpleCost: 1.25,
      shipping: { width: 10, height: 20.5, depth: 3, weight: 0.5 },
      barcodes: [{ value: '800', loadQuantity: 6, saleQuantity: 1 }, { value: '801' }],
      internalFileName: 'pizza.png',
      externalUrl: 'https://example.test/pizza.png',
    };
    const first = await call(sa(), 'POST', base(), body, { 'idempotency-key': key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.headers.get('location'), `/v1${base()}/${first.body.data.id as string}`);
    assert.ok(tag(first));
    const data = first.body.data;
    assert.deepEqual([data.name, data.code, data.plu, data.type, data.family, data.enabled, data.isModifier], [{ it: 'Pizza' }, 'PZ-1', '12', 'exempt', 'products', true, false]);
    assert.deepEqual([data.favorite, data.favoriteHandheld, data.generic, data.toCheck, data.noDiscount, data.featured, data.position, data.productionValue], [true, true, true, true, true, true, 3, 4]);
    assert.deepEqual(data.availability, { pos: false, warehouse: true, scales: true, ecommerce: true });
    assert.deepEqual(data.integrations, { floodOrders: true, yellgo: false, leggimenu: true });
    assert.deepEqual([data.validFrom, data.validTo, data.scaleType, data.loadUnit, data.conversionRatio, data.simpleCost], ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.000Z', 'piece', 'pz', 2.5, 1.25]);
    assert.deepEqual(data.colors, { text: '#ffffff', background: '#aa00bb' });
    assert.deepEqual(data.dining, { halfPortion: true, feePercentage: 2.5, hiddenOnHandheld: true, affiliatedMenu: true, reversePrint: true });
    assert.deepEqual(data.shipping, { width: 10, height: 20.5, depth: 3, weight: 0.5 });
    assert.deepEqual(data.barcodes, [{ value: '800', loadQuantity: 6, saleQuantity: 1 }, { value: '801', loadQuantity: null, saleQuantity: null }]);
    assert.deepEqual([data.internalFileName, data.externalUrl, data.image, data.gallery, data.warnings, data.trashed], ['pizza.png', 'https://example.test/pizza.png', null, [], [], false]);
    const document = (await stored(data.id))!;
    assert.deepEqual(Object.keys(document), [
      '_id', 'type', 'time', 'max', 'code', 'barcode', 'brandId', 'name', 'shortName', 'description', 'shortDescription', 'favorite', 'favoriteHandheld', 'generic', 'toCheck', 'noDiscount', 'printStations', 'printStationsNoRooms', 'availability', 'plu', 'scaleType', 'variant',
      'variantsRequired', 'variants', 'variantsExcluded', 'variantsCategories', 'bundleProducts', 'selectableBundleProducts', 'selectableVariantsBundleProducts', 'modularBundle', 'measureLoad', 'measureDownload', 'measureConversionRatio', 'quantity', 'lastAveragePrice', 'simpleCost', 'colors',
      'startDate', 'endDate', 'categories', 'placesAvailability', 'medias', 'shippingInfo', 'tags', 'related', 'attributes', 'suppliers', 'parentId', 'prices', 'position', 'productionValue', 'roomsSettings', 'integrations', 'featured', 'status', 'trash', 'insertDate', 'updateDate',
    ]);
    assert.ok(document['position'] instanceof Int32 && document['scaleType'] instanceof Int32 && document['measureConversionRatio'] instanceof Double);
    assert.ok(document['startDate'] instanceof Date && document['insertDate'] instanceof Date);
    assert.deepEqual(plain(document['barcode']), [{ value: '800', qtLoad: 6, qtSale: 1 }, { value: '801', qtLoad: null, qtSale: null }]);
    assert.deepEqual(plain(document['lastAveragePrice']), { lastSupplierId: null, total: { year: null, lastPrice: 0, totalN: 0, totalCost: 0, averagePrice: 0, totalQuantity: 0, totalCostQt: 0, weightedAveragePrice: 0 }, suppliers: {} });
    assert.deepEqual(plain(document['colors']), { pos: { text: '#ffffff', background: '#aa00bb' } });
    assert.deepEqual([document['tags'], document['related'], document['parentId'], document['trash'], document['modularBundle']], [[], [], null, false, { priceRule: null }]);
    assert.deepEqual(plain(document['integrations']), { floodOrders: true, easyappear: false, yellgo: false, leggimenu: true });
    assert.equal(log('product.created', mark).length, 1);
    assert.equal((await call(sa(), 'POST', base(), body, { 'idempotency-key': key })).body.data.id, data.id);
    assert.equal(failure(await call(sa(), 'POST', base(), { name: { it: 'altro' } }, { 'idempotency-key': key })).status, 409);
    assert.equal((await call(sa(), 'GET', one(data.id))).headers.get('etag'), tag(first));
  });

  it('writes the defaults of the legacy form', async () => {
    const created = await create();
    const document = (await stored(created.body.data.id))!;
    assert.deepEqual([document['type'], document['code'], document['plu'], document['status'], document['time'], document['max']], ['product', '', '', true, '', null]);
    assert.deepEqual(plain(document['availability']), { pos: true, warehouse: false, scales: false, ecommerce: false });
    assert.deepEqual([document['prices'], document['barcode'], document['placesAvailability'], document['categories'], document['variantsRequired']], [[], [], [], [], []]);
    assert.deepEqual(plain(document['variant']), { status: false, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: {} });
    assert.deepEqual(plain(document['medias']), { images: {} });
  });
});

describe('products: validation and references', () => {
  it('validates every field by allowlist', async () => {
    assert.deepEqual(failure(await post({})).details, [{ field: 'name', issue: 'required' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, trash: true, quantity: {}, lastAveragePrice: {}, tags: [], parentId: null })).details, ['trash', 'quantity', 'lastAveragePrice', 'tags', 'parentId'].map((field) => ({ field, issue: 'unknown' })));
    assert.deepEqual(failure(await post({ name: { it: 'x' }, stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { value: 5 } } } })).details, [{ field: `stock.${hex(own())}.aaaaaaaaaaaaaaaaaaaaaaaa.value`, issue: 'unknown' }]);
    const bad: Array<[string, unknown, string]> = [
      ['type', 'gift', 'enum'],
      ['code', 'a\nb', 'pattern'],
      ['code', 'x'.repeat(65), 'maxLength'],
      ['plu', '012', 'pattern'],
      ['plu', '1234567', 'maxLength'],
      ['position', -1, 'minimum'],
      ['productionValue', 1.5, 'type'],
      ['maxConcurrent', 'x', 'type'],
      ['duration', '25:00', 'pattern'],
      ['validFrom', 'yesterday', 'format'],
      ['colors', { text: 'redredd' }, 'pattern'],
      ['conversionRatio', 0, 'minimum'],
      ['scaleType', 'heavy', 'enum'],
      ['dining', { feePercentage: 101 }, 'maximum'],
      ['barcodes', [{ value: 'a' }, { value: 'a' }], 'incorrect'],
      ['barcodes', [{ value: '' }], 'minLength'],
      ['categoryIds', ['zz'], 'minLength'],
      ['categoryIds', [hex(new ObjectId()), hex(new ObjectId())].map((id, index, list) => (index === 1 ? list[0]! : id)), 'incorrect'],
      ['attributeIds', ['a b'], 'pattern'],
      ['externalUrl', 'javascript:alert(1)', 'format'],
      ['externalUrl', 'https://user:pw@example.test/x', 'format'],
      ['externalUrl', 'not a url', 'format'],
      ['components', [{ productId: 'aaaaaaaaaaaaaaaaaaaaaaaa', quantity: 1 }, { productId: 'aaaaaaaaaaaaaaaaaaaaaaaa', quantity: 2 }], 'incorrect'],
      ['gallery', [{ imageId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, { imageId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }], 'incorrect'],
      ['internalFileName', 'a\nb', 'pattern'],
      ['places', [{ placeId: hex(own()) }, { placeId: hex(own()) }], 'incorrect'],
      ['prices', [{ priceListId: 'l', currency: 'EUR', taxId: 't' }], 'required'],
      ['prices', [{ priceListId: 'l', currency: 'eur', taxId: 't', gross: 1 }], 'pattern'],
      ['prices', [{ priceListId: 'l', currency: 'EUR', taxId: 't', gross: -1 }], 'minimum'],
      ['prices', [{ priceListId: 'l', currency: 'EUR', taxId: 't', gross: 1, weekDays: [7] }], 'maximum'],
      ['prices', [{ priceListId: 'l', currency: 'EUR', taxId: 't', gross: 1, dailyFrom: '09:0x' }], 'pattern'],
      ['prices', [{ priceListId: 'l', currency: 'EUR', taxId: 't', gross: 1, discount: 101 }], 'maximum'],
      ['suppliers', [{ contactId: hex(new ObjectId()) }, { contactId: hex(new ObjectId()) }].map((item, _index, list) => list[0]!), 'incorrect'],
      ['components', [{ productId: hex(new ObjectId()), quantity: 0 }], 'minimum'],
      ['menu', [{ categoryId: hex(new ObjectId()), quantity: 0 }], 'minimum'],
      ['modifierChoices', [{ categoryId: hex(new ObjectId()), freeQuantity: 1, priceRule: 'middle' }], 'enum'],
      ['modularPriceRule', 'median', 'enum'],
      ['gallery', [{ imageId: hex(new ObjectId()) }, { imageId: 'x' }], 'minLength'],
      ['stock', { [hex(own())]: { [hex(new ObjectId())]: { min: -1 } } }, 'minimum'],
      ['printStations', { zz: [] }, 'format'],
      ['shipping', { width: -1 }, 'minimum'],
      ['modifier', { type: 'both' }, 'enum'],
      ['isModifier', 'yes', 'type'],
    ];
    for (const [field, value, issue] of bad) {
      const reply = failure(await post({ name: { it: 'x' }, [field]: value }));
      assert.equal(reply.status, 422, field);
      assert.ok((reply.details as Array<{ issue: string }>).some((detail) => detail.issue === issue), `${field} ${JSON.stringify(reply.details)}`);
    }
    assert.equal(failure(await post({ name: { it: 'x' }, description: { it: 'a'.repeat(300_000) } })).status, 413);
    assert.equal(failure(await post({ name: { it: 'x'.repeat(151) } })).status, 422);
    assert.equal(failure(await post({ name: { it: 'x' }, shortName: { it: 'x'.repeat(19) } })).status, 422);
    assert.equal(failure(await post({ name: { it: 'x' }, shipping: JSON.parse('{"__proto__": 1}') as never })).status, 422);
  });

  it('checks the languages, the brand, the categories, the attributes, the units and the places', async () => {
    assert.deepEqual(failure(await post({ name: { en: 'x' } })).details, [{ field: 'name.en', issue: 'incorrect' }, { field: 'name.it', issue: 'required' }]);
    assert.deepEqual(failure(await post({ name: { it: 'x' }, shortName: { en: 'x' }, description: { en: 'x' }, shortDescription: { en: 'x' } })).details, ['shortName.en', 'description.en', 'shortDescription.en'].map((field) => ({ field, issue: 'incorrect' })));
    const brand = legacyCategory({ name: { it: 'Marca' } });
    await db.brands.insertOne({ _id: brand['_id'], name: { it: 'Marca' }, placesAvailability: [], status: true });
    const category = legacyCategory();
    const trashedCategory = legacyCategory({ trash: true });
    await db.categories.insertMany([category, trashedCategory]);
    const group = await db.attributes.insertOne({ _id: new ObjectId(), name: { it: 'Colore' }, attributes: [{ id: 'att-1', name: { it: 'Rosso' } }, { id: 7 }, 'x'], updateDate: new Date() });
    assert.ok(group.acknowledged);
    const reply = failure(
      await post({
        name: { it: 'x' },
        brandId: hex(new ObjectId()),
        categoryIds: [hex(category['_id'] as ObjectId), hex(trashedCategory['_id'] as ObjectId), hex(new ObjectId())],
        attributeIds: ['att-1', 'att-9'],
        loadUnit: 'kg',
        unloadUnit: 'pz',
        places: [{ placeId: hex(own()), productionCenterId: 'pc-1' }, { placeId: hex(other()), productionCenterId: 'pc-9' }, { placeId: hex(new ObjectId()) }],
      }),
    );
    assert.deepEqual(fields(reply).sort(), ['attributeIds.1', 'brandId', 'categoryIds.1', 'categoryIds.2', 'loadUnit', 'places.1.productionCenterId', 'places.2.placeId'].sort());
    const ok = await create({ brandId: hex(brand['_id'] as ObjectId), categoryIds: [hex(category['_id'] as ObjectId)], attributeIds: ['att-1'], loadUnit: 'pz', unloadUnit: 'pz', places: [{ placeId: hex(own()), position: 2, productionCenterId: 'pc-1', favorite: true, favoriteHandheld: true }, { placeId: hex(other()) }] });
    assert.equal(ok.body.data.brandId, hex(brand['_id'] as ObjectId));
    assert.deepEqual(ok.body.data.categoryIds, [hex(category['_id'] as ObjectId)]);
    assert.deepEqual(ok.body.data.places, [{ placeId: hex(own()), favorite: true, favoriteHandheld: true, position: 2, productionCenterId: 'pc-1' }, { placeId: hex(other()), favorite: false, favoriteHandheld: false, position: null, productionCenterId: null }]);
    const document = (await stored(ok.body.data.id))!;
    assert.deepEqual([document['brandId'], document['categories']], [brand['_id'], [category['_id']]]);
    assert.ok((document['placesAvailability'] as Document[])[0]!['position'] instanceof Int32);
    assert.deepEqual(document['attributes'], ['att-1']);
  });

  it('checks the modifiers, the bill of materials, the menus, the suppliers, the prices, the image and the gallery', async () => {
    const modifier = await seed({ variant: { status: true, type: 'p' } });
    const plainProduct = await seed();
    const trashed = await seed({ trash: true });
    const category = legacyCategory();
    await db.categories.insertOne(category);
    const supplier = new ObjectId();
    const customer = new ObjectId();
    const contacts = ctx.databases.group(gid(), 'cluster0').collection('contacts');
    await contacts.insertMany([{ _id: supplier, supplier: true, trash: false }, { _id: customer, supplier: false, trash: false }]);
    const missing = hex(new ObjectId());
    const reply = failure(
      await post({
        name: { it: 'x' },
        requiredModifierIds: [hex(modifier), hex(plainProduct), hex(trashed), missing],
        modifierIds: [hex(plainProduct)],
        excludedModifierIds: [missing],
        modifierCategoryIds: [missing],
        components: [{ productId: hex(plainProduct), quantity: 1 }, { productId: hex(modifier), quantity: 1 }, { productId: hex(trashed), quantity: 1 }],
        menu: [{ categoryId: hex(category['_id'] as ObjectId), quantity: 1, productIds: [hex(plainProduct), hex(modifier)] }, { categoryId: missing, quantity: 1 }],
        modifierChoices: [{ categoryId: hex(category['_id'] as ObjectId), freeQuantity: 1, priceRule: 'highest', productIds: [hex(plainProduct), hex(modifier)] }],
        suppliers: [{ contactId: hex(supplier) }, { contactId: hex(customer) }, { contactId: missing }],
        image: { imageId: missing },
        gallery: [{ imageId: missing }],
      }),
    );
    assert.deepEqual(fields(reply).sort(), [
      'components.1.productId', 'components.2.productId', 'excludedModifierIds.0', 'gallery.0.imageId', 'image', 'menu.0.productIds.1', 'menu.1.categoryId', 'modifierCategoryIds.0', 'modifierChoices.0.productIds.0', 'modifierIds.0',
      'requiredModifierIds.1', 'requiredModifierIds.2', 'requiredModifierIds.3', 'suppliers.1.contactId', 'suppliers.2.contactId',
    ].sort());
    assert.deepEqual(
      failure(await post({ name: { it: 'x' }, prices: [{ priceListId: listId, currency: 'EUR', taxId, gross: 1 }, { priceListId: 'zz', currency: 'GBP', taxId: 'nope', net: 1 }, { id: 'same', priceListId: listId, currency: 'EUR', taxId, net: 1 }, { id: 'same', priceListId: listId, currency: 'EUR', taxId, net: 2 }] })).details,
      [{ field: 'prices.1.priceListId', issue: 'incorrect' }, { field: 'prices.1.currency', issue: 'incorrect' }, { field: 'prices.1.taxId', issue: 'incorrect' }, { field: 'prices.3.id', issue: 'incorrect' }],
    );
    const imageId = await seedImage(db, gid());
    const ok = await create({
      requiredModifierIds: [hex(modifier)],
      components: [{ productId: hex(plainProduct), quantity: 1.5, waste: 5 }],
      menu: [{ categoryId: hex(category['_id'] as ObjectId), quantity: 2, course: 1, productIds: [hex(plainProduct)] }, { categoryId: hex(category['_id'] as ObjectId), quantity: 1 }],
      modifierChoices: [{ categoryId: hex(category['_id'] as ObjectId), freeQuantity: 1.5, priceRule: 'lowest', productIds: [hex(modifier)] }],
      modularPriceRule: 'average',
      suppliers: [{ contactId: hex(supplier), code: 'F-1', name: 'Fornitore', minQuantity: 2, deliveryTime: 3, deliveryTimeUnit: 'months', favorite: true, priceLists: [{ id: 'pl-1', price: 1.5, discount1: 5 }] }],
      image: { imageId: hex(imageId) },
      gallery: [{ imageId: hex(imageId) }],
    });
    const data = ok.body.data;
    assert.deepEqual(data.components, [{ productId: hex(plainProduct), quantity: 1.5, waste: 5 }]);
    assert.deepEqual(data.menu, [{ categoryId: hex(category['_id'] as ObjectId), quantity: 2, course: 1, productIds: [hex(plainProduct)] }, { categoryId: hex(category['_id'] as ObjectId), quantity: 1, course: null, productIds: [] }]);
    assert.deepEqual(data.modifierChoices, [{ categoryId: hex(category['_id'] as ObjectId), freeQuantity: 1.5, priceRule: 'lowest', productIds: [hex(modifier)] }]);
    assert.equal(data.modularPriceRule, 'average');
    assert.deepEqual(data.suppliers, [{ contactId: hex(supplier), code: 'F-1', name: 'Fornitore', minQuantity: 2, deliveryTime: 3, deliveryTimeUnit: 'months', favorite: true, priceLists: [{ id: 'pl-1', price: 1.5, discount1: 5, discount2: null, discount3: null }] }]);
    assert.equal(data.image._id, hex(imageId));
    assert.equal(data.gallery.length, 1);
    const document = (await stored(data.id))!;
    assert.deepEqual(document['variantsRequired'], [modifier]);
    assert.deepEqual(plain(document['modularBundle']), { priceRule: 'avarage' });
    assert.deepEqual(plain(document['bundleProducts']), [{ _id: hex(plainProduct), quantity: 1.5, waste: 5 }]);
    assert.deepEqual(plain(document['selectableVariantsBundleProducts']), [{ categoryId: hex(category['_id'] as ObjectId), freeQt: 1.5, priceType: 'l', products: [{ _id: hex(modifier) }] }]);
    assert.deepEqual(plain((document['selectableBundleProducts'] as Document[])[0]), { categoryId: hex(category['_id'] as ObjectId), quantity: 2, exit: 1, products: [{ _id: hex(plainProduct) }] });
    assert.ok(((document['selectableBundleProducts'] as Document[])[0]!['quantity']) instanceof Int32);
    assert.deepEqual(document['prices'], []);
    const media = (document['medias'] as Document)['images'] as Document;
    assert.deepEqual(Object.keys(media), ['main', 'gallery']);
    assert.deepEqual(plain(document['suppliers']), [{ id: hex(supplier), code: 'F-1', name: 'Fornitore', minQt: 2, deliveryTime: 3, deliveryTimeUnit: 'months', favorite: true, companyLists: [{ id: 'pl-1', price: 1.5, discount1: 5, discount2: null, discount3: null }] }]);
  });

  it('checks the print stations and the stock of the places', async () => {
    const unknown = hex(new ObjectId());
    const reply = failure(
      await post({
        name: { it: 'x' },
        printStations: { [hex(own())]: ['st-1', 'zz'], [unknown]: ['st-1'], [hex(other())]: [] },
        counterPrintStations: { [hex(own())]: ['st-2'] },
        stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1 }, bbbbbbbbbbbbbbbbbbbbbbbb: { min: 1 } }, [unknown]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1 } } },
      }),
    );
    assert.deepEqual(fields(reply).sort(), [`printStations.${hex(own())}.1`, `printStations.${unknown}`, `stock.${hex(own())}.bbbbbbbbbbbbbbbbbbbbbbbb`, `stock.${unknown}`].sort());
    const ok = await create({
      printStations: { [hex(own())]: ['st-1'] },
      counterPrintStations: { [hex(own())]: ['st-2'], [hex(other())]: [] },
      stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1, max: 9.5, location: 'A1' } } },
    });
    assert.deepEqual(ok.body.data.printStations, { [hex(own())]: ['st-1'] });
    assert.deepEqual(ok.body.data.counterPrintStations, { [hex(own())]: ['st-2'], [hex(other())]: [] });
    assert.deepEqual(ok.body.data.stock, { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { quantity: null, min: 1, max: 9.5, location: 'A1' } } });
    const document = (await stored(ok.body.data.id))!;
    assert.deepEqual(plain(document['quantity']), { [`__${hex(own())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1, max: 9.5, location: 'A1' } } });
    assert.deepEqual(plain(document['printStations']), { [`__${hex(own())}`]: ['st-1'] });
  });

  it('refuses the fields of a function the group does not have and never shows them', async () => {
    await features(NONE);
    try {
      const created = await create({});
      const keys = Object.keys(created.body.data);
      for (const hidden of ['plu', 'favoriteHandheld', 'duration', 'maxConcurrent', 'availability', 'featured', 'modifier', 'requiredModifierIds', 'modifierIds', 'scaleType', 'loadUnit', 'unloadUnit', 'conversionRatio', 'colors', 'dining', 'printStations', 'counterPrintStations', 'stock', 'costs', 'modifierChoices', 'image', 'gallery', 'internalFileName', 'externalUrl']) {
        assert.ok(!keys.includes(hidden), hidden);
      }
      assert.ok(Array.isArray(created.body.data.menu) && Array.isArray(created.body.data.barcodes));
      const attempts: Array<[Document, string[]]> = [
        [{ plu: '1', favoriteHandheld: true, duration: '01:00', maxConcurrent: 2, availability: { pos: true, warehouse: true, scales: true, ecommerce: true }, featured: true }, ['plu', 'favoriteHandheld', 'duration', 'maxConcurrent', 'availability.pos', 'availability.warehouse', 'availability.scales', 'availability.ecommerce', 'featured']],
        [{ requiredModifierIds: [], modifierIds: [], excludedModifierIds: [], modifierCategoryIds: [], modifierChoices: [], scaleType: 'piece', loadUnit: 'pz', unloadUnit: 'pz', conversionRatio: 1 }, ['requiredModifierIds', 'modifierIds', 'excludedModifierIds', 'modifierCategoryIds', 'modifierChoices', 'scaleType', 'loadUnit', 'unloadUnit', 'conversionRatio']],
        [{ colors: { text: '#000000', background: '#000000' }, dining: { halfPortion: true }, printStations: {}, counterPrintStations: {}, stock: {}, image: null, gallery: [], internalFileName: 'x', externalUrl: 'https://example.test' }, ['colors.text', 'colors.background', 'dining.halfPortion', 'printStations', 'counterPrintStations', 'stock', 'image', 'gallery', 'internalFileName', 'externalUrl']],
        [{ type: 'service', isModifier: true, barcodes: [{ value: 'a', loadQuantity: 1 }], places: [{ placeId: hex(own()), favoriteHandheld: true }], menu: [{ categoryId: hex(new ObjectId()), quantity: 1, course: 2 }] }, ['type', 'isModifier', 'barcodes.0.loadQuantity', 'places.0.favoriteHandheld', 'menu', 'menu.0.course', 'menu.0.categoryId']],
      ];
      for (const [attempt, expected] of attempts) {
        const reply = failure(await post({ name: { it: 'x' }, ...attempt }));
        assert.deepEqual(fields(reply).sort(), [...expected].sort());
        const patched = fields(failure(await patch(created.body.data.id, attempt)));
        for (const field of expected.filter((entry) => entry !== 'menu.0.categoryId' && entry !== 'menu')) {
          assert.ok(patched.includes(field), `${field} ${JSON.stringify(patched)}`);
        }
      }
      // The flags that need no function are accepted.
      assert.equal((await patch(created.body.data.id, { noDiscount: true, integrations: { yellgo: true }, code: 'Z' })).status, 200);
      for (const [feature, field, type] of [['services', 'type', 'service'], ['tobaccosGamesMonopoly', 'type', 'tobaccos'], ['tobaccosGamesMonopoly', 'type', 'games'], ['tobaccosGamesMonopoly', 'type', 'monopoly']] as const) {
        assert.deepEqual(failure(await post({ name: { it: 'x' }, [field]: type })).details, [{ field, issue: 'notAllowed' }], `${feature} ${type}`);
        await features({ [feature]: true });
        assert.equal((await post({ name: { it: 'x' }, [field]: type })).status, 201);
        await features({ [feature]: false });
      }
      // Each function alone shows only its own fields.
      await features({ cash: true });
      assert.deepEqual((await call(sa(), 'GET', one(created.body.data.id))).body.data.availability, { pos: true });
      await features({ cash: false, warehouse: true });
      assert.deepEqual((await call(sa(), 'GET', one(created.body.data.id))).body.data.availability, { warehouse: false });
    } finally {
      await features(ALL);
    }
    await reset();
  });
});

describe('products: reads', () => {
  it('reads the dirty shapes of the real data tolerantly', async () => {
    await reset();
    const modifier = new ObjectId();
    const dirty = await seed({
      type: undefined,
      name: { it: 'Sporco', en: 5, xx1: 'no' },
      shortName: 'testo',
      description: undefined,
      code: null,
      plu: undefined,
      time: null,
      max: Number.NaN,
      scaleType: Number.NaN,
      productionValue: new Double(Number.NaN),
      position: 'x',
      simpleCost: Number.NaN,
      measureConversionRatio: Number.NaN,
      variant: { status: undefined, type: 'zz' },
      availability: undefined,
      integrations: undefined,
      roomsSettings: { halfPortion: 'si', percentageFee: Number.NaN },
      colors: { pos: { text: 'red' } },
      shippingInfo: 'no',
      brandId: 'not an id',
      categories: [new ObjectId(), 'bad', 5, 'aaaaaaaaaaaaaaaaaaaaaaaa'],
      attributes: ['a', 4],
      variantsRequired: [modifier, 'x'],
      barcode: [{ value: '1', qtLoad: Number.NaN }, { value: 5 }, 7, { qtSale: 1 }],
      suppliers: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', delivetyTime: 4, deliveryTimeUnit: 'weeks', companyLists: [{ id: 'l', price: Number.NaN }, 5] }, 'x'],
      bundleProducts: [{ _id: modifier, quantity: Number.NaN }, { quantity: 1 }, null],
      selectableBundleProducts: [{ categoryId: new ObjectId(), quantity: 2, exit: Number.NaN, products: [{ _id: modifier }, {}] }, { products: 'no' }],
      selectableVariantsBundleProducts: [{ categoryId: new ObjectId(), freeQt: Number.NaN, priceType: 'x', products: [] }],
      modularBundle: { priceRule: 'avarage' },
      quantity: { [`__${hex(own())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 5, min: Number.NaN, max: 'x', location: 4 }, bad: {}, __bbbbbbbbbbbbbbbbbbbbbbbb: 4 }, __zz: {}, [`__${hex(other())}`]: 'no' },
      lastAveragePrice: { lastSupplierId: 'bbbbbbbbbbbbbbbbbbbbbbbb', total: { lastPrice: 2, averagePrice: Number.NaN }, suppliers: { bbbbbbbbbbbbbbbbbbbbbbbb: { lastPrice: 3 }, other: 'x' } },
      medias: { images: { main: { _id: 'i1', basename: 'a.png' }, gallery: [{ _id: 'g1', basename: 'g.png' }, 4], internalFileName: 5, externalUrl: 'https://a.test/x' } },
      startDate: 'text',
      endDate: new Date('2026-05-01T10:00:00Z'),
      prices: [
        legacyPrice({ price: Number.NaN, taxed: Number.NaN, tax: Number.NaN, taxData: { id: 7 }, discount: 'x', startDate: new Date('2026-01-01T10:00:00Z'), endDate: '2026-02-01T10:00:00.000Z', startTimeDaily: '9:00', endTimeDaily: '10:30', weekDays: [1, 7, 'x', 3.5, 0], fromQt: null, maxQtSell: Number.NaN }),
        legacyPrice({ id: undefined, listId: undefined, currency: 4, taxData: undefined, startDate: 'garbage', endDate: '' }),
        'no',
      ],
      featured: undefined,
      status: 'yes',
      trash: undefined,
      insertDate: undefined,
      updateDate: 'x',
    });
    const reply = await call(sa(), 'GET', one(dirty));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const data = reply.body.data;
    assert.deepEqual([data.type, data.family, data.name, data.shortName, data.description, data.code, data.plu, data.enabled, data.createdAt, data.updatedAt, data.trashed, data.featured], [null, 'products', { it: 'Sporco' }, {}, {}, null, null, false, null, null, false, false]);
    assert.deepEqual([data.duration, data.maxConcurrent, data.productionValue, data.position, data.simpleCost, data.conversionRatio, data.scaleType, data.brandId], [null, null, null, null, null, null, null, null]);
    assert.deepEqual([data.availability, data.integrations, data.colors, data.shipping], [{ pos: false, warehouse: false, scales: false, ecommerce: false }, { floodOrders: false, yellgo: false, leggimenu: false }, { text: null, background: null }, { width: null, height: null, depth: null, weight: null }]);
    assert.deepEqual(data.dining, { halfPortion: false, feePercentage: null, hiddenOnHandheld: false, affiliatedMenu: false, reversePrint: false });
    assert.deepEqual([data.categoryIds.length, data.attributeIds, data.requiredModifierIds, data.modifierIds], [2, ['a'], [hex(modifier)], []]);
    assert.deepEqual(data.barcodes, [{ value: '1', loadQuantity: null, saleQuantity: null }]);
    assert.deepEqual(data.suppliers, [{ contactId: 'bbbbbbbbbbbbbbbbbbbbbbbb', code: null, name: null, minQuantity: null, deliveryTime: 4, deliveryTimeUnit: null, favorite: false, priceLists: [{ id: 'l', price: null, discount1: null, discount2: null, discount3: null }] }, { contactId: null, code: null, name: null, minQuantity: null, deliveryTime: null, deliveryTimeUnit: null, favorite: false, priceLists: [] }].slice(0, 1));
    assert.deepEqual(data.components, [{ productId: hex(modifier), quantity: null, waste: null }]);
    assert.deepEqual(data.menu.map((choice: { course: unknown; productIds: string[]; quantity: unknown }) => [choice.quantity, choice.course, choice.productIds.length]), [[2, null, 1], [null, null, 0]]);
    assert.deepEqual(data.modifierChoices.map((choice: { freeQuantity: unknown; priceRule: unknown }) => [choice.freeQuantity, choice.priceRule]), [[null, null]]);
    assert.equal(data.modularPriceRule, 'average');
    assert.deepEqual(data.stock, { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { quantity: 5, min: null, max: null, location: null } } });
    assert.deepEqual(data.costs, { last: 2, average: null, weightedAverage: null, lastSupplierId: 'bbbbbbbbbbbbbbbbbbbbbbbb', bySupplier: { bbbbbbbbbbbbbbbbbbbbbbbb: { last: 3, average: null, weightedAverage: null }, other: { last: null, average: null, weightedAverage: null } } });
    assert.deepEqual([data.image._id, data.gallery.map((item: { _id: string }) => item._id), data.internalFileName, data.externalUrl], ['i1', ['g1'], null, 'https://a.test/x']);
    assert.deepEqual([data.validFrom, data.validTo], [null, '2026-05-01T10:00:00.000Z']);
    assert.deepEqual(data.prices[0], {
      id: 'price-1', priceListId: 'list-1', currency: 'EUR', taxId: null, tax: { rate: null, department: null, description: null, vatNature: null }, net: null, gross: null, discount: null,
      validFrom: '2026-01-01T10:00:00.000Z', validTo: '2026-02-01T10:00:00.000Z', dailyFrom: null, dailyTo: '10:30', weekDays: [1, 0], fromQuantity: null, maxSaleQuantity: null,
    });
    assert.deepEqual([data.prices[1].id, data.prices[1].priceListId, data.prices[1].currency, data.prices[1].tax, data.prices[1].validFrom, data.prices[1].validTo, data.prices.length], [null, null, null, null, null, null, 2]);
    // The version does not change when the warehouse moves the quantity, and does when the catalog fields change.
    await db.products.updateOne({ _id: dirty }, { $inc: { [`quantity.__${hex(own())}.__aaaaaaaaaaaaaaaaaaaaaaaa.value`]: 3 } });
    assert.equal(tag(await call(sa(), 'GET', one(dirty))), tag(reply));
    await db.products.updateOne({ _id: dirty }, { $set: { [`quantity.__${hex(own())}.__aaaaaaaaaaaaaaaaaaaaaaaa.min`]: 4 } });
    assert.notEqual(tag(await call(sa(), 'GET', one(dirty))), tag(reply));
    // A company administrator does not see the place of the other company.
    const asCa = await call(ca(), 'GET', one(dirty));
    assert.deepEqual([Object.keys(asCa.body.data.stock), asCa.body.data.editable, asCa.body.data.placeEditable], [[hex(own())], false, true]);
    const bare = new ObjectId();
    await db.products.insertOne({ _id: bare });
    const empty = (await call(sa(), 'GET', one(bare))).body.data;
    assert.deepEqual([empty.prices, empty.barcodes, empty.components, empty.categoryIds, empty.places, empty.name, empty.enabled, empty.family], [[], [], [], [], [], {}, false, 'products']);
    assert.deepEqual([empty.menu, empty.modifierChoices, empty.stock], [[], [], {}]);
  });

  it('reads a modifier, a service and the three forms of the availability', async () => {
    await reset();
    const modifier = await seed({ variant: { status: true, type: 'm', pricePercentagePlus: 10, pricePercentageMinus: new Double(5.5), description: { it: 'Senza' } }, type: 'service', time: '01:30', max: 3 });
    const data = (await call(sa(), 'GET', one(modifier))).body.data;
    assert.deepEqual([data.family, data.isModifier, data.duration, data.maxConcurrent], ['modifiers', true, '01:30', 3]);
    assert.deepEqual(data.modifier, { type: 'remove', pricePercentagePlus: 10, pricePercentageMinus: 5.5, description: { it: 'Senza' } });
    assert.ok(!('requiredModifierIds' in data) && !('menu' in data) && !('modularPriceRule' in data) && !('modifierChoices' in data));
    const service = await seed({ type: 'service' });
    assert.equal((await call(sa(), 'GET', one(service))).body.data.family, 'services');
    const tgm = await seed({ type: 'games' });
    assert.equal((await call(sa(), 'GET', one(tgm))).body.data.family, 'tgm');
    const places = await seed({ placesAvailability: [placeEntry(own(), { favorite: true, favoriteHandheld: true, position: new Int32(3), productionCenterId: 'pc-1' }), other(), 7, { id: 'text' }, { id: own(), position: 9 }] });
    const shown = (await call(sa(), 'GET', one(places))).body.data;
    assert.deepEqual(shown.places, [{ placeId: hex(own()), favorite: true, favoriteHandheld: true, position: 3, productionCenterId: 'pc-1' }, { placeId: hex(other()), favorite: false, favoriteHandheld: false, position: null, productionCenterId: null }]);
    assert.deepEqual([shown.editable, shown.placeEditable], [true, true]);
    const asPa = (await call(pa(), 'GET', one(places))).body.data;
    assert.deepEqual([asPa.places.map((entry: { placeId: string }) => entry.placeId), asPa.editable, asPa.placeEditable], [[hex(own())], false, true]);
    assert.equal(failure(await call(pa(), 'GET', one(await seed({ placesAvailability: [placeEntry(other())] })))).status, 404);
    assert.equal(failure(await call(pa(), 'GET', one(await seed({ placesAvailability: [other()] })))).status, 404);
    assert.equal((await call(pa(), 'GET', one(await seed({ placesAvailability: [own()] })))).body.data.editable, true);
    assert.equal((await call(pa(), 'GET', one(await seed({ placesAvailability: undefined })))).body.data.editable, false);
    assert.equal((await call(pa(), 'GET', one(await seed({ placesAvailability: null })))).body.data.editable, false);
  });
});

describe('products: list', () => {
  const ids = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { id: string }) => item.id);
  const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { name: string | null }) => item.name);

  it('lists the families, with the filters, the search, the order and the cursor', async () => {
    await reset();
    const category = new ObjectId();
    const supplier = new ObjectId();
    const zeta = await seed({ name: { it: 'Zeta' }, code: 'Z-1', categories: [category], favorite: true, updateDate: new Date('2026-01-03T00:00:00Z'), barcode: [{ value: '111', qtSale: 1 }], suppliers: [{ id: supplier }] });
    const alfa = await seed({ name: { en: 'Alfa (50%)' }, code: undefined, status: false, updateDate: new Date('2026-01-02T00:00:00Z'), type: 'exempt' });
    const beta = await seed({ name: { it: 'Beta' }, code: 'B-2', updateDate: new Date('2026-01-01T00:00:00Z'), type: undefined, placesAvailability: [placeEntry(own())] });
    const service = await seed({ name: { it: 'Taglio' }, type: 'service' });
    const sigaretta = await seed({ name: { it: 'Marlboro' }, type: 'tobaccos' });
    const modifier = await seed({ name: { it: 'Senza ghiaccio' }, variant: { status: true, type: 'm' } });
    const trashed = await seed({ name: { it: 'Cestinato' }, trash: true, trashDate: new Date() });
    const trashedService = await seed({ name: { it: 'Cestinato servizio' }, type: 'service', trash: true });
    const listed = (query = '') => call(sa(), 'GET', `${base()}${query}`);
    assert.deepEqual(ids(await listed()), [zeta, alfa, beta].map(hex));
    assert.deepEqual(ids(await listed('?family=services')), [hex(service)]);
    assert.deepEqual(ids(await listed('?family=tgm')), [hex(sigaretta)]);
    assert.deepEqual(ids(await listed('?family=modifiers')), [hex(modifier)]);
    assert.deepEqual(ids(await listed('?trashed=true&family=products')), [hex(trashed)]);
    assert.deepEqual(ids(await listed('?trashed=true&family=services')), [hex(trashedService)]);
    assert.deepEqual(ids(await listed('?trashed=true')), [hex(trashedService), hex(trashed)]);
    assert.deepEqual(ids(await listed('?trashed=false')), [zeta, alfa, beta].map(hex));
    assert.deepEqual(names(await listed('?sort=name')), ['Alfa (50%)', 'Beta', 'Zeta']);
    assert.deepEqual(names(await listed('?sort=-name')), ['Zeta', 'Beta', 'Alfa (50%)']);
    assert.deepEqual(ids(await listed('?sort=code')), [alfa, beta, zeta].map(hex));
    assert.deepEqual(ids(await listed('?sort=updatedAt')), [beta, alfa, zeta].map(hex));
    assert.deepEqual(ids(await listed('?q=eta')), [zeta, beta].map(hex));
    assert.deepEqual(ids(await listed('?q=%2850%25%29')), [hex(alfa)]);
    assert.deepEqual(ids(await listed('?q=.*')), []);
    assert.deepEqual(ids(await listed('?q=B-2')), [hex(beta)]);
    assert.deepEqual(ids(await listed('?q=b-2')), []);
    assert.deepEqual(ids(await listed('?q=111')), [hex(zeta)]);
    assert.deepEqual(ids(await listed(`?categoryId=${hex(category)}`)), [hex(zeta)]);
    assert.deepEqual(ids(await listed(`?supplierId=${hex(supplier)}`)), [hex(zeta)]);
    assert.deepEqual(ids(await listed(`?placeId=${hex(own())}`)), [zeta, alfa, beta].map(hex));
    assert.deepEqual(ids(await listed(`?placeId=${hex(other())}`)), [zeta, alfa].map(hex));
    assert.deepEqual(ids(await listed('?favorite=true')), [hex(zeta)]);
    assert.deepEqual(ids(await listed('?favorite=false')), [alfa, beta].map(hex));
    assert.deepEqual(ids(await listed('?enabled=false')), [hex(alfa)]);
    assert.deepEqual(ids(await listed('?enabled=true')), [zeta, beta].map(hex));
    const first = await listed('?limit=2');
    assert.deepEqual([ids(first), first.body.page.limit], [[zeta, alfa].map(hex), 2]);
    const second = await listed(`?limit=2&cursor=${first.body.page.next as string}`);
    assert.deepEqual([ids(second), second.body.page.next], [[hex(beta)], null]);
    assert.equal(failure(await listed('?limit=2&cursor=garbage!')).status, 422);
    assert.equal(failure(await listed('?limit=101')).status, 422);
    assert.equal(failure(await listed('?family=other')).status, 422);
    assert.equal(failure(await listed('?sort=price')).status, 422);
    assert.equal(failure(await listed('?categoryId=x')).status, 422);
    // A row is compact: never the whole document.
    assert.deepEqual(Object.keys(first.body.data[0]).sort(), ['categoryIds', 'code', 'editable', 'enabled', 'family', 'id', 'lastSupplierId', 'lastSupplierName', 'name', 'placeEditable', 'price', 'stock', 'trashed', 'trashedAt', 'type', 'updatedAt']);
  });

  it('shows the stock, the composite mark and the price of the default price list', async () => {
    await reset();
    const rows = async () => (await call(sa(), 'GET', base())).body.data.map((item: { id: string; stock: unknown; price: unknown; lastSupplierId: unknown }) => [item.id, item.stock, item.price, item.lastSupplierId]);
    const supplier = new ObjectId();
    const moving = await seed({
      availability: { pos: true, warehouse: true },
      quantity: { [`__${hex(own())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 2.5 }, __bbbbbbbbbbbbbbbbbbbbbbbb: { value: new Double(1.25) }, __cccccccccccccccccccccccc: { value: 'x' } }, [`__${hex(other())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 4 } } },
      prices: [legacyPrice({ id: 'a', listId: listId, price: 10, tax: 22, discount: 10 }), legacyPrice({ id: 'b', listId: listId, fromQt: 5, price: 1 })],
      bundleProducts: [{ _id: new ObjectId(), quantity: 1 }],
      lastAveragePrice: { lastSupplierId: supplier },
    });
    const idle = await seed({ availability: { pos: true, warehouse: false }, quantity: { [`__${hex(own())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 9 } } }, prices: [legacyPrice({ listId: 'other-list' })] });
    const service = await seed({ type: 'service', availability: { warehouse: true }, prices: [legacyPrice({ listId, price: Number.NaN, taxed: 5, tax: 22 }), legacyPrice({ listId, startDate: '2026-01-01T00:00:00Z' })] });
    const empty = await seed({ availability: { warehouse: true }, quantity: {}, prices: [legacyPrice({ listId, price: 10, tax: Number.NaN, taxData: { value: 10 }, discount: undefined })] });
    const none = await seed({ availability: { warehouse: true }, quantity: undefined, prices: undefined });
    const byId = new Map((await rows()).map((row: unknown[]) => [row[0], row]));
    assert.deepEqual(byId.get(hex(moving)), [hex(moving), { quantity: 7.75, composite: true }, 10.98, hex(supplier)]);
    assert.deepEqual(byId.get(hex(idle)), [hex(idle), { quantity: null, composite: false }, null, null]);
    assert.deepEqual(byId.get(hex(none)), [hex(none), { quantity: null, composite: false }, null, null]);
    // Whatever the quantity says, a service has no stock; a net price that is not a number falls back on the gross one.
    assert.deepEqual(await call(sa(), 'GET', `${base()}?family=services`).then((reply) => reply.body.data.map((item: { stock: unknown; price: unknown }) => [item.stock, item.price])), [[{ quantity: null, composite: false }, 5]]);
    assert.deepEqual(byId.get(hex(empty)), [hex(empty), { quantity: null, composite: false }, 11, null]);
    // A place administrator adds up only the quantity of his own place, and a group without the warehouse function shows none.
    const asPa = await call(pa(), 'GET', base());
    assert.deepEqual(asPa.body.data.find((item: { id: string }) => item.id === hex(moving)).stock, { quantity: 3.75, composite: true });
    await features({ warehouse: false });
    assert.deepEqual((await call(sa(), 'GET', base())).body.data.map((item: { stock: { quantity: unknown } }) => item.stock.quantity), [null, null, null, null]);
    await features({ warehouse: true });
  });

  it('shows a company or place administrator only the products for every place or for one of his places', async () => {
    await reset();
    const everyone = await seed({ name: { it: 'Per tutti' } });
    const mine = await seed({ name: { it: 'Mio' }, placesAvailability: [placeEntry(own())] });
    const shared = await seed({ name: { it: 'Condiviso' }, placesAvailability: [placeEntry(own()), placeEntry(other())] });
    const theirs = await seed({ name: { it: 'Altrui' }, placesAvailability: [placeEntry(other())] });
    const historical = await seed({ name: { it: 'Storico' }, placesAvailability: [own()] });
    const historicalTheirs = await seed({ name: { it: 'Storico altrui' }, placesAvailability: [other()] });
    const wanted = [everyone, mine, shared, historical].map(hex).sort();
    for (const actor of [ca(), pa()]) {
      const reply = await call(actor, 'GET', base());
      assert.deepEqual(ids(reply).sort(), wanted);
      assert.deepEqual(reply.body.data.map((item: { name: string; editable: boolean }) => [item.name, item.editable]).sort(), [['Condiviso', false], ['Mio', true], ['Per tutti', false], ['Storico', true]]);
      assert.deepEqual(ids(await call(actor, 'GET', `${base()}?placeId=${hex(own())}`)).sort(), wanted);
      assert.deepEqual(failure(await call(actor, 'GET', `${base()}?placeId=${hex(other())}`)), { status: 403, code: 'FORBIDDEN', details: [{ field: 'placeId', issue: 'notAllowed' }] });
      assert.equal(failure(await call(actor, 'GET', one(theirs))).status, 404);
      assert.equal(failure(await call(actor, 'GET', one(historicalTheirs))).status, 404);
    }
  });
});

describe('products: modification', () => {
  /** The top level keys of two stored documents that differ (by value). */
  const changed = (before: Document, after: Document): string[] => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(plain(before[key])) !== JSON.stringify(plain(after[key]))).sort();

  it('changes only the fields it owns and keeps every other key of the document', async () => {
    await reset();
    const id = await seed({ measureLoad: 'zz', localQuantity: 4, customKey: { a: 1 }, integrations: { floodOrders: false, easyappear: true, yellgo: false, leggimenu: false, other: 1 }, lastAveragePrice: { lastSupplierId: null, total: { lastPrice: 7 }, suppliers: {} }, quantity: { [`__${hex(own())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 9, min: 1, max: 5, location: 'A' } } }, tags: ['x'], related: [1], parentId: null, roomsSettings: { halfPortion: false, other: 'k' } });
    const before = (await stored(id))!;
    const mark = world.office.activity.entries.length;
    const reply = await patch(hex(id), {
      enabled: false,
      code: 'NEW',
      plu: '34',
      favorite: true,
      favoriteHandheld: true,
      generic: true,
      toCheck: true,
      noDiscount: true,
      featured: true,
      position: 5,
      productionValue: 6,
      availability: { warehouse: true, ecommerce: true },
      integrations: { yellgo: true },
      validFrom: '2026-02-01T10:00:00Z',
      validTo: null,
      scaleType: 'piece',
      loadUnit: 'pz',
      conversionRatio: 3,
      colors: { background: '#ABCDEF' },
      dining: { halfPortion: true, feePercentage: 7.5 },
      simpleCost: 2,
      shipping: { weight: 1.5 },
      duration: '00:45',
      maxConcurrent: 4,
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = (await stored(id))!;
    assert.deepEqual(changed(before, after), ['availability', 'code', 'colors', 'enabled', 'favorite', 'favoriteHandheld', 'featured', 'generic', 'integrations', 'measureConversionRatio', 'measureLoad', 'noDiscount', 'plu', 'position', 'productionValue', 'roomsSettings', 'scaleType', 'shippingInfo', 'simpleCost', 'startDate', 'status', 'time', 'toCheck', 'updateDate', 'max'].filter((key) => key !== 'enabled').sort());
    assert.deepEqual(plain([after['localQuantity'], after['customKey'], after['tags'], after['related']]), [4, { a: 1 }, ['x'], [1]]);
    assert.deepEqual(plain(after['integrations']), { floodOrders: false, easyappear: true, yellgo: true, leggimenu: false, other: 1 });
    assert.deepEqual(plain(after['roomsSettings']), { halfPortion: true, other: 'k', percentageFee: 7.5 });
    assert.deepEqual(plain(after['availability']), { pos: true, warehouse: true, scales: false, ecommerce: true });
    assert.deepEqual(plain(after['quantity']), plain(before['quantity']));
    assert.deepEqual(plain(after['lastAveragePrice']), plain(before['lastAveragePrice']));
    assert.ok(after['position'] instanceof Int32 && after['scaleType'] instanceof Int32 && after['startDate'] instanceof Date && after['updateDate'] instanceof Date);
    assert.ok((after['updateDate'] as Date).getTime() > (before['updateDate'] as Date).getTime());
    assert.deepEqual([after['status'], after['endDate'], after['time'], after['max']], [false, null, '00:45', new Int32(4)]);
    const data = reply.body.data;
    assert.deepEqual([data.enabled, data.code, data.plu, data.validFrom, data.scaleType, data.conversionRatio, data.colors, data.simpleCost, data.shipping.weight, data.duration, data.maxConcurrent], [false, 'NEW', '34', '2026-02-01T10:00:00.000Z', 'piece', 3, { text: '#000000', background: '#abcdef' }, 2, 1.5, '00:45', 4]);
    assert.equal(tag(reply), tag(await call(sa(), 'GET', one(id))));
    assert.equal(log('product.updated', mark).length, 1);
    const changes = log('product.updated', mark)[0]!.changes as Array<{ field: string }>;
    assert.ok(changes.some((entry) => entry.field === 'code') && !changes.some((entry) => entry.field === 'name'));
    // Sending what the product already has changes nothing: no write, no event, same version and same date.
    const again = await patch(hex(id), { code: 'NEW', availability: { warehouse: true }, position: 5, validFrom: '2026-02-01T10:00:00.000Z', shipping: { weight: 1.5 }, colors: { background: '#abcdef' } }, sa(), reply);
    assert.equal(again.status, 200);
    assert.equal(tag(again), tag(reply));
    assert.equal(log('product.updated', mark).length, 1);
    assert.deepEqual((await stored(id))!['updateDate'], after['updateDate']);
  });

  it('merges the texts by language, keeps the required one and refuses a version that is not the current one', async () => {
    await reset();
    const id = await seed({ name: { it: 'Acqua', xx: 'ignored', en: 'Water' }, description: { it: 'Naturale' } });
    const reply = await patch(hex(id), { name: { it: 'Acqua minerale' }, shortName: { it: 'Acqua' }, description: { it: null }, shortDescription: { it: 'Corta' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const document = (await stored(id))!;
    assert.deepEqual(plain(document['name']), { it: 'Acqua minerale', xx: 'ignored', en: 'Water' });
    assert.deepEqual([plain(document['description']), plain(document['shortName']), plain(document['shortDescription'])], [{}, { it: 'Acqua' }, { it: 'Corta' }]);
    assert.deepEqual(failure(await patch(hex(id), { name: { it: null } })).details, [{ field: 'name.it', issue: 'required' }]);
    assert.deepEqual(failure(await patch(hex(id), { name: { en: 'x', it: 'y' }, shortName: { de: 'x' } })).details, [{ field: 'name.en', issue: 'incorrect' }, { field: 'shortName.de', issue: 'incorrect' }]);
    // The version of another moment, a trashed product and an id of another group.
    const stale = await call(sa(), 'GET', one(id));
    await patch(hex(id), { code: 'change' });
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { code: 'late' }, { 'if-match': tag(stale) })).status, 412);
    assert.equal(failure(await call(sa(), 'PATCH', one(id), { code: 'late' }, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    assert.equal(failure(await call(sa(), 'PATCH', one(new ObjectId()), { code: 'late' }, { 'if-match': tag(stale) })).status, 404);
    const gone = await seed({ trash: true });
    assert.deepEqual(failure(await patch(hex(gone), { code: 'x' })), { status: 409, code: 'CONFLICT', details: [{ field: 'trashed', issue: 'incorrect' }] });
    assert.equal(failure(await call(sa(), 'POST', `${one(gone)}/duplicate`, undefined, { 'idempotency-key': randomUUID() })).status, 409);
  });

  it('replaces the lists, judging only what a write adds', async () => {
    await reset();
    const category = legacyCategory();
    const second = legacyCategory();
    await db.categories.insertMany([category, second]);
    const modifier = await seed({ variant: { status: true, type: 'p' } });
    const member = await seed({ name: { it: 'Componente' } });
    const gone = new ObjectId();
    const id = await seed({ categories: [gone, category['_id'], 'cccccccccccccccccccccccc'], attributes: ['old-attribute', 7], variants: [gone], barcode: [{ value: 'b1', qtLoad: 2, qtSale: 1, extra: 'k' }, { value: 'b2' }] });
    // What the product already has is never judged again, even when it no longer exists.
    const kept = await patch(hex(id), { categoryIds: [hex(gone), hex(category['_id'] as ObjectId), 'cccccccccccccccccccccccc'], attributeIds: ['old-attribute'], modifierIds: [hex(gone)] });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.deepEqual((await stored(id))!['attributes'], ['old-attribute']);
    const reply = await patch(hex(id), {
      categoryIds: [hex(second['_id'] as ObjectId)],
      modifierIds: [hex(modifier)],
      requiredModifierIds: [hex(modifier)],
      excludedModifierIds: [],
      modifierCategoryIds: [hex(category['_id'] as ObjectId)],
      barcodes: [{ value: 'b2', saleQuantity: 3 }, { value: 'b1', loadQuantity: 2, saleQuantity: 1 }],
      attributeIds: [],
      components: [{ productId: hex(member), quantity: 2 }],
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const document = (await stored(id))!;
    assert.deepEqual([document['categories'], document['variants'], document['variantsRequired'], document['variantsExcluded'], document['variantsCategories'], document['attributes']], [[second['_id']], [modifier], [modifier], [], [category['_id']], []]);
    assert.deepEqual(plain(document['barcode']), [{ value: 'b2', qtLoad: null, qtSale: 3 }, { value: 'b1', qtLoad: 2, qtSale: 1, extra: 'k' }]);
    assert.deepEqual(plain(document['bundleProducts']), [{ _id: hex(member), quantity: 2, waste: null }]);
    assert.deepEqual(failure(await patch(hex(id), { categoryIds: [hex(new ObjectId())], modifierIds: [hex(member)], components: [{ productId: hex(modifier), quantity: 1 }] })).details, [{ field: 'categoryIds.0', issue: 'incorrect' }, { field: 'modifierIds.0', issue: 'incorrect' }, { field: 'components.0.productId', issue: 'incorrect' }]);
  });

  it('refuses the fields of a modifier on a product and the other way round, and a change of the family', async () => {
    await reset();
    const plainProduct = await seed();
    const modifier = await seed({ variant: { status: true, type: 'pm' } });
    assert.deepEqual(failure(await patch(hex(plainProduct), { modifier: { type: 'add' } })).details, [{ field: 'modifier', issue: 'notAllowed' }]);
    assert.deepEqual(fields(failure(await patch(hex(modifier), { requiredModifierIds: [], modifierIds: [], excludedModifierIds: [], modifierCategoryIds: [], menu: [], modifierChoices: [], modularPriceRule: null }))).sort(), ['excludedModifierIds', 'menu', 'modifierCategoryIds', 'modifierChoices', 'modifierIds', 'modularPriceRule', 'requiredModifierIds']);
    assert.deepEqual(failure(await patch(hex(plainProduct), { isModifier: true })).details, [{ field: 'isModifier', issue: 'immutable' }]);
    assert.deepEqual(failure(await patch(hex(modifier), { isModifier: false })).details, [{ field: 'isModifier', issue: 'immutable' }]);
    assert.equal((await patch(hex(modifier), { isModifier: true, modifier: { type: 'info', pricePercentagePlus: 12.5, pricePercentageMinus: null, description: { it: 'Nota' } }, components: [] })).status, 200);
    assert.deepEqual(plain((await stored(modifier))!['variant']), { status: true, type: 'i', pricePercentagePlus: 12.5, description: { it: 'Nota' } });
    const created = await create({ isModifier: true, modifier: { type: 'add', pricePercentagePlus: 10, pricePercentageMinus: 5 }, type: 'tobaccos' });
    assert.deepEqual([created.body.data.family, created.body.data.modifier], ['modifiers', { type: 'add', pricePercentagePlus: 10, pricePercentageMinus: 5, description: {} }]);
    assert.deepEqual(plain((await stored(created.body.data.id))!['variant']), { status: true, type: 'p', pricePercentagePlus: 10, pricePercentageMinus: 5, description: {} });
    assert.equal(failure(await post({ name: { it: 'x' }, modifier: { type: 'add' } })).status, 422);
    // The type moves a product between the families.
    assert.equal((await patch(hex(plainProduct), { type: 'service' })).body.data.family, 'services');
    assert.equal((await patch(hex(plainProduct), { type: 'games' })).body.data.family, 'tgm');
  });
});

describe('products: prices', () => {
  const price = (overrides: Document = {}) => ({ priceListId: listId, currency: 'EUR', taxId, ...overrides });

  it('computes the other amount, writes the tax copy of the group and keeps the order and the keys of a rule', async () => {
    await reset();
    const id = await seed({ prices: [legacyPrice({ id: 'keep', listId, taxData: { ...legacyPrice()['taxData'], id: taxId, extra: 'k' }, price: 5, taxed: 6.1, note: 'k' }), legacyPrice({ id: undefined, listId, taxData: { id: taxId, value: 10, department: 1, description: null, natura: null }, price: 1, taxed: 1.1, tax: 10 }), legacyPrice({ id: 'stale', listId: 'gone-list', currency: 'USD', taxData: { id: 'gone-tax', value: 4 } })] });
    const before = (await call(sa(), 'GET', one(id))).body.data.prices;
    // The whole list sent back as it was changes nothing.
    const same = await patch(hex(id), { prices: before.map((rule: Document) => ({ id: rule['id'], priceListId: rule['priceListId'], currency: rule['currency'], taxId: rule['taxId'], gross: rule['gross'] })) });
    assert.equal(same.status, 422, 'a rule with a tax rate that is gone cannot be sent as it is while its price list and tax are judged anew');
    const reply = await patch(hex(id), {
      prices: [
        price({ id: 'keep', gross: 24.4, discount: 10, validFrom: '2026-03-01T08:00:00Z', validTo: '2026-03-31T00:00:00Z', dailyFrom: '08:00', dailyTo: '12:30', weekDays: [1, 2, 3], fromQuantity: 2, maxSaleQuantity: 10 }),
        price({ net: 10 }),
        price({ id: 'stale', priceListId: 'gone-list', currency: 'USD', taxId: 'gone-tax', gross: 3 }),
        price({ gross: 1.2345, net: 99, fromQuantity: null }),
      ],
    });
    assert.equal(reply.status, 422, 'a new rule cannot name a tax rate that is gone');
    const done = await patch(hex(id), {
      prices: [
        price({ id: 'keep', gross: 24.4, discount: 10, validFrom: '2026-03-01T08:00:00Z', validTo: '2026-03-31T00:00:00Z', dailyFrom: '08:00', dailyTo: '12:30', weekDays: [1, 2, 3], fromQuantity: 2, maxSaleQuantity: 10 }),
        price({ net: 10 }),
        price({ gross: 1.2345, net: 99, fromQuantity: null }),
      ],
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const rules = done.body.data.prices;
    assert.deepEqual(rules.map((rule: Document) => [rule['id'] === 'keep', rule['net'], rule['gross']]), [[true, 20, 24.4], [false, 10, 12.2], [false, 1.01188525, 1.2345]]);
    assert.deepEqual(rules[0], { id: 'keep', priceListId: listId, currency: 'EUR', taxId, tax: { rate: 22, department: 1, description: null, vatNature: null }, net: 20, gross: 24.4, discount: 10, validFrom: '2026-03-01T08:00:00.000Z', validTo: '2026-03-31T00:00:00.000Z', dailyFrom: '08:00', dailyTo: '12:30', weekDays: [1, 2, 3], fromQuantity: 2, maxSaleQuantity: 10 });
    assert.deepEqual([rules[1].fromQuantity, rules[2].fromQuantity, rules[1].weekDays, rules[1].discount, typeof rules[1].id], [1, null, [], 0, 'string']);
    const document = (await stored(id))!;
    const stage = (document['prices'] as Document[])[0]!;
    assert.deepEqual(plain({ ...stage, id: undefined }), { listId, price: 20, taxed: 24.4, tax: 22, taxData: { id: taxId, value: 22, department: 1, description: null, natura: null, extra: 'k' }, discount: 10, currency: 'EUR', startDate: '2026-03-01T08:00:00.000Z', endDate: '2026-03-31T00:00:00.000Z', startTimeDaily: '08:00', endTimeDaily: '12:30', weekDays: [1, 2, 3], fromQt: 2, maxQtSell: 10, note: 'k' });
    assert.ok(typeof stage['startDate'] === 'string');
    // A rule the legacy wrote with no id is matched by its place; it gets an id.
    const legacy = await patch(hex(id), { prices: [price({ id: 'keep', gross: 24.4, discount: 10, validFrom: '2026-03-01T08:00:00Z', validTo: '2026-03-31T00:00:00Z', dailyFrom: '08:00', dailyTo: '12:30', weekDays: [1, 2, 3], fromQuantity: 2, maxSaleQuantity: 10 }), price({ net: 10 })] });
    assert.equal(legacy.body.data.prices.length, 2);
    assert.equal(failure(await patch(hex(id), { prices: [price({ gross: 1, id: 'x' }), price({ gross: 1, id: 'x' })] })).status, 422);
  });

  it('writes the prices with the tax of the group, rewrites a rule that changes, and judges the lists only for what a request adds', async () => {
    await reset();
    const id = await seed({ prices: [legacyPrice({ id: 'old', listId: 'gone-list', currency: 'USD', taxData: { id: 'gone-tax', value: 4, department: null, description: null, natura: null }, tax: 4, taxed: 10.4, price: 10 })] });
    // A rule that is exactly the stored one is not judged again.
    const same = await patch(hex(id), { prices: [{ id: 'old', priceListId: 'gone-list', currency: 'USD', taxId: 'gone-tax', gross: 10.4 }] });
    assert.equal(failure(same).status, 422);
    const body = (await call(sa(), 'GET', one(id))).body.data;
    assert.deepEqual(body.prices[0].taxId, 'gone-tax');
    const kept = await patch(hex(id), { prices: [] });
    assert.equal(kept.status, 200);
    assert.deepEqual(kept.body.data.prices, []);
    const modest = await patch(hex(id), { prices: [price({ net: 0 }), price({ gross: 0 })] });
    assert.deepEqual(modest.body.data.prices.map((rule: Document) => [rule['net'], rule['gross']]), [[0, 0], [0, 0]]);
    // Gross wins when both are sent.
    const both = await patch(hex(id), { prices: [price({ gross: 122, net: 1 })] });
    assert.deepEqual([both.body.data.prices[0].net, both.body.data.prices[0].gross], [100, 122]);
  });
});

describe('products: places, print stations and stock', () => {
  it('changes the places, with the production centers, and rewrites the historical form', async () => {
    await reset();
    const id = await seed({ placesAvailability: [own(), placeEntry(other(), { position: 2, extra: 'k' }), 7] });
    const first = await patch(hex(id), { places: [{ placeId: hex(own()), favorite: true, productionCenterId: 'pc-1', position: 1 }, { placeId: hex(other()), position: 2 }] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const document = (await stored(id))!;
    assert.deepEqual(plain(document['placesAvailability']), [{ id: hex(own()), favorite: true, favoriteHandheld: false, position: 1, productionCenterId: 'pc-1' }, { id: hex(other()), favorite: false, favoriteHandheld: false, position: 2, productionCenterId: null, extra: 'k' }]);
    assert.deepEqual(failure(await patch(hex(id), { places: [{ placeId: hex(other()), productionCenterId: 'pc-1' }] })).details, [{ field: 'places.0.productionCenterId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await patch(hex(id), { places: [{ placeId: hex(new ObjectId()) }] })).details, [{ field: 'places.0.placeId', issue: 'incorrect' }]);
    const empty = await patch(hex(id), { places: [] });
    assert.deepEqual(empty.body.data.places, []);
    assert.deepEqual((await stored(id))!['placesAvailability'], []);
    // The same list again is no change, in whatever order.
    const places = [{ placeId: hex(other()), favorite: true }, { placeId: hex(own()) }];
    const set = await patch(hex(id), { places });
    const mark = world.office.activity.entries.length;
    const reversed = await patch(hex(id), { places: [...places].reverse() }, sa(), set);
    assert.equal(tag(reversed), tag(set));
    assert.equal(log('product.updated', mark).length, 0);
    const historical = await seed({ placesAvailability: [own()] });
    assert.equal((await patch(hex(historical), { places: [{ placeId: hex(own()) }] })).status, 200);
    assert.deepEqual(plain((await stored(historical))!['placesAvailability']), [{ id: hex(own()), favorite: false, favoriteHandheld: false, position: null, productionCenterId: null }]);
  });

  it('sets and removes the print stations and the stock leaves of a place without touching the rest', async () => {
    await reset();
    const key = `__${hex(own())}`;
    const id = await seed({ printStations: { [key]: ['st-1'], __zz: ['x'] }, printStationsNoRooms: { [key]: ['st-2'] }, quantity: { [key]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 8, min: 1, max: 2, location: 'A', extra: 'k' } }, __dddddddddddddddddddddddd: 'junk' } });
    const reply = await patch(hex(id), {
      printStations: { [hex(own())]: ['st-2', 'st-1'], [hex(other())]: [] },
      counterPrintStations: { [hex(own())]: null, [hex(other())]: null },
      stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 3, location: null } } },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const document = (await stored(id))!;
    assert.deepEqual(plain(document['printStations']), { [key]: ['st-2', 'st-1'], __zz: ['x'] });
    assert.deepEqual(plain(document['printStationsNoRooms']), {});
    assert.deepEqual(plain(document['quantity']), { [key]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 8, min: 3, max: 2, location: null, extra: 'k' } }, __dddddddddddddddddddddddd: 'junk' });
    // A stock that is already as asked is no change.
    const again = await patch(hex(id), { stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 3, max: 2, location: null } } }, printStations: { [hex(own())]: ['st-2', 'st-1'] } }, sa(), reply);
    assert.equal(tag(again), tag(reply));
    // The quantity cannot be written, and a storage that does not exist is refused.
    assert.equal(failure(await patch(hex(id), { stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { value: 9 } as never } } })).status, 422);
    assert.deepEqual(failure(await patch(hex(id), { stock: { [hex(own())]: { eeeeeeeeeeeeeeeeeeeeeeee: { min: 1 } } } })).details, [{ field: `stock.${hex(own())}.eeeeeeeeeeeeeeeeeeeeeeee`, issue: 'incorrect' }]);
    // A stock of a storage of a place the product has no stock in is created along the path.
    const fresh = await seed({ quantity: undefined });
    assert.equal((await patch(hex(fresh), { stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 2 } } } })).status, 200);
    assert.deepEqual(plain((await stored(fresh))!['quantity']), { [key]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { min: 2 } } });
    // A document whose stock is something else than an object is not written (it is a conflict, never a database error).
    const junk = await seed({ quantity: 'no' });
    assert.equal(failure(await patch(hex(junk), { stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 2 } } } })).status, 409);
  });
});

describe('products: images and bill of materials', () => {
  it('sets and removes the image, the gallery, the file name and the address without touching the rest of the media', async () => {
    await reset();
    const first = await seedImage(db, gid());
    const second = await seedImage(db, gid(), { basename: 'altra-9f8e7d6c.png' });
    const id = await seed({ medias: { images: { internalFileName: 'x.png', other: 'kept' }, extra: 'kept' } });
    const reply = await patch(hex(id), { image: { imageId: hex(first) }, gallery: [{ imageId: hex(first) }, { imageId: hex(second) }], externalUrl: 'https://example.test/a.png?token=1' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    let media = (await stored(id))!['medias'] as Document;
    assert.deepEqual(Object.keys(media.images).sort(), ['externalUrl', 'gallery', 'internalFileName', 'main', 'other']);
    assert.equal(media['extra'], 'kept');
    assert.equal(reply.body.data.gallery.length, 2);
    const gallery = (media['images'] as Document)['gallery'] as Document[];
    // The same list again, and one with an element taken away, keep the descriptors the product has.
    const same = await patch(hex(id), { gallery: [{ imageId: hex(first) }, { imageId: hex(second) }], image: { imageId: hex(first) } }, sa(), reply);
    assert.equal(tag(same), tag(reply));
    okay(await patch(hex(id), { gallery: [{ imageId: hex(second) }] }));
    media = (await stored(id))!['medias'] as Document;
    assert.deepEqual(plain(((media['images'] as Document)['gallery'] as Document[])[0]), plain(gallery[1]));
    const removed = await patch(hex(id), { image: null, gallery: [], internalFileName: null, externalUrl: null });
    assert.equal(removed.status, 200);
    media = (await stored(id))!['medias'] as Document;
    assert.deepEqual(plain(media['images']), { gallery: [], other: 'kept' });
    assert.deepEqual([removed.body.data.image, removed.body.data.gallery, removed.body.data.internalFileName], [null, [], null]);
    assert.deepEqual(failure(await patch(hex(id), { image: { imageId: hex(new ObjectId()) } })).details, [{ field: 'image', issue: 'incorrect' }]);
    assert.deepEqual(failure(await patch(hex(id), { gallery: [{ imageId: hex(first) }, { imageId: hex(new ObjectId()) }] })).details, [{ field: 'gallery.1.imageId', issue: 'incorrect' }]);
    // A product whose media is missing or is not what the legacy writes gets the smallest container that holds what is set.
    for (const [overrides, expected] of [
      [{ medias: undefined }, { images: { main: true } }],
      [{ medias: { images: 'no', keep: 1 } }, { images: { main: true }, keep: 1 }],
      [{ medias: 5 }, { images: { main: true } }],
    ] as const) {
      const odd = await seed(overrides);
      okay(await patch(hex(odd), { image: { imageId: hex(first) } }));
      const written = (await stored(odd))!['medias'] as Document;
      assert.deepEqual(JSON.parse(JSON.stringify(written, (key, value: unknown) => (key === 'main' ? true : value))), expected);
      // Removing from a place that is not there writes nothing.
      const nothing = await seed(overrides);
      const kept = await patch(hex(nothing), { image: null, internalFileName: null, gallery: [] });
      assert.equal(kept.status, 200);
    }
    // A place administrator has no image of the library; a group without media accepts none (see the functions test).
    const own1 = await seed({ placesAvailability: [placeEntry(own())] });
    assert.deepEqual(failure(await patch(hex(own1), { image: { imageId: hex(first) } }, pa())).details, [{ field: 'image', issue: 'incorrect' }]);
    const companyImage = await seedImage(db, gid(), { companyId: fixtureId('company', 1) });
    okay(await patch(hex(own1), { image: { imageId: hex(companyImage) } }, ca()));
  });

  it('refuses a cycle of bills of materials, however long, and a product inside its own bill', async () => {
    await reset();
    const c = await seed({ name: { it: 'C' } });
    const b = await seed({ name: { it: 'B' }, bundleProducts: [{ _id: c, quantity: 1 }] });
    const a = await seed({ name: { it: 'A' }, bundleProducts: [{ _id: b, quantity: 1 }] });
    assert.deepEqual(failure(await patch(hex(c), { components: [{ productId: hex(a), quantity: 1 }] })).details, [{ field: 'components.0.productId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await patch(hex(c), { components: [{ productId: hex(c), quantity: 1 }] })).details, [{ field: 'components.0.productId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await patch(hex(b), { components: [{ productId: hex(new ObjectId()), quantity: 1 }, { productId: hex(a), quantity: 1 }] })).details, [{ field: 'components.0.productId', issue: 'incorrect' }]);
    assert.deepEqual(failure(await patch(hex(b), { components: [{ productId: hex(c), quantity: 1 }, { productId: hex(a), quantity: 1 }] })).details, [{ field: 'components.1.productId', issue: 'incorrect' }]);
    assert.equal((await patch(hex(a), { components: [{ productId: hex(b), quantity: 1 }, { productId: hex(c), quantity: 2 }] })).status, 200);
    // The walk reads the bills the legacy wrote in any shape: ids as text, elements that are not ones, a list that is not a list.
    const junk = await seed({ name: { it: 'J' }, bundleProducts: 'no' });
    const text = await seed({ name: { it: 'T' }, bundleProducts: [{ _id: hex(a), quantity: 1 }, null, { _id: 5 }, { quantity: 1 }] });
    assert.equal(failure(await patch(hex(c), { components: [{ productId: hex(junk), quantity: 1 }, { productId: hex(text), quantity: 1 }] })).status, 422);
    assert.equal((await patch(hex(c), { components: [{ productId: hex(junk), quantity: 1 }] })).status, 200);
    // A bill that reaches the same product by two ways is not a cycle.
    const d = await seed({ name: { it: 'D' }, bundleProducts: [{ _id: c, quantity: 1 }, { _id: b, quantity: 1 }] });
    assert.equal((await call(sa(), 'GET', one(d))).status, 200);
  });
});

describe('products: company and place administrators', () => {
  const restricted = [['company administrator', ca], ['place administrator', pa]] as const;
  const wide = { name: { it: 'Nuovo' }, code: 'X', enabled: false, favorite: true, brandId: null, categoryIds: [], prices: [], barcodes: [], position: 1 };

  it('creates only products for places of the perimeter, with at least one', async () => {
    for (const [, actor] of restricted) {
      assert.deepEqual(failure(await post({ name: { it: 'x' } }, actor())).details, [{ field: 'places', issue: 'notAllowed' }]);
      assert.deepEqual(failure(await post({ name: { it: 'x' }, places: [] }, actor())).details, [{ field: 'places', issue: 'notAllowed' }]);
      assert.deepEqual(failure(await post({ name: { it: 'x' }, places: [{ placeId: hex(other()) }, { placeId: hex(own()) }] }, actor())).details, [{ field: 'places.0.placeId', issue: 'notAllowed' }]);
      assert.deepEqual(failure(await post({ name: { it: 'x' }, places: [{ placeId: hex(own()) }], printStations: { [hex(other())]: [] } }, actor())).details, [{ field: `printStations.${hex(other())}`, issue: 'notAllowed' }]);
      assert.deepEqual(failure(await post({ name: { it: 'x' }, places: [{ placeId: hex(own()) }], stock: { [hex(other())]: {} } }, actor())).details, [{ field: `stock.${hex(other())}`, issue: 'notAllowed' }]);
      const created = await post({ ...wide, places: [{ placeId: hex(own()), position: 2 }], printStations: { [hex(own())]: ['st-1'] }, stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1 } } } }, actor());
      okay(created, 201);
      assert.deepEqual([created.body.data.editable, created.body.data.placeEditable, created.body.data.places.length], [true, true, 1]);
      assert.equal((await call(actor(), 'POST', `${one(created.body.data.id)}/duplicate`, undefined, { 'idempotency-key': randomUUID() })).status, 201);
    }
  });

  it('modifies a product wholly his own, inside the perimeter', async () => {
    for (const [, actor] of restricted) {
      const created = await post({ name: { it: 'Mio' }, places: [{ placeId: hex(own()) }] }, actor());
      const id = created.body.data.id as string;
      okay(await patch(id, { name: { it: 'Mio 2' }, code: 'C', prices: [{ priceListId: listId, currency: 'EUR', taxId, gross: 1 }], favorite: true, printStations: { [hex(own())]: ['st-1'] }, stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { max: 3 } } } }, actor()));
      assert.deepEqual(failure(await patch(id, { places: [] }, actor())).details, [{ field: 'places', issue: 'notAllowed' }]);
      assert.deepEqual(failure(await patch(id, { places: [{ placeId: hex(other()) }] }, actor())).details, [{ field: 'places.0.placeId', issue: 'notAllowed' }]);
      assert.deepEqual(failure(await patch(id, { printStations: { [hex(other())]: ['st-9'] } }, actor())).details, [{ field: `printStations.${hex(other())}`, issue: 'notAllowed' }]);
      assert.deepEqual(failure(await patch(id, { counterPrintStations: { [hex(other())]: null } }, actor())).details, [{ field: `counterPrintStations.${hex(other())}`, issue: 'notAllowed' }]);
      assert.deepEqual(failure(await patch(id, { stock: { [hex(other())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1 } } } }, actor())).details, [{ field: `stock.${hex(other())}`, issue: 'notAllowed' }]);
      // It can be shared with a place that is not his only by somebody who is not limited.
      assert.deepEqual(failure(await patch(id, { places: [{ placeId: hex(own()) }, { placeId: hex(other()) }] }, actor())).details, [{ field: 'places.1.placeId', issue: 'notAllowed' }]);
      // A reference to a product or a category he does not reach is judged as one that does not exist.
      const hidden = await seed({ placesAvailability: [placeEntry(other())] });
      const hiddenCategory = legacyCategory({ placesAvailability: [{ id: other(), position: null, productionCenterId: null }] });
      await db.categories.insertOne(hiddenCategory);
      assert.deepEqual(failure(await patch(id, { components: [{ productId: hex(hidden), quantity: 1 }], categoryIds: [hex(hiddenCategory['_id'] as ObjectId)] }, actor())).details, [{ field: 'categoryIds.0', issue: 'incorrect' }, { field: 'components.0.productId', issue: 'incorrect' }]);
      const brand = new ObjectId();
      await db.brands.insertOne({ _id: brand, name: { it: 'Altrui' }, placesAvailability: [other()], status: true });
      assert.deepEqual(failure(await patch(id, { brandId: hex(brand) }, actor())).details, [{ field: 'brandId', issue: 'incorrect' }]);
      assert.equal(failure(await call(actor(), 'DELETE', one(id), undefined, { 'if-match': tag(await call(actor(), 'GET', one(id))) })).status, 409);
    }
  });

  it('changes only the data of his own places on a product that is shared with other places or for every place', async () => {
    for (const [, actor] of restricted) {
      const ownKey = `__${hex(own())}`;
      const shared = await seed({ code: 'S', placesAvailability: [placeEntry(own()), placeEntry(other(), { position: 4 })], printStations: { [ownKey]: ['st-1'], [`__${hex(other())}`]: ['zz'] }, quantity: { [ownKey]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 5, min: 1 } }, [`__${hex(other())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 2, min: 7 } } } });
      const everyone = await seed({ code: 'E' });
      for (const id of [shared, everyone]) {
        const target = hex(id);
        const forbidden = await patch(target, { code: 'NO', favorite: true, favoriteHandheld: true, prices: [], name: { it: 'NO' }, enabled: false, brandId: null }, actor());
        const refused = failure(forbidden);
        assert.deepEqual([refused.status, refused.code], [403, 'FORBIDDEN']);
        assert.deepEqual(fields(refused).sort(), ['brandId', 'code', 'enabled', 'favorite', 'favoriteHandheld', 'name', 'prices']);
        const reading = (await call(actor(), 'GET', one(id))).body.data;
        assert.deepEqual([reading.editable, reading.placeEditable], [false, true]);
      }
      // On the shared product he sets the data of his place, stations and stock leaves, never the ones of the other place.
      const target = hex(shared);
      const mark = world.office.activity.entries.length;
      const done = await patch(target, { places: [{ placeId: hex(own()), favorite: true, position: 9, productionCenterId: 'pc-1' }], printStations: { [hex(own())]: ['st-2'] }, counterPrintStations: { [hex(own())]: ['st-1'] }, stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 2, location: 'B' } } } }, actor());
      okay(done);
      // The event never names a place the actor does not reach.
      assert.equal(log('product.updated', mark).length, 1);
      assert.ok(!JSON.stringify(log('product.updated', mark)).includes(hex(other())));
      const document = (await stored(shared))!;
      assert.deepEqual(plain(document['placesAvailability']), [{ id: hex(other()), favorite: false, favoriteHandheld: false, position: 4, productionCenterId: null }, { id: hex(own()), favorite: true, favoriteHandheld: false, position: 9, productionCenterId: 'pc-1' }]);
      assert.deepEqual(plain(document['printStations']), { [ownKey]: ['st-2'], [`__${hex(other())}`]: ['zz'] });
      assert.deepEqual(plain((document['quantity'] as Document)[`__${hex(other())}`]), { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 2, min: 7 } });
      assert.deepEqual(plain(((document['quantity'] as Document)[ownKey] as Document)['__aaaaaaaaaaaaaaaaaaaaaaaa']), { value: 5, min: 2, location: 'B' });
      assert.deepEqual(done.body.data.places.map((entry: { placeId: string }) => entry.placeId), [hex(own())]);
      assert.deepEqual(Object.keys(done.body.data.stock), [hex(own())]);
      // He can take his place away from a shared product; not from a product that would end up for every place.
      okay(await patch(target, { places: [] }, actor()));
      assert.deepEqual(plain((await stored(shared))!['placesAvailability']), [{ id: hex(other()), favorite: false, favoriteHandheld: false, position: 4, productionCenterId: null }]);
      assert.equal(failure(await call(actor(), 'GET', one(shared))).status, 404);
      // And he can neither limit a product that is for every place nor name a place that is not his.
      assert.deepEqual(failure(await patch(hex(everyone), { places: [{ placeId: hex(own()) }] }, actor())).details, [{ field: 'places', issue: 'notAllowed' }]);
      assert.deepEqual(failure(await patch(hex(everyone), { printStations: { [hex(other())]: ['x'] } }, actor())).details, [{ field: `printStations.${hex(other())}`, issue: 'notAllowed' }]);
      okay(await patch(hex(everyone), { printStations: { [hex(own())]: ['st-1'] }, stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1 } } } }, actor()));
      // Nothing of the whole is his: no duplicate, no trash, no deletion.
      assert.equal(failure(await call(actor(), 'POST', `${one(everyone)}/duplicate`, undefined, { 'idempotency-key': randomUUID() })).status, 403);
      assert.equal(failure(await call(actor(), 'POST', `${one(everyone)}/trash`, undefined, { 'if-match': tag(await call(actor(), 'GET', one(everyone))) })).status, 403);
      assert.deepEqual((await call(actor(), 'POST', `${base()}/trash`, { ids: [hex(everyone), hex(new ObjectId())] })).body.data.results.map((item: { issue: string }) => item.issue), ['forbidden', 'notFound']);
    }
  });
});

describe('products: warnings of the duplicated values', () => {
  it('saves a code, a PLU or a barcode another product uses and says so, naming only the products the caller reaches', async () => {
    await reset();
    const peers: ObjectId[] = [];
    for (let index = 0; index < 7; index += 1) {
      peers.push(await seed({ code: 'DUP', plu: '77', barcode: [{ value: 'B-DUP', qtSale: 1 }, { value: `U-${String(index)}` }] }));
    }
    const hidden = await seed({ code: 'DUP', placesAvailability: [placeEntry(other())] });
    const gone = await seed({ code: 'DUP', trash: true });
    const created = await create({ code: 'DUP', plu: '77', barcodes: [{ value: 'B-DUP' }, { value: 'fresh' }, { value: 'U-3' }] });
    const warnings = created.body.data.warnings as Array<{ field: string; productIds: string[]; others: number; issue: string }>;
    assert.deepEqual(warnings.map((warning) => [warning.field, warning.issue, warning.productIds.length, warning.others]), [['code', 'duplicate', 5, 3], ['plu', 'duplicate', 5, 2], ['barcodes.0', 'duplicate', 5, 2], ['barcodes.2', 'duplicate', 1, 0]]);
    assert.ok(warnings[0]!.productIds.every((id) => peers.map(hex).includes(id)) && !warnings[0]!.productIds.includes(hex(hidden)) && !warnings[0]!.productIds.includes(hex(gone)));
    assert.deepEqual((await call(sa(), 'GET', one(created.body.data.id))).body.data.warnings, warnings);
    // A company administrator is told about the products he reaches only; the others are counted.
    const own1 = await seed({ code: 'MINE', barcode: [], placesAvailability: [placeEntry(own())] });
    await seed({ code: 'MINE', barcode: [], placesAvailability: [placeEntry(other())] });
    const asCa = (await call(ca(), 'GET', one(own1))).body.data.warnings;
    assert.deepEqual(asCa, [{ field: 'code', issue: 'duplicate', productIds: [], others: 1 }]);
    // Empty values are not duplicates, and a change that creates one saves anyway.
    const blank = await create({ code: '', plu: null, barcodes: [{ value: 'U-1' }] });
    assert.deepEqual(blank.body.data.warnings.map((warning: { field: string }) => warning.field), ['barcodes.0']);
    const changed = await patch(created.body.data.id, { code: 'MINE' });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.data.warnings.map((warning: { field: string }) => warning.field), ['code', 'plu', 'barcodes.0', 'barcodes.2']);
    await reset();
  });
});

describe('products: trash, restore, deletion and duplication', () => {
  it('moves a product to the trash and back with its version, keeping it out of the default list', async () => {
    await reset();
    const created = await create({ name: { it: 'Da cestinare' }, code: 'T-1' });
    const id = created.body.data.id as string;
    const mark = world.office.activity.entries.length;
    const stale = await call(sa(), 'GET', one(id));
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/trash`, undefined, { 'if-match': `"${'A'.repeat(43)}"` })).status, 412);
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/restore`, undefined, { 'if-match': tag(stale) })).status, 409);
    const trashed = await call(sa(), 'POST', `${one(id)}/trash`, undefined, { 'if-match': tag(stale) });
    okay(trashed);
    assert.deepEqual([trashed.body.data.trashed, typeof trashed.body.data.trashedAt, trashed.body.data.enabled], [true, 'string', true]);
    const document = (await stored(id))!;
    assert.deepEqual([document['trash'], document['trashDate'] instanceof Date, document['updateDate'] instanceof Date], [true, true, true]);
    assert.equal(log('product.trashed', mark).length, 1);
    assert.deepEqual((await call(sa(), 'GET', base())).body.data, []);
    assert.deepEqual((await call(sa(), 'GET', `${base()}?trashed=true`)).body.data.map((item: { id: string; trashed: boolean }) => [item.id, item.trashed]), [[id, true]]);
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/trash`, undefined, { 'if-match': tag(trashed) })).status, 409);
    const restored = await call(sa(), 'POST', `${one(id)}/restore`, undefined, { 'if-match': tag(trashed) });
    okay(restored);
    assert.deepEqual([restored.body.data.trashed, restored.body.data.trashedAt], [false, null]);
    assert.equal('trashDate' in (await stored(id))!, false);
    assert.equal(log('product.restored', mark).length, 1);
    assert.equal((await call(sa(), 'GET', base())).body.data.length, 1);
    // Only a product in the trash is deleted for good.
    assert.equal(failure(await call(sa(), 'DELETE', one(id), undefined, { 'if-match': tag(restored) })).status, 409);
    const again = await call(sa(), 'POST', `${one(id)}/trash`, undefined, { 'if-match': tag(restored) });
    assert.equal(failure(await call(sa(), 'DELETE', one(id), undefined, { 'if-match': tag(stale) })).status, 412);
    assert.equal((await call(sa(), 'DELETE', one(id), undefined, { 'if-match': tag(again) })).status, 204);
    assert.equal(await db.products.countDocuments({ _id: new ObjectId(id) }), 0);
    assert.equal(log('product.deleted', mark).length, 1);
    assert.equal(failure(await call(sa(), 'GET', one(id))).status, 404);
  });

  it('trashes several products and tells what became of each', async () => {
    await reset();
    const mine = await seed({ placesAvailability: [placeEntry(own())] });
    const shared = await seed({ placesAvailability: [placeEntry(own()), placeEntry(other())] });
    const done = await seed();
    const already = await seed({ trash: true });
    const unknown = new ObjectId();
    const reply = await call(sa(), 'POST', `${base()}/trash`, { ids: [mine, mine, shared, done, already, unknown].map(hex) });
    okay(reply);
    assert.deepEqual(reply.body.data.results, [
      { id: hex(mine), outcome: 'trashed' },
      { id: hex(shared), outcome: 'trashed' },
      { id: hex(done), outcome: 'trashed' },
      { id: hex(already), outcome: 'skipped', issue: 'alreadyTrashed' },
      { id: hex(unknown), outcome: 'skipped', issue: 'notFound' },
    ]);
    assert.equal(failure(await call(sa(), 'POST', `${base()}/trash`, { ids: [] })).status, 422);
    assert.equal(failure(await call(sa(), 'POST', `${base()}/trash`, { ids: ['x'] })).status, 422);
    assert.equal(failure(await call(sa(), 'POST', `${base()}/trash`, { ids: [hex(done)], more: 1 })).status, 422);
    assert.deepEqual((await call(ca(), 'POST', `${base()}/trash`, { ids: [hex(mine), hex(shared)] })).body.data.results.map((item: { issue: string }) => item.issue), ['alreadyTrashed', 'forbidden']);
  });

  it('duplicates a product with the copy rule of the legacy and idempotently', async () => {
    await reset();
    const supplier = new ObjectId();
    const image = await seedImage(db, gid());
    const id = await seed({
      name: { it: 'Birra', en: 'Beer' },
      code: 'BR',
      plu: '5',
      barcode: [{ value: '1' }],
      favorite: true,
      status: false,
      placesAvailability: [placeEntry(own(), { position: 3 })],
      quantity: { [`__${hex(own())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 12, min: 2, max: 20, location: 'X' }, __bbbbbbbbbbbbbbbbbbbbbbbb: 7 }, junk: 4 },
      lastAveragePrice: { lastSupplierId: supplier, total: { lastPrice: 9 }, suppliers: { x: {} } },
      suppliers: [{ id: supplier, code: 'S' }],
      medias: { images: { main: { _id: hex(image), basename: 'a.png' } } },
      tags: ['t'],
      parentId: new ObjectId(),
      integrations: { floodOrders: true, easyappear: true, yellgo: false, leggimenu: true },
      customKey: 'not copied',
    });
    const key = randomUUID();
    const mark = world.office.activity.entries.length;
    const copy = await call(sa(), 'POST', `${one(id)}/duplicate`, undefined, { 'idempotency-key': key });
    okay(copy, 201);
    assert.equal(copy.headers.get('location'), `/v1${base()}/${copy.body.data.id as string}`);
    assert.ok(tag(copy));
    const document = (await stored(copy.body.data.id))!;
    assert.notEqual(hex(document['_id'] as ObjectId), hex(id));
    assert.deepEqual(plain([document['name'], document['code'], document['plu'], document['barcode'], document['status'], document['favorite'], document['trash']]), [{ it: 'Birra (Copy)', en: 'Beer (Copy)' }, '', '', [], false, true, false]);
    assert.deepEqual(plain(document['quantity']), { [`__${hex(own())}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 0, min: 2, max: 20, location: 'X' } } });
    assert.deepEqual(plain(document['lastAveragePrice']), { lastSupplierId: null, total: { year: null, lastPrice: 0, totalN: 0, totalCost: 0, averagePrice: 0, totalQuantity: 0, totalCostQt: 0, weightedAveragePrice: 0 }, suppliers: {} });
    assert.deepEqual(plain([document['tags'], document['related'], document['parentId'], document['integrations'], 'customKey' in document]), [[], [], null, { floodOrders: true, easyappear: false, yellgo: false, leggimenu: true }, false]);
    assert.deepEqual(plain([document['suppliers'], document['medias'], document['placesAvailability']]), [[{ id: hex(supplier), code: 'S' }], { images: { main: { _id: hex(image), basename: 'a.png' } } }, [{ id: hex(own()), favorite: false, favoriteHandheld: false, position: 3, productionCenterId: null }]]);
    assert.ok(document['insertDate'] instanceof Date && !('trashDate' in document));
    assert.equal(copy.body.data.name.it, 'Birra (Copy)');
    const events = log('product.duplicated', mark);
    assert.deepEqual([events.length, events[0]!.metadata], [1, { sourceId: hex(id) }]);
    assert.equal((await call(sa(), 'POST', `${one(id)}/duplicate`, undefined, { 'idempotency-key': key })).body.data.id, copy.body.data.id);
    assert.equal(await db.products.countDocuments({}), 2);
    assert.equal(failure(await call(sa(), 'POST', `${one(id)}/duplicate`)).status, 422);
    assert.equal(failure(await call(sa(), 'POST', `${one(new ObjectId())}/duplicate`, undefined, { 'idempotency-key': randomUUID() })).status, 404);
    // A copy of a copy of a product with no name in a language and a name that is not text.
    const odd = await seed({ name: { it: 'Strano', en: 4 } });
    assert.deepEqual((await call(sa(), 'POST', `${one(odd)}/duplicate`, undefined, { 'idempotency-key': randomUUID() })).body.data.name, { it: 'Strano (Copy)' });
  });
});

describe('products: deletion for good and the trash page', () => {
  /** A product in the trash and the version to delete it with. */
  const trashedProduct = async (overrides: Document = {}) => {
    const id = await seed({ trash: true, trashDate: new Date(), ...overrides });
    return { id, tag: tag(await call(sa(), 'GET', one(id))) };
  };
  const remove = (id: ObjectId, version: string, actor = sa()) => call(actor, 'DELETE', one(id), undefined, { 'if-match': version });

  it('refuses to delete a product something still uses, and lists what uses it', async () => {
    await reset();
    const favoritesBefore = (await groups().findOne({ _id: gid() }))!;
    const target = await trashedProduct();
    const refs: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [];
    const insertProduct = async (overrides: Document) => {
      const referrer = await seed(overrides);
      return { referrer, clean: () => db.products.deleteOne({ _id: referrer }) };
    };
    for (const [kind, overrides] of [
      ['productBundles', { bundleProducts: [{ _id: target.id, quantity: 1 }] }],
      ['productMenus', { selectableBundleProducts: [{ categoryId: new ObjectId(), quantity: 1, products: [{ _id: target.id }] }] }],
      ['productModifierChoices', { selectableVariantsBundleProducts: [{ categoryId: new ObjectId(), freeQt: 1, priceType: 'h', products: [{ _id: target.id }] }] }],
      ['productModifierLists', { variantsExcluded: [hex(target.id)] }],
      ['productModifierLists', { variants: [target.id] }],
      ['productModifierLists', { variantsRequired: [target.id] }],
    ] as const) {
      const { referrer, clean } = await insertProduct(overrides);
      assert.deepEqual(failure(await remove(target.id, target.tag)), { status: 409, code: 'CONFLICT', details: [{ field: `${kind}.${hex(referrer)}`, issue: 'referenced' }] });
      await clean();
    }
    // A product in the trash does not count, and neither does the product itself.
    await seed({ trash: true, bundleProducts: [{ _id: target.id, quantity: 1 }] });
    await db.products.updateOne({ _id: target.id }, { $set: { bundleProducts: [{ _id: target.id, quantity: 1 }] } });
    const retag = tag(await call(sa(), 'GET', one(target.id)));
    const category = legacyCategory({ variants: [target.id] });
    await db.categories.insertOne(category);
    assert.deepEqual(failure(await remove(target.id, retag)).details, [{ field: `categoryModifiers.${hex(category['_id'] as ObjectId)}`, issue: 'referenced' }]);
    await db.categories.deleteMany({});
    const service = await addUser(ctx, world.office, { servicesId: [target.id] });
    assert.deepEqual(failure(await remove(target.id, retag)).details, [{ field: `serviceUsers.${hex(service.id)}`, issue: 'referenced' }]);
    await ctx.databases.common().collection('users').updateOne({ _id: service.id }, { $set: { servicesId: [] } });
    await groups().updateOne({ _id: gid() }, { $set: { productsFavorites: [{ id: 'fav-1', name: 'Preferiti', favorites: [{ _id: target.id, position: 1 }] }] } });
    assert.deepEqual(failure(await remove(target.id, retag)).details, [{ field: 'favorites.fav-1', issue: 'referenced' }]);
    await groups().updateOne({ _id: gid() }, { $set: { productsFavorites: [] } });
    await groups().updateOne({ _id: gid() }, { $set: { promotions: [{ id: 'promo-1', name: 'Promo', status: true, conditions: { products: { ids: [hex(target.id)] } }, actions: {} }, { id: 'promo-2', name: 'Altra', status: true, conditions: {}, actions: { productsIds: [hex(target.id)] } }] } });
    assert.deepEqual(failure(await remove(target.id, retag)).details, [{ field: 'promotions.promo-1', issue: 'referenced' }, { field: 'promotions.promo-2', issue: 'referenced' }]);
    await groups().updateOne({ _id: gid() }, { $set: { promotions: favoritesBefore['promotions'] ?? [], productsFavorites: favoritesBefore['productsFavorites'] ?? [] } });
    assert.equal((await remove(target.id, retag)).status, 204);
    assert.equal(refs.length, 0);
  });

  it('tells a company or place administrator only what he reaches', async () => {
    await reset();
    const target = await trashedProduct({ placesAvailability: [placeEntry(own())] });
    const visible = await seed({ placesAvailability: [placeEntry(own())], bundleProducts: [{ _id: target.id, quantity: 1 }] });
    const hiddenOne = await seed({ placesAvailability: [placeEntry(other())], bundleProducts: [{ _id: target.id, quantity: 1 }] });
    assert.deepEqual(fields(failure(await remove(target.id, target.tag, ca()))), [`productBundles.${hex(visible)}`, 'productBundles']);
    await db.products.deleteMany({ _id: { $in: [visible] } });
    assert.deepEqual(failure(await remove(target.id, target.tag, pa())).details, [{ field: 'productBundles', issue: 'referenced' }]);
    await db.products.deleteMany({ _id: hiddenOne });
    const service = await addUser(ctx, world.office, { servicesId: [target.id] });
    assert.deepEqual(failure(await remove(target.id, target.tag, ca())).details, [{ field: 'serviceUsers', issue: 'referenced' }]);
    await ctx.databases.common().collection('users').updateOne({ _id: service.id }, { $set: { servicesId: [] } });
    assert.equal((await remove(target.id, target.tag, ca())).status, 204);
    // A product that is not wholly his is not his to delete from the trash.
    const shared = await trashedProduct({ placesAvailability: [placeEntry(own()), placeEntry(other())] });
    assert.equal(failure(await remove(shared.id, shared.tag, ca())).status, 403);
    assert.equal(failure(await call(ca(), 'POST', `${one(shared.id)}/restore`, undefined, { 'if-match': shared.tag })).status, 403);
  });

  it('restores, deletes and empties the products from the trash page, each as its own route does', async () => {
    await reset();
    const path = (rest: string, index = 0) => `/groups/${hex(world.group(index).groupId)}/trash/products/${rest}`;
    const mine = await seed({ trash: true, trashDate: new Date(), placesAvailability: [placeEntry(own())] });
    const shared = await seed({ trash: true, placesAvailability: [placeEntry(own()), placeEntry(other())] });
    const live = await seed();
    const used = await seed({ trash: true });
    await seed({ bundleProducts: [{ _id: used, quantity: 1 }] });
    const missing = new ObjectId();
    const mark = world.office.activity.entries.length;
    const restored = await call(sa(), 'POST', path('restore'), { ids: [mine, shared, live, missing].map(hex) });
    okay(restored);
    assert.deepEqual(restored.body.data.results, [{ id: hex(mine), outcome: 'restored' }, { id: hex(shared), outcome: 'restored' }, { id: hex(live), outcome: 'skipped', issue: 'notTrashed' }, { id: hex(missing), outcome: 'skipped', issue: 'notFound' }]);
    assert.equal(log('product.restored', mark).length, 2);
    await db.products.updateMany({ _id: { $in: [mine, shared] } }, { $set: { trash: true } });
    const asCa = await call(ca(), 'POST', path('delete'), { ids: [mine, shared, used].map(hex) });
    assert.deepEqual(asCa.body.data.results, [{ id: hex(mine), outcome: 'deleted' }, { id: hex(shared), outcome: 'skipped', issue: 'forbidden' }, { id: hex(used), outcome: 'skipped', issue: 'forbidden' }]);
    const deleted = await call(sa(), 'POST', path('delete'), { ids: [used, shared].map(hex) });
    assert.deepEqual(deleted.body.data.results, [{ id: hex(used), outcome: 'skipped', issue: 'referenced' }, { id: hex(shared), outcome: 'deleted' }]);
    assert.equal(failure(await call(ca(), 'POST', path('empty'), {})).status, 403);
    const emptied = await call(psa(), 'POST', path('empty'), {});
    okay(emptied);
    assert.deepEqual(emptied.body.data.results, [{ id: hex(used), outcome: 'skipped', issue: 'referenced' }]);
    assert.deepEqual([emptied.body.data.remaining, emptied.body.data.next], [1, null]);
    await db.products.deleteMany({ bundleProducts: { $exists: true, $ne: [] } });
    const finished = await call(psa(), 'POST', path('empty'), {});
    assert.deepEqual([finished.body.data.results.map((item: { outcome: string }) => item.outcome), finished.body.data.remaining], [['deleted'], 0]);
    assert.equal(failure(await call(sa(), 'POST', `/groups/${hex(gid())}/trash/gadgets/restore`, { ids: [hex(live)] })).status, 422);
    assert.equal(failure(await call(world.group(1).sa, 'POST', path('restore'), { ids: [hex(live)] })).status, 404);
    // The emptying goes on from where the last call ended.
    const first = await seed({ trash: true });
    const second = await seed({ trash: true });
    const [low, high] = [first, second].sort((left, right) => (left.toHexString() < right.toHexString() ? -1 : 1));
    const resumed = await call(psa(), 'POST', path('empty'), { after: hex(low!) });
    assert.deepEqual(resumed.body.data.results, [{ id: hex(high!), outcome: 'deleted' }]);
    assert.equal(await db.products.countDocuments({ _id: low! }), 1);
  });
});

describe('products: the tax rate of the group', () => {
  const taxes = () => `/groups/${hex(gid())}/taxes`;

  it('realigns the copy of a tax rate in every price that holds it, in the same write, and refuses to delete a rate a price uses', async () => {
    await reset();
    const created = await call(sa(), 'POST', taxes(), { rate: 4, department: 5, description: 'Minima', vatNature: 'N1' });
    const tid = created.body.data.id as string;
    const copy = { id: tid, value: 4, department: 5, description: 'Minima', natura: 'N1' };
    const rule = (overrides: Document = {}) => legacyPrice({ taxData: { ...copy }, tax: 4, price: 10, taxed: 10.4, ...overrides });
    const other = rule({ id: 'other', taxData: { id: 'tax-other', value: 22, department: 1, description: null, natura: null }, tax: 22, price: 5, taxed: 6.1 });
    const holder = await seed({ updateDate: LEGACY, prices: [rule({ id: 'a' }), other, rule({ id: 'b', taxed: Number.NaN, price: 3 }), rule({ id: 'c', taxed: 20.8, price: new Double(50), extra: 'k' }), 'text'], customKey: 1 });
    const trashed = await seed({ trash: true, updateDate: LEGACY, prices: [rule({ id: 'a' })] });
    const aligned = await seed({ updateDate: LEGACY, prices: [rule({ id: 'a', taxData: { ...copy, value: 5, description: 'Cambiata', natura: 'N2.1' }, tax: 5, price: 9.90476190, taxed: 10.4 })] });
    const untouched = await seed({ updateDate: LEGACY, prices: [other] });
    const noPrices = await seed({ updateDate: LEGACY, prices: undefined });
    const changed = await call(sa(), 'PATCH', `${taxes()}/${tid}`, { rate: 5, description: 'Cambiata', vatNature: 'N2.1' });
    okay(changed);
    const document = (await stored(holder))!;
    const prices = document['prices'] as Document[];
    assert.deepEqual(plain(prices.map((price) => typeof price === 'string' ? price : [price['id'], price['tax'], (price['taxData'] as Document)['value'], (price['taxData'] as Document)['description'], (price['taxData'] as Document)['natura'], (price['taxData'] as Document)['department'], price['price'], price['taxed']])), [
      ['a', 5, 5, 'Cambiata', 'N2.1', 5, 9.9047619, 10.4],
      ['other', 22, 22, null, null, 1, 5, 6.1],
      ['b', 5, 5, 'Cambiata', 'N2.1', 5, 3, null],
      ['c', 5, 5, 'Cambiata', 'N2.1', 5, 19.80952381, 20.8],
      'text',
    ]);
    assert.equal(prices[3]!['extra'], 'k');
    assert.equal(plain(document['customKey']), 1);
    assert.ok((document['updateDate'] as Date).getTime() > LEGACY.getTime());
    assert.ok(plain(((await stored(trashed))!['prices'] as Document[])[0]!['tax']) === 5 && ((await stored(trashed))!['updateDate'] as Date).getTime() > LEGACY.getTime());
    assert.deepEqual([(await stored(aligned))!['updateDate'], (await stored(untouched))!['updateDate'], (await stored(noPrices))!['updateDate']], [LEGACY, LEGACY, LEGACY]);
    // The same rate again writes nothing more, and a rate whose percentage does not change keeps the net price.
    const mark = (await stored(holder))!['updateDate'];
    okay(await call(sa(), 'PATCH', `${taxes()}/${tid}`, { rate: 5 }));
    assert.deepEqual((await stored(holder))!['updateDate'], mark);
    okay(await call(sa(), 'PATCH', `${taxes()}/${tid}`, { department: 6 }));
    const department = ((await stored(holder))!['prices'] as Document[])[0] as Document;
    assert.deepEqual(plain([(department['taxData'] as Document)['department'], department['price'], department['tax']]), [6, 9.9047619, 5]);
    // The rate a price holds cannot be deleted; one only a product in the trash holds is not blocked by it (see the trash page).
    assert.deepEqual(failure(await call(sa(), 'DELETE', `${taxes()}/${tid}`)).details, [{ field: `products.${hex(holder)}`, issue: 'referenced' }, { field: `products.${hex(aligned)}`, issue: 'referenced' }]);
    await db.products.deleteMany({ _id: { $in: [holder, aligned] } });
    assert.equal((await call(sa(), 'DELETE', `${taxes()}/${tid}`)).status, 204);
    const free = await call(sa(), 'POST', taxes(), { rate: 8 });
    assert.equal((await call(sa(), 'DELETE', `${taxes()}/${free.body.data.id as string}`)).status, 204);
  });
});

describe('products: documents the legacy left in odd shapes', () => {
  it('writes every list on a document that has none of them, and the fields of a document that has junk instead', async () => {
    await reset();
    const category = legacyCategory();
    await db.categories.insertOne(category);
    const modifier = await seed({ variant: { status: true } });
    const member = await seed({ name: { it: 'Membro' } });
    const supplier = new ObjectId();
    await ctx.databases.group(gid(), 'cluster0').collection('contacts').insertOne({ _id: supplier, supplier: true });
    const id = await seed({
      variantsRequired: undefined,
      variants: 'no',
      variantsExcluded: undefined,
      variantsCategories: undefined,
      categories: undefined,
      attributes: undefined,
      barcode: undefined,
      suppliers: undefined,
      prices: undefined,
      bundleProducts: undefined,
      selectableBundleProducts: undefined,
      selectableVariantsBundleProducts: undefined,
      modularBundle: undefined,
      colors: { pos: { text: 'red' } },
      scaleType: undefined,
      brandId: new ObjectId(),
      startDate: new Date('2026-01-01T00:00:00Z'),
    });
    const reply = await patch(hex(id), {
      requiredModifierIds: [],
      modifierIds: [hex(modifier)],
      excludedModifierIds: [],
      modifierCategoryIds: [],
      categoryIds: [],
      attributeIds: [],
      barcodes: [],
      suppliers: [{ contactId: hex(supplier) }],
      prices: [],
      components: [{ productId: hex(member), quantity: 1 }],
      menu: [{ categoryId: hex(category['_id'] as ObjectId), quantity: 1 }],
      modifierChoices: [{ categoryId: hex(category['_id'] as ObjectId), freeQuantity: 0, priceRule: 'highest' }],
      modularPriceRule: 'sum',
      colors: { text: '#112233' },
      scaleType: 'weight',
      brandId: null,
      validFrom: null,
    });
    okay(reply);
    const document = (await stored(id))!;
    assert.deepEqual(plain([document['variantsRequired'], document['variants'], document['variantsExcluded'], document['variantsCategories'], document['categories'], document['attributes'], document['barcode'], document['prices']]), [[], [hex(modifier)], [], [], [], [], [], []]);
    assert.deepEqual(plain([document['suppliers'], document['bundleProducts'], document['selectableBundleProducts'], document['selectableVariantsBundleProducts'], document['modularBundle'], document['colors'], document['scaleType'], document['brandId'], document['startDate']]), [
      [{ id: hex(supplier), code: '', name: '', minQt: null, deliveryTime: null, deliveryTimeUnit: 'days', favorite: false, companyLists: [] }],
      [{ _id: hex(member), quantity: 1, waste: null }],
      [{ categoryId: hex(category['_id'] as ObjectId), quantity: 1, exit: null, products: [] }],
      [{ categoryId: hex(category['_id'] as ObjectId), freeQt: 0, priceType: 'h', products: [] }],
      { priceRule: 'sum' },
      { pos: { text: '#112233' } },
      0,
      null,
      null,
    ]);
    okay(await patch(hex(id), { modularPriceRule: null }));
    assert.deepEqual(plain((await stored(id))!['modularBundle']), { priceRule: null });
  });

  it('changes a menu, the groups of modifier choices and the barcodes a product already has, whatever the functions of the group', async () => {
    await reset();
    const category = legacyCategory();
    await db.categories.insertOne(category);
    const dish = await seed({ name: { it: 'Piatto' } });
    const modifier = await seed({ variant: { status: true } });
    const catId = category['_id'] as ObjectId;
    const id = await seed({
      barcode: [{ value: 'keep', qtLoad: 3, qtSale: 2 }, { value: 7 }, 'x'],
      selectableBundleProducts: [{ categoryId: catId, quantity: 1, exit: 4, products: [{ _id: dish }] }],
      selectableVariantsBundleProducts: [{ categoryId: catId, freeQt: 1, priceType: 'l', products: [{ _id: modifier }] }],
    });
    okay(await patch(hex(id), { menu: [{ categoryId: hex(catId), quantity: 2, course: null, productIds: [hex(dish)] }], modifierChoices: [{ categoryId: hex(catId), freeQuantity: 2, priceRule: 'highest', productIds: [hex(modifier)] }], barcodes: [{ value: 'keep', loadQuantity: 5 }] }));
    let document = (await stored(id))!;
    assert.deepEqual(plain([document['selectableBundleProducts'], document['barcode']]), [[{ categoryId: hex(catId), quantity: 2, exit: null, products: [{ _id: hex(dish) }] }], [{ value: 'keep', qtLoad: 5, qtSale: null }]]);
    // Without the functions the course, the quantity of load and the choices are not written, and the stored ones stay.
    await features({ rooms: false, warehouse: false, productsVariants: false });
    try {
      await db.products.updateOne({ _id: id }, { $set: { 'selectableBundleProducts.0.exit': 4 } });
      okay(await patch(hex(id), { menu: [{ categoryId: hex(catId), quantity: 3, productIds: [] }], barcodes: [{ value: 'keep', saleQuantity: 9 }] }));
      document = (await stored(id))!;
      assert.deepEqual(plain([(document['selectableBundleProducts'] as Document[])[0], document['barcode']]), [{ categoryId: hex(catId), quantity: 3, exit: 4, products: [] }, [{ value: 'keep', qtLoad: 5, qtSale: 9 }]]);
    } finally {
      await features(ALL);
    }
    // A bill that already holds a product that no longer exists can still be extended, and a print station map that is not an object is not written.
    const lonely = await seed({ bundleProducts: [{ _id: new ObjectId(), quantity: 1 }], printStations: [] });
    okay(await patch(hex(lonely), { components: [{ productId: hex(dish), quantity: 1 }, ...(((await stored(lonely))!['bundleProducts'] as Document[]).map((component) => ({ productId: hex(component['_id'] as ObjectId), quantity: 1 })))] }));
    assert.equal(failure(await patch(hex(lonely), { printStations: { [hex(own())]: ['st-1'] } })).status, 409);
    // A price whose list, currency and tax rate are not there is not judged against the lists of the group when it is sent as it is.
    const odd = await seed({ prices: [legacyPrice({ id: 'x', listId: undefined, currency: undefined, taxData: undefined, price: undefined, taxed: undefined })] });
    okay(await patch(hex(odd), { prices: [{ id: 'x', priceListId: listId, currency: 'EUR', taxId, gross: 1 }] }));
    // The suppliers a product has are kept with the keys the warehouse gave them, and judged again only when new.
    const contact = new ObjectId();
    await ctx.databases.group(gid(), 'cluster0').collection('contacts').insertOne({ _id: contact, supplier: true });
    const supplied = await seed({ suppliers: [{ id: contact, code: 'OLD', delivetyTime: 3, lastPrice: 5 }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', code: 'GONE' }, { code: 'without id' }] });
    okay(await patch(hex(supplied), { suppliers: [{ contactId: hex(contact), code: 'NEW', priceLists: [{ id: 'l1' }] }, { contactId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }] }));
    assert.deepEqual(plain(((await stored(supplied))!['suppliers'] as Document[])[0]), { id: hex(contact), code: 'NEW', name: '', minQt: null, deliveryTime: null, deliveryTimeUnit: 'days', favorite: false, companyLists: [{ id: 'l1', price: null, discount1: null, discount2: null, discount3: null }], delivetyTime: 3, lastPrice: 5 });
    // A gallery with a descriptor that is not one is rewritten without it.
    const gallery = await seedImage(db, gid());
    const withJunk = await seed({ medias: { images: { gallery: [4, { _id: hex(gallery), basename: 'g.png' }] } } });
    okay(await patch(hex(withJunk), { gallery: [{ imageId: hex(gallery) }, { imageId: hex(await seedImage(db, gid())) }] }));
    assert.equal((((await stored(withJunk))!['medias'] as Document)['images'] as Document)['gallery'] instanceof Array, true);
  });

  it('refuses a realignment that does not fit in the blocks it is allowed, and writes what fits in a repeatable way', async () => {
    await reset();
    const copy = { id: 'tax-blocks', value: 10, department: 1, description: null, natura: null };
    const holders = [await seed({ prices: [legacyPrice({ taxData: { ...copy, value: 4 }, tax: 4 })] }), await seed({ prices: [legacyPrice({ taxData: { ...copy, value: 4 }, tax: 4 })] })];
    const principal = principalOf('SA', { groupId: gid() });
    const verified = (await accessFor(principal, gid()))!;
    const cut = createTaxProducts(ctx.databases, { size: 1, max: 1 });
    // Inside a transaction a realignment that does not fit refuses the whole write; outside one it says how much is left, and repeating it goes on.
    await assert.rejects(ctx.databases.transaction((session) => cut.realign(principal, verified, copy, new Date(), session)), (error: unknown) => (error as { code?: string }).code === 'CONFLICT');
    assert.equal(await db.products.countDocuments({ 'prices.tax': 10 }), 0);
    assert.deepEqual(await cut.realign(principal, verified, copy, new Date()), { complete: false, remainingBlocks: 1 });
    assert.equal(await db.products.countDocuments({ 'prices.tax': 10 }), 1);
    assert.deepEqual(await cut.realign(principal, verified, { ...copy, value: Number.NaN }, new Date()), { complete: false, skipped: true, remainingBlocks: 0 });
    assert.deepEqual(await createTaxProducts(ctx.databases).realign(principal, verified, copy, new Date()), { complete: true, remainingBlocks: 0 });
    assert.equal(await db.products.countDocuments({ 'prices.tax': 10 }), holders.length);
  });
});

/** A product in the trash, for the tests of the references. */
const trashedProduct0 = (overrides: Document = {}) => seed({ trash: true, trashDate: new Date(), ...overrides });

describe('products: corrections of the security review', () => {
  const taxes = () => `/groups/${hex(gid())}/taxes`;

  it('copies a description that looks like an expression as the text it is, and converges', async () => {
    await reset();
    const created = await call(sa(), 'POST', taxes(), { rate: 4, department: 5, description: 'Minima' });
    const tid = created.body.data.id as string;
    const holder = await seed({ prices: [legacyPrice({ taxData: { id: tid, value: 4, department: 5, description: 'Minima', natura: null }, tax: 4, price: 10, taxed: 10.4 })] });
    const department = await db.departments.insertOne({ _id: new ObjectId(), code: 77, name: { it: 'R' }, tax: { id: tid, value: 4, department: 5, description: 'Minima', natura: null }, status: true });
    assert.ok(department.acknowledged);
    for (const description of ['$$ROOT', '$code', '$ 5 off', '$$', '$$REMOVE']) {
      okay(await call(sa(), 'PATCH', `${taxes()}/${tid}`, { description, rate: description === '$$' ? 5 : 4 }));
      const price = ((await stored(holder))!['prices'] as Document[])[0]!;
      const data = price['taxData'] as Document;
      assert.deepEqual(plain([data['id'], data['description'], data['department'], Object.keys(data).sort(), price['code'] === undefined]), [tid, description, 5, ['department', 'description', 'id', 'natura', 'value'], true]);
      assert.equal(await db.products.countDocuments({ _id: holder, code: description }), 0);
      assert.equal(((await db.departments.findOne({ code: 77 }))!['tax'] as Document)['description'], description);
      // The same rate again writes nothing: the realignment has converged.
      const mark = (await stored(holder))!['updateDate'];
      okay(await call(sa(), 'PATCH', `${taxes()}/${tid}`, { description }));
      assert.deepEqual((await stored(holder))!['updateDate'], mark);
    }
    await db.departments.deleteMany({});
  });

  it('names a category of modifiers only to a caller who reaches it, and the products of a brand, a department, an attribute and a category only when he reaches them', async () => {
    await reset();
    const target = await trashedProduct0({ placesAvailability: [placeEntry(own())] });
    const visibleCategory = legacyCategory({ variants: [target], placesAvailability: [{ id: own(), position: null, productionCenterId: null }] });
    const hiddenCategory = legacyCategory({ variants: [target], placesAvailability: [{ id: other(), position: null, productionCenterId: null }] });
    await db.categories.insertMany([visibleCategory, hiddenCategory]);
    const version = tag(await call(sa(), 'GET', one(target)));
    assert.deepEqual(fields(failure(await call(ca(), 'DELETE', one(target), undefined, { 'if-match': version }))), [`categoryModifiers.${hex(visibleCategory['_id'] as ObjectId)}`, 'categoryModifiers']);
    await db.categories.deleteMany({});
    // The brand of a place administrator is used by a product he does not reach: one anonymous detail.
    const brand = new ObjectId();
    await db.brands.insertOne({ _id: brand, name: { it: 'Mia' }, placesAvailability: [own()], status: true });
    const reached = await seed({ brandId: brand, placesAvailability: [placeEntry(own())] });
    const hidden = await seed({ brandId: brand, placesAvailability: [placeEntry(other())] });
    assert.deepEqual(fields(failure(await call(pa(), 'DELETE', `/groups/${hex(gid())}/product-brands/${hex(brand)}`, undefined, { 'if-match': tag(await call(pa(), 'GET', `/groups/${hex(gid())}/product-brands/${hex(brand)}`)) }))), [`products.${hex(reached)}`, 'products']);
    await db.products.deleteOne({ _id: reached });
    assert.deepEqual(failure(await call(pa(), 'DELETE', `/groups/${hex(gid())}/product-brands/${hex(brand)}`, undefined, { 'if-match': tag(await call(pa(), 'GET', `/groups/${hex(gid())}/product-brands/${hex(brand)}`)) })).details, [{ field: 'products', issue: 'referenced' }]);
    await db.products.deleteOne({ _id: hidden });
    // A modifier the caller does not reach is judged as one that does not exist when he lists it in a category.
    const modifier = await seed({ variant: { status: true }, placesAvailability: [placeEntry(other())] });
    const mine = legacyCategory({ placesAvailability: [{ id: own(), position: null, productionCenterId: null }] });
    await db.categories.insertOne(mine);
    const categoryPath = `/groups/${hex(gid())}/product-categories/${hex(mine['_id'] as ObjectId)}`;
    assert.deepEqual(failure(await call(pa(), 'PATCH', categoryPath, { modifierIds: [hex(modifier)] }, { 'if-match': tag(await call(pa(), 'GET', categoryPath)) })).details, [{ field: 'modifierIds.0', issue: 'incorrect' }]);
    await db.categories.deleteMany({});
  });

  it('keeps a product whose availability is not a list apart from a company or place administrator, and handles an anomalous element next to his own place', async () => {
    await reset();
    for (const value of ['x', 5]) {
      const id = await seed({ placesAvailability: value });
      assert.equal(failure(await call(pa(), 'GET', one(id))).status, 404);
      assert.equal((await call(sa(), 'GET', one(id))).status, 200);
      assert.ok(!(await call(ca(), 'GET', base())).body.data.some((row: { id: string }) => row.id === hex(id)));
    }
    const mixed = await seed({ placesAvailability: [placeEntry(own()), 7] });
    const reading = (await call(ca(), 'GET', one(mixed))).body.data;
    assert.deepEqual([reading.editable, reading.placeEditable, reading.places.length], [false, true, 1]);
    assert.equal(failure(await patch(hex(mixed), { code: 'x' }, ca())).status, 403);
    okay(await patch(hex(mixed), { places: [{ placeId: hex(own()), favorite: true }] }, ca()));
    assert.deepEqual(plain((await stored(mixed))!['placesAvailability']), [7, { id: hex(own()), favorite: true, favoriteHandheld: false, position: null, productionCenterId: null }]);
  });

  it('writes the leaves of the stock without touching a quantity the warehouse moved after the read', async () => {
    await reset();
    const key = `__${hex(own())}`;
    const id = await seed({ quantity: { [key]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 5, min: 1 } } } });
    const read = await call(sa(), 'GET', one(id));
    await db.products.updateOne({ _id: id }, { $inc: { [`quantity.${key}.__aaaaaaaaaaaaaaaaaaaaaaaa.value`]: 4 } });
    okay(await call(sa(), 'PATCH', one(id), { stock: { [hex(own())]: { aaaaaaaaaaaaaaaaaaaaaaaa: { min: 2 } } } }, { 'if-match': tag(read) }));
    assert.deepEqual(plain(((await stored(id))!['quantity'] as Document)[key]), { __aaaaaaaaaaaaaaaaaaaaaaaa: { value: 9, min: 2 } });
  });

  it('tells nothing of the duplicated values in the answers of the trash, and a bulk trash tells a lost race from a product already trashed', async () => {
    await reset();
    const created = await create({ code: 'W' });
    const trashed = await call(sa(), 'POST', `${one(created.body.data.id)}/trash`, undefined, { 'if-match': tag(created) });
    assert.ok(!('warnings' in trashed.body.data));
    const restored = await call(sa(), 'POST', `${one(created.body.data.id)}/restore`, undefined, { 'if-match': tag(trashed) });
    assert.ok(!('warnings' in restored.body.data));
    assert.ok(Array.isArray((await call(sa(), 'GET', one(created.body.data.id))).body.data.warnings));
  });
});

describe('products: the compact reads and the shapes the realignment leaves alone', () => {
  it('shows a company or place administrator only the products he reaches in the lookups and in the services', async () => {
    await reset();
    const everyone = await seed({ name: { it: 'Per tutti' }, type: 'service' });
    const mine = await seed({ name: { it: 'Mio' }, type: 'service', placesAvailability: [placeEntry(own())] });
    const theirs = await seed({ name: { it: 'Altrui' }, type: 'service', placesAvailability: [placeEntry(other())] });
    const modifier = await seed({ name: { it: 'Modificatore altrui' }, variant: { status: true }, placesAvailability: [placeEntry(other())] });
    const lookup = (query = '') => `/groups/${hex(gid())}/lookup/products${query}`;
    const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { name: string }) => item.name).sort();
    assert.deepEqual(names(await call(sa(), 'GET', lookup())), ['Altrui', 'Mio', 'Modificatore altrui', 'Per tutti']);
    for (const actor of [ca(), pa()]) {
      assert.deepEqual(names(await call(actor, 'GET', lookup())), ['Mio', 'Per tutti']);
      assert.deepEqual(names(await call(actor, 'GET', lookup(`?ids=${hex(theirs)},${hex(mine)},${hex(modifier)}`))), ['Mio']);
      assert.deepEqual(names(await call(actor, 'GET', lookup('?type=service&q=Alt'))), []);
      assert.deepEqual(names(await call(actor, 'GET', lookup('?modifier=true'))), []);
      assert.deepEqual(names(await call(actor, 'GET', lookup('?modifier=false&type=service'))), ['Mio', 'Per tutti']);
      assert.deepEqual(names(await call(actor, 'GET', `/groups/${hex(gid())}/services`)), ['Mio', 'Per tutti']);
    }
    assert.deepEqual(names(await call(sa(), 'GET', `/groups/${hex(gid())}/services`)), ['Altrui', 'Mio', 'Per tutti']);
    assert.ok(everyone);
  });

  it('leaves alone the prices whose tax is a list, and converges', async () => {
    await reset();
    const created = await call(sa(), 'POST', `/groups/${hex(gid())}/taxes`, { rate: 4, department: 5 });
    const tid = created.body.data.id as string;
    const weird = await seed({ updateDate: LEGACY, prices: [legacyPrice({ taxData: [{ id: tid, value: 4 }], tax: 4 }), legacyPrice({ taxData: { id: [tid], value: 4 }, tax: 4 })] });
    const normal = await seed({ updateDate: LEGACY, prices: [legacyPrice({ taxData: { id: tid, value: 4, department: 5, description: null, natura: null }, tax: 4 })] });
    okay(await call(sa(), 'PATCH', `/groups/${hex(gid())}/taxes/${tid}`, { rate: 6 }));
    assert.deepEqual((await stored(weird))!['updateDate'], LEGACY);
    assert.deepEqual(plain(((await stored(weird))!['prices'] as Document[]).map((price) => price['tax'])), [4, 4]);
    assert.equal(plain(((await stored(normal))!['prices'] as Document[])[0]!['tax']), 6);
    const principal = principalOf('SA', { groupId: gid() });
    const verified = (await accessFor(principal, gid()))!;
    assert.deepEqual(await createTaxProducts(ctx.databases).realign(principal, verified, { id: tid, value: 6, department: 5, description: null, natura: null }, new Date()), { complete: true, remainingBlocks: 0 });
  });
});

describe('products: the compact reads of the product form', () => {
  const lookup = (rest: string, index = 0) => `/groups/${hex(world.group(index).groupId)}/lookup/${rest}`;
  const contacts = () => ctx.databases.group(gid(), 'cluster0').collection('contacts');

  it('lists the suppliers with their price lists and nothing else of the contact', async () => {
    await contacts().deleteMany({});
    const bianchi = new ObjectId();
    const rossi = new ObjectId();
    await contacts().insertMany([
      { _id: bianchi, supplier: true, trash: false, companyName: 'Bianchi Spa', vatNumber: 'IT123', address: 'Via Roma 1', email: 'a@b.test', companyLists: [{ id: 'cl-1', name: 'Listino estate', favorite: true, secret: 1 }, { id: 5, name: 'x' }, 'junk', { id: 'cl-2' }] },
      { _id: rossi, supplier: true, name: 'Mario', surname: 'Rossi', companyLists: 'no' },
      { _id: new ObjectId(), supplier: true, trash: true, companyName: 'Cestinato' },
      { _id: new ObjectId(), supplier: false, companyName: 'Cliente' },
      { _id: new ObjectId(), supplier: true, companyName: 'abcdef0123456789abcdef0123456789$abcdef0123456789abcdef0123456789' },
    ]);
    const first = await call(sa(), 'GET', lookup('suppliers'));
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data.map((item: { name: string }) => item.name).sort(), ['', 'Bianchi Spa', 'Mario Rossi']);
    const bianchiItem = first.body.data.find((item: { id: string }) => item.id === hex(bianchi));
    assert.deepEqual(bianchiItem, { id: hex(bianchi), name: 'Bianchi Spa', priceLists: [{ id: 'cl-1', name: 'Listino estate' }, { id: 'cl-2', name: '' }] });
    assert.deepEqual(first.body.data.find((item: { id: string }) => item.id === hex(rossi)).priceLists, []);
    assert.ok(first.body.data.every((item: Document) => Object.keys(item).sort().join() === 'id,name,priceLists'));
    assert.deepEqual((await call(sa(), 'GET', lookup('suppliers?q=bianc'))).body.data.map((item: { id: string }) => item.id), [hex(bianchi)]);
    assert.deepEqual((await call(sa(), 'GET', lookup('suppliers?q=.*'))).body.data, []);
    assert.deepEqual((await call(sa(), 'GET', lookup(`suppliers?ids=${hex(rossi)},${hex(new ObjectId())}`))).body.data.map((item: { id: string }) => item.id), [hex(rossi)]);
    assert.equal((await call(sa(), 'GET', lookup('suppliers?limit=1'))).body.page.limit, 1);
    for (const actor of [ca(), pa()]) {
      assert.equal((await call(actor, 'GET', lookup('suppliers'))).status, 200);
    }
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: false, w: false }, groups: { r: false, w: false } } }) });
    for (const path of ['suppliers', 'currencies', 'measure-units']) {
      assert.equal(failure(await call(blind.id, 'GET', lookup(path))).status, 403, path);
      assert.equal(failure(await call(world.group(1).sa, 'GET', lookup(path))).status, 404, path);
    }
    assert.equal(failure(await call(sa(), 'GET', lookup('suppliers?x=1'))).status, 422);
  });

  it('lists the currencies and the units of measure of the group with their own fields only', async () => {
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: true, w: false } } }) });
    for (const actor of [sa(), ca(), pa(), reader.id]) {
      const currencies = await call(actor, 'GET', lookup('currencies'));
      assert.deepEqual(currencies.body.data.map((item: Document) => Object.keys(item).sort().join()), ['code,symbol', 'code,symbol']);
      assert.deepEqual(currencies.body.data.map((item: { code: string }) => item.code).sort(), ['EUR', 'USD']);
      const units = await call(actor, 'GET', lookup('measure-units'));
      assert.deepEqual(units.body.data.map((item: Document) => Object.keys(item).sort().join()), ['id,name,value']);
      assert.equal(units.body.data[0].value, units.body.data[0].name);
    }
    assert.equal((await call(sa(), 'GET', lookup('currencies'))).headers.get('etag')?.startsWith('W/'), true);
  });

  it('narrows the products by category, and answers as for a category that does not exist when the caller does not reach it', async () => {
    await reset();
    const visible = legacyCategory({ placesAvailability: [{ id: own(), position: null, productionCenterId: null }] });
    const hidden = legacyCategory({ placesAvailability: [{ id: other(), position: null, productionCenterId: null }] });
    await db.categories.insertMany([visible, hidden]);
    const inVisible = await seed({ name: { it: 'Dentro' }, categories: [visible['_id']], type: 'service' });
    const asText = await seed({ name: { it: 'Testo' }, categories: [hex(visible['_id'] as ObjectId)] });
    const inHidden = await seed({ name: { it: 'Nascosto' }, categories: [hidden['_id']] });
    const names = (reply: Awaited<ReturnType<typeof call>>) => reply.body.data.map((item: { name: string }) => item.name).sort();
    const path = (query: string) => lookup(`products?${query}`);
    assert.deepEqual(names(await call(sa(), 'GET', path(`categoryId=${hex(visible['_id'] as ObjectId)}`))), ['Dentro', 'Testo']);
    assert.deepEqual(names(await call(sa(), 'GET', path(`categoryId=${hex(visible['_id'] as ObjectId)}&type=service`))), ['Dentro']);
    assert.deepEqual(names(await call(sa(), 'GET', path(`categoryId=${hex(visible['_id'] as ObjectId)}&q=Test&modifier=false`))), ['Testo']);
    assert.deepEqual(names(await call(sa(), 'GET', path(`categoryId=${hex(visible['_id'] as ObjectId)}&ids=${hex(inVisible)},${hex(inHidden)}`))), ['Dentro']);
    assert.deepEqual(names(await call(sa(), 'GET', path(`categoryId=${hex(hidden['_id'] as ObjectId)}`))), ['Nascosto']);
    for (const actor of [ca(), pa()]) {
      assert.deepEqual(names(await call(actor, 'GET', path(`categoryId=${hex(hidden['_id'] as ObjectId)}`))), []);
      assert.deepEqual(names(await call(actor, 'GET', path(`categoryId=${hex(new ObjectId())}`))), []);
      assert.deepEqual(names(await call(actor, 'GET', path(`categoryId=${hex(visible['_id'] as ObjectId)}`))), ['Dentro', 'Testo']);
    }
    assert.equal(failure(await call(sa(), 'GET', path('categoryId=zz'))).status, 422);
    assert.ok(asText);
  });

  it('shows the name of the last supplier in the rows of the list, with one read', async () => {
    await reset();
    await contacts().deleteMany({});
    const known = new ObjectId();
    const nameless = new ObjectId();
    const trashedContact = new ObjectId();
    const former = new ObjectId();
    await contacts().insertMany([{ _id: known, supplier: true, companyName: 'Bianchi Spa' }, { _id: nameless, supplier: true }, { _id: trashedContact, supplier: true, trash: true, companyName: 'Cestinato' }, { _id: former, supplier: false, companyName: 'Ex fornitore' }]);
    const a = await seed({ name: { it: 'A' }, lastAveragePrice: { lastSupplierId: known } });
    const b = await seed({ name: { it: 'B' }, lastAveragePrice: { lastSupplierId: nameless } });
    const c = await seed({ name: { it: 'C' }, lastAveragePrice: { lastSupplierId: new ObjectId() } });
    const d = await seed({ name: { it: 'D' } });
    const e = await seed({ name: { it: 'E' }, lastAveragePrice: { lastSupplierId: trashedContact } });
    const f = await seed({ name: { it: 'F' }, lastAveragePrice: { lastSupplierId: former } });
    const rows = new Map<string, { lastSupplierName: string | null; lastSupplierId: string | null }>((await call(sa(), 'GET', base())).body.data.map((row: { id: string }) => [row.id, row]));
    assert.deepEqual([a, b, c, d, e, f].map((id) => rows.get(hex(id))!.lastSupplierName), ['Bianchi Spa', null, null, null, null, 'Ex fornitore']);
    assert.equal(rows.get(hex(a))!.lastSupplierId, hex(known));
    assert.ok(Object.keys(rows.get(hex(a))!).includes('lastSupplierName'));
    await contacts().deleteMany({});
  });
});
