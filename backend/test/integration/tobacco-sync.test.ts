import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createCatalogsService } from '../../src/modules/groups/catalogs/catalogs.service.ts';
import { createReferencesRepository } from '../../src/modules/groups/catalogs/references.repository.ts';
import { createTaxDepartments } from '../../src/modules/product-departments/product-departments.repository.ts';
import { MAX_LOGGED_ENTRIES } from '../../src/modules/tobacco-sync/tobacco-sync.plan.ts';
import { createTobaccoSyncController } from '../../src/modules/tobacco-sync/tobacco-sync.controller.ts';
import { createTobaccoSyncRoutes } from '../../src/modules/tobacco-sync/tobacco-sync.routes.ts';
import { createTobaccoSyncService, zeroTaxOf } from '../../src/modules/tobacco-sync/tobacco-sync.service.ts';
import type { TobaccoSyncDeps, TobaccoSyncService } from '../../src/modules/tobacco-sync/tobacco-sync.service.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { createCatalogLock } from '../../src/shared/locks/catalog-lock.ts';
import { LAST_SYNC_INDEX, lastSyncQuery } from '../../src/modules/tobacco-sync/tobacco-sync.repository.ts';
import { MAX_BARCODE_QUANTITY, MAX_PRICE } from '../../src/modules/tobacco-sync/tobacco-sync.plan.ts';
import { catalogWorkbook, uploadWorkbook } from '../helpers/catalog-xlsx.ts';
import { createIdempotencyStore, idempotencyBodyKey } from '../../src/shared/http/idempotency.ts';
import { throughRealLog } from '../helpers/real-log.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { catalogCollections, legacyCategory } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { legacyFullProduct, legacyPrice } from '../helpers/products.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';
import { requireGroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { principalOf } from '../helpers/principal.ts';

/** The synchronization of the tobacco price list (step C7): every behaviour goes through `/v1/groups/{groupId}/tobacco-sync`, over a real MongoDB. */
let ctx: TestDatabases;
let world: StoreWorld;
let db: CatalogCollections;
let store: ActivatedKey;
const limiter = memoryRateLimiter();
const audit = memoryActivityLog();
const gid = () => world.group(0).groupId;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const groups = () => ctx.databases.common().collection('groups');
const placeCopies = () => ctx.databases.common().collection('places');
const list = () => ctx.databases.common().collection('tobaccos');
const settings = () => ctx.databases.common().collection('settings');
const path = (query = '', segment = 'tobacco-sync') => `/groups/${gid().toHexString()}/${segment}${query}`;
const hex = (id: ObjectId) => id.toHexString();
let listIds: string[] = [];
let originalGroup: Document;

type Reply = Awaited<ReturnType<StoreWorld['as']['call']>>;
const run = (body: Document = {}, options: { actor?: ObjectId; query?: string; key?: string; segment?: string } = {}): Promise<Reply> => {
  limiter.reset();
  return world.as.call(options.actor ?? sa(), 'POST', path(options.query ?? '', options.segment), body, { 'idempotency-key': options.key ?? randomUUID() });
};
const status = (actor = sa()): Promise<Reply> => world.as.call(actor, 'GET', path());
const counts = (reply: Reply) => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.data;
};
const refusal = (reply: Reply) => ({ status: reply.status, code: reply.body.error.code as string, details: reply.body.error.details as Array<{ field: string; issue: string }> | undefined });

/** An entry of the national price list. */
const entry = (n: number, overrides: Document = {}): Document => ({
  _id: new ObjectId(),
  category: 'Sigarette',
  code: `T${String(n).padStart(4, '0')}`,
  name: `Tabacco ${String(n)}`,
  shortName: `T${String(n)}`,
  priceKg: 100,
  price: 5.2 + n,
  unitWeight: 20,
  numPieces: 20,
  description: `Descrizione ${String(n)}`,
  barcodes: [],
  ...overrides,
});
const listing = (...entries: Document[]) => list().insertMany(entries);
const products = () => db.products.find({}).sort({ _id: 1 }).toArray();
const byCode = (code: string) => db.products.findOne({ code });
const categoriesByName = () => db.categories.find({}).sort({ _id: 1 }).toArray();
const tgmProduct = (overrides: Document = {}): Document => legacyFullProduct({ type: 'tobaccos', code: 'T0001', name: { it: 'Vecchio', en: 'Old' }, shortName: { it: 'Vec' }, description: { it: 'Vecchia' }, shortDescription: { it: 'Corta' }, ...overrides });
const seed = async (overrides: Document = {}): Promise<Document> => {
  const document = tgmProduct(overrides);
  await db.products.insertOne(document);
  return document;
};
const summaries = (mark = 0) => [...world.office.activity.entries.slice(mark), ...audit.entries].filter((item) => item.action === 'tobaccos.synced');
const ZERO = { inserted: 0, updated: 0, disabled: 0, reactivated: 0, unchanged: 0, skipped: 0 };
const productCounts = (reply: Reply, expected: Partial<typeof ZERO>) => assert.deepEqual(counts(reply).products, { ...ZERO, ...expected });
/** A verified access to the group, as the middleware issues it, with the functions of the group on. */
async function accessWithFeatures(principal: AuthPrincipal): Promise<GroupAccess> {
  const handler = requireGroupAccess({
    findAccess: async (id) => ({ availability: 'available', group: { _id: id, dataCluster: 'cluster0', settings: { tobaccosGamesMonopoly: true, warehouse: true } } }),
    resolveCluster: () => 'cluster0',
  });
  const res = { locals: { auth: principal } } as unknown as Response;
  await handler({ params: { groupId: gid().toHexString() } } as unknown as Request, res, () => undefined);
  return res.locals.groupAccess as GroupAccess;
}
const patchGroup = async (set: Document): Promise<void> => void (await groups().updateOne({ _id: gid() }, { $set: set }));

const realCatalogs = () =>
  createCatalogsService({ catalogs: createCatalogsRepository(ctx.databases), references: createReferencesRepository(ctx.databases), activityLog: audit, logger: memoryLogger().logger, newId: () => randomUUID(), now: Date.now, taxDepartments: createTaxDepartments(ctx.databases) });
function serviceWith(overrides: Partial<TobaccoSyncDeps> = {}): TobaccoSyncService {
  return createTobaccoSyncService({ databases: ctx.databases, catalogs: realCatalogs(), activityLog: audit, logger: memoryLogger().logger, now: Date.now, ...overrides });
}
function routesFor(segment: string, service: TobaccoSyncService) {
  const idempotency = createIdempotencyStore(ctx.databases, idempotencyBodyKey(TEST_VERSION_KEY), Date.now);
  return createTobaccoSyncRoutes(createTobaccoSyncController(service), idempotency).map((route) => ({ ...route, path: route.path.replace('tobacco-sync', segment) }));
}
let hold: { started: () => void; released: Promise<void> } | null = null;
function holdingService(): TobaccoSyncService {
  const real = realCatalogs();
  return serviceWith({
    catalogs: {
      list: async (...args: Parameters<typeof real.list>) => {
        const mine = hold;
        hold = null;
        if (mine !== null) {
          mine.started();
          await mine.released;
        }
        return real.list(...args);
      },
    },
  });
}
let ticks = 0;
/** A clock that jumps hours ahead after `calls` readings. */
const clockAfter = (calls: number) => (): number => {
  ticks += 1;
  return Date.now() + (ticks > calls ? 10_000_000 : 0);
};
let idCalls = 0;

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, {
    rateLimiter: limiter,
    extraRoutes: [
      ...routesFor('sync-held', holdingService()),
      ...routesFor('sync-slow', serviceWith({ now: clockAfter(6), limits: { maxSyncMs: 1000 } })),
      ...routesFor('sync-fault', serviceWith({ newId: () => (idCalls++ >= 1 ? (() => { throw new Error('boom'); })() : new ObjectId()) })),
      ...routesFor('sync-unavailable', serviceWith({ newId: () => { throw new AppError('SERVICE_UNAVAILABLE'); } })),
      ...routesFor('sync-slowlist', serviceWith({ now: clockAfter(2), limits: { maxSyncMs: 1000 } })),
      ...routesFor('sync-nolock', serviceWith({ lock: { acquire: () => Promise.reject(new AppError('SERVICE_UNAVAILABLE')) } })),
      ...routesFor('sync-nocatalogs', serviceWith({ catalogs: { list: () => Promise.reject(new Error('down')) } })),
      ...routesFor('sync-small', serviceWith({ limits: { maxList: 2, maxProducts: 1, maxCategories: 1 } })),
    ],
  });
  db = catalogCollections(ctx, world);
  store = await world.activate(own());
  originalGroup = (await groups().findOne({ _id: gid() }))!;
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  hold = null;
  ticks = 0;
  idCalls = 0;
  world.office.activity.entries.length = 0;
  audit.entries.length = 0;
  await Promise.all([db.products.deleteMany({}), db.categories.deleteMany({}), list().deleteMany({})]);
  await groups().replaceOne({ _id: gid() }, originalGroup);
  await patchGroup({
    'settings.tobaccosGamesMonopoly': true,
    'settings.warehouse': true,
    taxes: [{ id: 'tax-22', value: 22, department: 1, description: null, natura: null }, { id: 'tax-0', value: 0, department: 2, description: 'Esente', natura: 'N4' }],
    priceLists: { L1: { id: 'L1', name: 'Base', status: true, default: true }, L2: { id: 'L2', name: 'Spento', status: false, default: false } },
  });
  await placeCopies().updateMany({ _id: { $in: [own(), other()] } }, { $set: { 'tgm.status': false, trash: false } });
  await placeCopies().updateOne({ _id: own() }, { $set: { 'tgm.status': true } });
  listIds = [];
});

describe('who may synchronize', () => {
  it('lets the PSA, a dealer and a group administrator in, and nobody else', async () => {
    await listing(entry(1));
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA, sa()]) {
      assert.equal((await run({}, { actor, query: '?dryRun=true' })).status, 200);
      assert.equal((await status(actor)).status, 200);
    }
    for (const actor of [ca(), pa()]) {
      assert.equal((await run({}, { actor, query: '?dryRun=true' })).status, 403);
      assert.equal((await status(actor)).status, 403);
    }
    assert.equal((await world.asStore(store.key, 'POST', path(), {}, { 'idempotency-key': randomUUID() })).status, 403);
    assert.equal((await world.asStore(store.key, 'GET', path())).status, 403);
    const anonymous = await fetch(`${world.office.app.baseUrl}/v1${path()}`);
    assert.equal(anonymous.status, 401);
    // Another group's administrator reaches nothing of this one.
    assert.equal((await run({}, { actor: world.group(1).sa, query: '?dryRun=true' })).status, 404);
  });

  it('follows the matrix of the user: a group administrator without products.w is refused', async () => {
    await ctx.databases.common().collection('users').updateOne({ _id: sa() }, { $set: { 'permissions.products.w': false } });
    try {
      assert.equal((await run({}, { query: '?dryRun=true' })).status, 403);
    } finally {
      await ctx.databases.common().collection('users').updateOne({ _id: sa() }, { $set: { 'permissions.products.w': true } });
    }
  });
});

describe('the request', () => {
  it('needs a body, refuses what it does not know and what is not valid', async () => {
    const empty = await world.as.call(sa(), 'POST', path(), undefined, { 'idempotency-key': randomUUID() });
    assert.equal(empty.status, 422);
    for (const body of [{ extra: 1 }, { warehouse: 'yes' }, { placeIds: ['x'] }, { placeIds: 'x' }, { noDiscount: 1 }]) {
      assert.equal((await run(body)).status, 422, JSON.stringify(body));
    }
    assert.equal((await run({}, { query: '?dryRun=maybe' })).status, 422);
  });
});

describe('the state', () => {
  it('says the synchronization is available and what it will read', async () => {
    await listing(entry(1), entry(2));
    const reply = await status();
    assert.equal(reply.status, 200);
    const data = reply.body.data;
    assert.deepEqual([data.available, data.reasons, data.warehouseAllowed, data.list.entries, data.lastSync], [true, [], true, 2, null]);
    assert.deepEqual(data.tobaccoPlaces.map((place: { id: string }) => place.id), [hex(own())]);
    await placeCopies().updateOne({ _id: other() }, { $set: { 'tgm.status': true }, $unset: { name: '' } });
    const ownName = (await placeCopies().findOne({ _id: own() }))!['name'] as string;
    assert.deepEqual((await status()).body.data.tobaccoPlaces.map((place: { name: string }) => place.name), ['', ownName]);
    assert.ok(Math.abs(Date.parse(data.list.importedAt) - Date.now()) < 60_000);
  });

  it('gives every reason it cannot start', async () => {
    const reasons = async () => (await status()).body.data.reasons as string[];
    assert.deepEqual(await reasons(), ['emptyList']);
    await listing(entry(1));
    await patchGroup({ 'settings.tobaccosGamesMonopoly': false, 'settings.warehouse': false, taxes: [{ id: 'tax-22', value: 22, department: 1, description: null, natura: null }], priceLists: {} });
    await placeCopies().updateOne({ _id: own() }, { $set: { 'tgm.status': false } });
    const reply = await status();
    assert.deepEqual(reply.body.data.reasons, ['featureDisabled', 'noTobaccoPlace', 'noZeroTaxRate', 'noPriceList']);
    assert.deepEqual([reply.body.data.available, reply.body.data.warehouseAllowed, reply.body.data.list.entries], [false, false, 1]);
    assert.equal((await status()).body.data.list.importedAt !== null, true);
  });

  it('knows the last synchronization that wrote, not a dry run', async () => {
    await listing(entry(1));
    await run({}, { query: '?dryRun=true' });
    assert.equal((await status()).body.data.lastSync, null);
    // The log of the test app is in memory: write the entry the way the real log does.
    await ctx.databases.common().collection('activityEvents').insertOne({ action: 'tobaccos.synced', outcome: 'success', groupId: gid(), at: new Date('2026-11-20T10:00:00Z'), metadata: { dryRun: false, inserted: 3 } });
    await ctx.databases.common().collection('activityEvents').insertOne({ action: 'tobaccos.synced', outcome: 'success', groupId: gid(), at: new Date('2026-11-21T10:00:00Z') });
    const last = (await status()).body.data.lastSync;
    assert.deepEqual(last, { at: '2026-11-20T10:00:00.000Z', counts: { dryRun: false, inserted: 3 } });
    await ctx.databases.common().collection('activityEvents').deleteMany({ action: 'tobaccos.synced' });
  });
});

describe('why it does not start', () => {
  it('refuses a group without the function', async () => {
    await listing(entry(1));
    await patchGroup({ 'settings.tobaccosGamesMonopoly': false });
    assert.equal(refusal(await run()).code, 'FEATURE_DISABLED');
    assert.equal(summaries()[0]!.outcome, 'failure');
    assert.equal(summaries()[0]!.metadata!['reason'], 'featureDisabled');
  });

  it('refuses a group without a point of sale with the tobaccos on, or with every one in the trash', async () => {
    await listing(entry(1));
    await placeCopies().updateOne({ _id: own() }, { $set: { 'tgm.status': false } });
    assert.deepEqual(refusal(await run()), { status: 409, code: 'CONFLICT', details: [{ field: 'group', issue: 'noTobaccoPlace' }] });
    await placeCopies().updateOne({ _id: own() }, { $set: { 'tgm.status': true, trash: true } });
    assert.equal(refusal(await run()).status, 409);
    assert.deepEqual(await products(), []);
  });

  it('refuses a group without a tax rate of 0%, and says so', async () => {
    await listing(entry(1));
    await patchGroup({ taxes: [{ id: 'tax-22', value: 22, department: 1, description: null, natura: null }] });
    const reply = await run();
    assert.deepEqual(refusal(reply), { status: 409, code: 'CONFLICT', details: [{ field: 'group', issue: 'noZeroTaxRate' }] });
    assert.match(reply.body.error.message, /0%/);
    assert.deepEqual(await products(), []);
  });

  it('refuses a group without a price list, and a price list that is empty', async () => {
    await listing(entry(1));
    await patchGroup({ priceLists: {} });
    assert.equal(refusal(await run()).details![0]!.issue, 'noPriceList');
    await patchGroup({ priceLists: { L1: { id: 'L1', name: 'Base', status: true, default: true } } });
    await list().deleteMany({});
    assert.equal(refusal(await run()).details![0]!.issue, 'emptyList');
  });

  it('picks the rate of 0% with a nature, else the first', () => {
    const tax = (id: string, rate: number, vatNature: string | null) => ({ id, rate, department: null, description: null, vatNature });
    assert.equal(zeroTaxOf([tax('a', 0, null), tax('b', 22, 'N1'), tax('c', 0, 'N4'), tax('d', 0, 'N2.1')])!.id, 'c');
    assert.equal(zeroTaxOf([tax('a', 22, null), tax('b', 0, null), tax('c', 0, null)])!.id, 'b');
    assert.equal(zeroTaxOf([tax('a', 22, null)]), undefined);
  });

  it('refuses the warehouse without the function, and takes it with it', async () => {
    await listing(entry(1));
    await patchGroup({ 'settings.warehouse': false });
    assert.deepEqual(refusal(await run({ warehouse: true })), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'warehouse', issue: 'notAllowed' }] });
    assert.equal(counts(await run({ warehouse: false })).products.inserted, 1);
    await patchGroup({ 'settings.warehouse': true });
    await run({ warehouse: true });
    assert.equal((await byCode('T0001'))!['availability'].warehouse, true);
  });

  it('refuses points of sale that do not exist, or are in the trash, naming each', async () => {
    await listing(entry(1));
    await placeCopies().updateOne({ _id: other() }, { $set: { trash: true } });
    const stranger = world.group(1).ownPlaceId;
    const reply = await run({ placeIds: [hex(own()), hex(other()), hex(stranger), hex(new ObjectId())] });
    assert.deepEqual(refusal(reply), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'placeIds.1', issue: 'notFound' }, { field: 'placeIds.2', issue: 'notFound' }, { field: 'placeIds.3', issue: 'notFound' }] });
    assert.deepEqual(await products(), []);
    // A point of sale that exists and has no tobaccos on is not one the list can be made available in.
    await placeCopies().updateOne({ _id: other() }, { $set: { trash: false } });
    assert.deepEqual(refusal(await run({ placeIds: [hex(other())] })).details, [{ field: 'placeIds.0', issue: 'notTobaccoPlace' }]);
    assert.deepEqual(await products(), []);
  });
});

describe('insertion', () => {
  it('writes new products and categories in the shape of the catalog, the way the legacy does', async () => {
    await listing(
      entry(1, { barcodes: [{ barcode: ' 8000000000011 ', quantity: 10 }, { barcode: '8000000000028', quantity: 0 }, { barcode: '8000000000035', quantity: 'ten' }, { barcode: '8000000000042', quantity: Infinity }, { barcode: '', quantity: 1 }, { barcode: 5, quantity: 1 }, 'x'] }),
      entry(2, { category: 'Trinciati', shortName: 'x' }),
      entry(3, { category: '  sigarette ', barcodes: 'none' }),
      entry(4, { category: '   ' }),
    );
    const reply = await run({ noDiscount: true });
    assert.deepEqual(counts(reply), { dryRun: false, products: { ...ZERO, inserted: 4 }, categories: { inserted: 2, duplicateNames: 0 }, duplicateCodes: 0, massDisable: { active: 0, exceeded: false } });
    const [first, second, third, fourth] = await products();
    const categories = await categoriesByName();
    assert.deepEqual(categories.map((category) => category['name']), [{ it: 'Sigarette' }, { it: 'Trinciati' }]);
    for (const category of categories) {
      assert.deepEqual([category['secondaryFiscalPrinter'], category['tgm'], category['availability'], category['status'], category['noDiscount'], category['placesAvailability'], category['parentId']], [true, { type: true }, { pos: true, ecommerce: false }, true, true, [], null]);
    }
    assert.deepEqual([first!['type'], first!['code'], first!['name'], first!['shortName'], first!['description'], first!['shortDescription']], ['tobaccos', 'T0001', { it: 'Tabacco 1' }, { it: '' }, { it: 'Descrizione 1' }, { it: '' }]);
    assert.deepEqual(first!['barcode'], [{ value: '8000000000011', qtLoad: null, qtSale: 10 }, { value: '8000000000028', qtLoad: null, qtSale: null }, { value: '8000000000035', qtLoad: null, qtSale: null }, { value: '8000000000042', qtLoad: null, qtSale: null }]);
    assert.deepEqual([first!['availability'], first!['noDiscount'], first!['status'], first!['trash'], first!['placesAvailability'], first!['categories']], [{ pos: true, warehouse: false, scales: false, ecommerce: false }, true, true, false, [], [categories[0]!['_id']]]);
    assert.deepEqual(second!['categories'], [categories[1]!['_id']]);
    assert.deepEqual(third!['categories'], [categories[0]!['_id']]);
    assert.deepEqual([third!['barcode'], fourth!['categories']], [[], []]);
    assert.ok(first!['insertDate'] instanceof Date && first!['updateDate'] instanceof Date);
    assert.deepEqual(first!['variant'], { status: false, type: 'pm', pricePercentagePlus: null, pricePercentageMinus: null, description: {} });
    // A price for every price list, the disabled one too, with the rate of 0%.
    assert.equal(first!['prices'].length, 2);
    const price = first!['prices'][0];
    assert.deepEqual(
      { ...price, id: typeof price.id },
      { id: 'string', listId: 'L1', price: 6.2, taxed: 6.2, tax: 0, taxData: { id: 'tax-0', value: 0, department: 2, description: 'Esente', natura: 'N4' }, discount: 0, currency: 'EUR', startDate: null, endDate: null, startTimeDaily: null, endTimeDaily: null, weekDays: [], fromQt: 1, maxQtSell: null },
    );
    assert.deepEqual(first!['prices'].map((item: Document) => item['listId']), ['L1', 'L2']);
  });

  it('uses the warehouse option, which the legacy lost', async () => {
    await listing(entry(1));
    await run({ warehouse: true });
    assert.equal((await byCode('T0001'))!['availability'].warehouse, true);
  });

  it('skips the entries of the list that cannot be synchronized, and counts them', async () => {
    await listing(
      entry(1),
      entry(2, { code: '' }),
      entry(3, { code: 7 }),
      entry(4, { name: '  ' }),
      entry(5, { name: 5 }),
      entry(6, { price: null }),
      entry(7, { price: Number.NaN }),
      entry(8, { price: -1 }),
      entry(9, { category: 'x'.repeat(2000) }),
      entry(10, { description: 5 }),
      entry(11, { code: 'T0001', name: 'Doppione' }),
    );
    const reply = await run();
    productCounts(reply, { inserted: 2, skipped: 8 });
    assert.deepEqual((await products()).map((product) => [product['code'], product['name'], product['description']]), [['T0001', { it: 'Tabacco 1' }, { it: 'Descrizione 1' }], ['T0010', { it: 'Tabacco 10' }, { it: '' }]]);
  });

  it('gives the products the places of the request', async () => {
    await listing(entry(1));
    await placeCopies().updateOne({ _id: other() }, { $set: { 'tgm.status': true } });
    await run({ placeIds: [hex(own()), hex(other()), hex(own())] });
    const [product] = await products();
    assert.deepEqual(product!['placesAvailability'].map((item: Document) => [hex(item['id']), item['favorite'], item['favoriteHandheld'], item['position'], item['productionCenterId']]), [[hex(own()), false, false, null, null], [hex(other()), false, false, null, null]]);
    assert.deepEqual((await categoriesByName())[0]!['placesAvailability'].map((item: Document) => [hex(item['id']), item['position'], item['productionCenterId']]), [[hex(own()), null, null], [hex(other()), null, null]]);
  });
});

describe('update', () => {
  it('rewrites what the legacy rewrites and nothing else', async () => {
    const category = legacyCategory({ name: { it: ' SIGARETTE ' }, availability: { pos: false, ecommerce: true }, placesAvailability: [other()] });
    await db.categories.insertOne(category);
    await listing(entry(1, { barcodes: [{ barcode: '8000000000011', quantity: 5 }] }));
    const old = await seed({ trash: true, status: true, noDiscount: true, availability: { pos: false, warehouse: true, scales: true, ecommerce: true }, categories: [new ObjectId()], barcode: [{ value: '1', qtLoad: 1, qtSale: 1 }], plu: '12', favorite: true, position: 4, placesAvailability: [{ id: other(), favorite: true, favoriteHandheld: true, position: 1, productionCenterId: 'x' }], prices: [legacyPrice({ id: 'keep-me', listId: 'L1', price: new Double(1), taxed: new Double(1.22) }), legacyPrice({ id: 'gone', listId: 'L9' })] });
    const reply = await run({ placeIds: [hex(own())] });
    assert.deepEqual(counts(reply).categories, { inserted: 0, duplicateNames: 0 });
    productCounts(reply, { updated: 1 });
    const now = (await byCode('T0001'))!;
    assert.deepEqual([now['noDiscount'], now['name'], now['shortName'], now['description'], now['shortDescription']], [false, { it: 'Tabacco 1', en: 'Old' }, { it: '' }, { it: 'Descrizione 1' }, { it: '' }]);
    assert.deepEqual(now['categories'], [category['_id']]);
    assert.deepEqual(now['barcode'], [{ value: '8000000000011', qtLoad: null, qtSale: 5 }]);
    assert.deepEqual([now['trash'], now['type'], now['status'], now['plu'], now['favorite'], now['position'], now['code']], [true, 'tobaccos', true, '12', true, 4, 'T0001']);
    assert.deepEqual([now['availability'].pos, now['availability'].warehouse, now['availability'].scales], [false, false, true]);
    // The availability is the one of the request, whole.
    assert.deepEqual(now['placesAvailability'].map((item: Document) => [hex(item['id']), item['favorite']]), [[hex(own()), false]]);
    assert.deepEqual(now['prices'].map((price: Document) => [price['listId'], price['id'] === 'keep-me', price['taxed'], price['tax']]), [['L1', true, 6.2, 0], ['L2', false, 6.2, 0]]);
    assert.ok(now['updateDate'] > old['updateDate']);
    // The existing category is reused as it is, availability included.
    assert.deepEqual([(await db.categories.findOne({ _id: category['_id'] }))!['placesAvailability'], (await db.categories.countDocuments())], [[other()], 1]);
  });

  it('keeps the barcodes the product has when the list has none, and the structure when the data are odd', async () => {
    await listing(entry(1), entry(2), entry(3));
    await seed({ code: 'T0001', barcode: [{ value: '1', qtLoad: 1, qtSale: 1 }] });
    await seed({ code: 'T0002', name: 'text', shortName: null, description: 5, shortDescription: [], availability: null });
    await seed({ code: 'T0003', type: 'games', noDiscount: 'no', status: false, categories: undefined, prices: undefined, placesAvailability: undefined });
    productCounts(await run(), { updated: 3 });
    assert.deepEqual((await byCode('T0001'))!['barcode'], [{ value: '1', qtLoad: 1, qtSale: 1 }]);
    const odd = (await byCode('T0002'))!;
    assert.deepEqual([odd['name'], odd['shortName'], odd['description'], odd['shortDescription'], odd['availability']], [{ it: 'Tabacco 2' }, { it: '' }, { it: 'Descrizione 2' }, { it: '' }, { pos: true, warehouse: false, scales: false, ecommerce: false }]);
    const games = (await byCode('T0003'))!;
    assert.deepEqual([games['type'], games['status'], games['noDiscount'], games['prices'].length, games['placesAvailability']], ['games', false, false, 2, []]);
  });

  it('reuses the ids of the prices it finds, and replaces the prices that are odd', async () => {
    await listing(entry(1, { category: '' }), entry(2));
    await seed({ code: 'T0001', categories: [new ObjectId()], prices: [{ listId: 'L1' }, { id: 'x' }, 'odd', legacyPrice({ id: 'first', listId: 'L2' }), legacyPrice({ id: 'second', listId: 'L2' })] });
    await seed({ code: 'T0002', prices: [] });
    productCounts(await run(), { updated: 2, inserted: 0 });
    const prices = (await byCode('T0001'))!['prices'] as Document[];
    assert.deepEqual([prices.map((price) => price['listId']), prices[1]!['id']], [['L1', 'L2'], 'second']);
    assert.deepEqual((await byCode('T0001'))!['categories'], []);
  });

  it('does not write what would not change, and a second run changes nothing', async () => {
    await listing(entry(1, { barcodes: [{ barcode: '8000000000011', quantity: 5 }] }), entry(2));
    productCounts(await run({ placeIds: [hex(own())] }), { inserted: 2 });
    const before = await products();
    productCounts(await run({ placeIds: [hex(own())] }), { unchanged: 2 });
    assert.deepEqual(await products(), before);
    // The same list with another request changes what the request decides.
    productCounts(await run({ placeIds: [] }), { updated: 2 });
  });

  it('updates every product of the code that is not in the trash, of any of the three types, and counts the extra ones', async () => {
    await listing(entry(1));
    const first = await seed({ _id: new ObjectId('000000000000000000000001'), name: { it: 'A' } });
    const second = await seed({ _id: new ObjectId('000000000000000000000002'), name: { it: 'B' } });
    const games = await seed({ _id: new ObjectId('000000000000000000000003'), type: 'games', name: { it: 'C' } });
    const reply = await run();
    assert.equal(counts(reply).duplicateCodes, 2);
    productCounts(reply, { updated: 3 });
    for (const document of [first, second, games]) {
      const now = (await db.products.findOne({ _id: document['_id'] }))!;
      assert.deepEqual([now['name'].it, now['prices'].length, now['prices'][0].taxed], ['Tabacco 1', 2, 6.2]);
    }
    assert.equal((await db.products.findOne({ _id: games['_id'] }))!['type'], 'games');
  });

  it('leaves a product in the trash alone when a product of the same code is alive, and takes the first one by id when all are in the trash', async () => {
    await listing(entry(1), entry(2));
    const dead = await seed({ _id: new ObjectId('000000000000000000000001'), trash: true, name: { it: 'Old' } });
    const live = await seed({ _id: new ObjectId('000000000000000000000002'), name: { it: 'Recreated' } });
    const trashedA = await seed({ _id: new ObjectId('000000000000000000000003'), code: 'T0002', trash: true, name: { it: 'A' } });
    const trashedB = await seed({ _id: new ObjectId('000000000000000000000004'), code: 'T0002', trash: true, name: { it: 'B' } });
    const reply = await run();
    productCounts(reply, { updated: 2 });
    assert.equal(counts(reply).duplicateCodes, 2);
    const name = async (document: Document) => (await db.products.findOne({ _id: document['_id'] }))!['name'].it;
    assert.deepEqual([await name(dead), await name(live), await name(trashedA), await name(trashedB)], ['Old', 'Tabacco 1', 'Tabacco 2', 'B']);
  });

  it('names the categories that share a name, and takes the first', async () => {
    const first = legacyCategory({ _id: new ObjectId('000000000000000000000001'), name: { it: 'Sigarette' } });
    await db.categories.insertMany([legacyCategory({ _id: new ObjectId('000000000000000000000002'), name: { it: 'sigarette' } }), first, legacyCategory({ name: { en: 'No it' } }), legacyCategory({ name: { it: 'Other' } }), legacyCategory({ name: { it: 'Other' } })]);
    await listing(entry(1));
    const reply = await run();
    assert.deepEqual(counts(reply).categories, { inserted: 0, duplicateNames: 1 });
    assert.deepEqual((await byCode('T0001'))!['categories'], [first['_id']]);
  });
});

describe('tobaccos that leave and return', () => {
  it('disables the tobaccos that are not in the list and touches nothing else', async () => {
    await listing(entry(1));
    await seed({ code: 'OLD1' });
    await seed({ code: 'OLD2', status: false });
    await seed({ code: 'OLD3', trash: true });
    await seed({ code: '' });
    await seed({ code: null });
    await seed({ code: 'GAME', type: 'games' });
    await seed({ code: 'MONO', type: 'monopoly' });
    await seed({ code: 'PLAIN', type: 'product' });
    const reply = await run({ confirmMassDisable: true });
    productCounts(reply, { inserted: 1, disabled: 1 });
    const states = Object.fromEntries((await products()).map((product) => [`${product['code'] as string}/${product['type'] as string}`, product['status']]));
    assert.deepEqual(states, { 'OLD1/tobaccos': false, 'OLD2/tobaccos': false, 'OLD3/tobaccos': true, '/tobaccos': true, 'null/tobaccos': true, 'GAME/games': true, 'MONO/monopoly': true, 'PLAIN/product': true, 'T0001/tobaccos': true });
    assert.ok((await byCode('OLD1'))!['updateDate'] instanceof Date);
  });

  it('enables again a tobacco that is disabled and is in the list, whoever disabled it', async () => {
    await listing(entry(1), entry(2), entry(3), entry(4));
    await seed({ code: 'T0001', status: false });
    await seed({ code: 'T0002', status: false, trash: true });
    await seed({ code: 'T0003', status: false, type: 'games' });
    await seed({ code: 'T0004', status: true });
    const reply = await run({ confirmMassDisable: true });
    productCounts(reply, { reactivated: 1, updated: 3 });
    assert.deepEqual((await products()).map((product) => product['status']), [true, false, false, true]);
    // The product that left comes back with the list: disabled by the first run, enabled by the next.
    await list().deleteOne({ code: 'T0004' });
    productCounts(await run({ confirmMassDisable: true }), { disabled: 1, unchanged: 3 });
    assert.equal((await byCode('T0004'))!['status'], false);
    await list().insertOne(entry(4));
    productCounts(await run(), { reactivated: 1, unchanged: 3 });
    assert.equal((await byCode('T0004'))!['status'], true);
  });
});

describe('dry run', () => {
  it('counts what would be written and writes nothing', async () => {
    await listing(entry(1), entry(2));
    await seed({ code: 'T0001' });
    await seed({ code: 'OLD' });
    const before = [await products(), await categoriesByName()];
    const mark = world.office.activity.entries.length;
    const reply = await run({}, { query: '?dryRun=true' });
    assert.deepEqual(counts(reply), { dryRun: true, products: { ...ZERO, inserted: 1, updated: 1, disabled: 1 }, categories: { inserted: 1, duplicateNames: 0 }, duplicateCodes: 0, massDisable: { active: 2, exceeded: true } });
    assert.deepEqual([await products(), await categoriesByName()], before);
    const entries = world.office.activity.entries.slice(mark);
    assert.deepEqual(entries.map((item) => item.action), ['tobaccos.synced']);
    assert.equal(entries[0]!.metadata!['dryRun'], true);
    // The real run gives the same counts.
    assert.deepEqual(counts(await run({ confirmMassDisable: true })).products, { ...ZERO, inserted: 1, updated: 1, disabled: 1 });
  });
});

describe('the log', () => {
  it('writes the summary with the parameters and the counts, and one entry for each product and category', async () => {
    await listing(entry(1), entry(2, { category: 'Trinciati' }));
    await seed({ code: 'T0001' });
    await seed({ code: 'OLD' });
    const mark = world.office.activity.entries.length;
    await run({ noDiscount: true, placeIds: [hex(own())], confirmMassDisable: true });
    const entries = world.office.activity.entries.slice(mark);
    assert.deepEqual(entries.map((item) => item.action).sort(), ['product.created', 'product.updated', 'product.updated', 'productCategory.created', 'productCategory.created', 'tobaccos.synced']);
    const summary = summaries(mark)[0]!;
    assert.deepEqual([summary.outcome, summary.groupId, summary.resource], ['success', gid(), { type: 'tobaccos' }]);
    assert.deepEqual(summary.metadata, { dryRun: false, warehouse: false, noDiscount: true, confirmMassDisable: true, massDisableExceeded: true, places: 1, inserted: 1, updated: 1, disabled: 1, reactivated: 0, unchanged: 0, skipped: 0, categoriesInserted: 2, duplicateCodes: 0, duplicateCategoryNames: 0, entries: 5, entriesOmitted: 0 });
    assert.equal(new Set(entries.map((item) => item.requestId)).size, 1);
    const disabled = entries.find((item) => item.action === 'product.updated' && item.changes?.some((change) => change.field === 'enabled'))!;
    assert.ok(disabled);
  });

  it('keeps a bounded number of entries and counts the others', async () => {
    await listing(...Array.from({ length: MAX_LOGGED_ENTRIES + 20 }, (_, index) => entry(index + 1, { category: `Categoria ${String(index % 3)}` })));
    const mark = world.office.activity.entries.length;
    const reply = await run();
    assert.equal(counts(reply).products.inserted, MAX_LOGGED_ENTRIES + 20);
    const summary = summaries(mark)[0]!;
    assert.deepEqual([summary.metadata!['entries'], summary.metadata!['entriesOmitted']], [MAX_LOGGED_ENTRIES, 23]);
    assert.equal(world.office.activity.entries.slice(mark).length, MAX_LOGGED_ENTRIES + 1);
  });
});

describe('what goes wrong', () => {
  it('runs one operation at a time on the catalog of a group, whatever the instance of the server', async () => {
    await listing(entry(1));
    let started = (): void => undefined;
    const reached = new Promise<void>((resolve) => (started = resolve));
    let release = (): void => undefined;
    hold = { started, released: new Promise<void>((resolve) => (release = resolve)) };
    const first = run({}, { segment: 'sync-held' });
    await reached;
    // Another instance (the service of the application, which has its own state) and a dry run find the group taken.
    const second = await run({});
    assert.deepEqual(refusal(second), { status: 409, code: 'CONFLICT', details: [{ field: 'group', issue: 'busy' }] });
    assert.equal((await run({}, { query: '?dryRun=true' })).status, 409);
    // The import of the workbook is excluded by the synchronization, a dry run of it too.
    const workbook = await catalogWorkbook({ categories: [{ name: 'Locale' }] });
    for (const query of ['', '?dryRun=true']) {
      limiter.reset();
      const imported = await uploadWorkbook(world, `/groups/${hex(gid())}/catalog-import${query}`, workbook, sa());
      assert.deepEqual([imported.status, imported.body.error.details], [409, [{ field: 'group', issue: 'busy' }]]);
    }
    assert.equal(await db.categories.countDocuments({ 'name.it': 'Locale' }), 0);
    release();
    assert.equal((await first).status, 200);
    assert.equal(summaries().filter((item) => item.outcome === 'failure' && item.metadata!['reason'] === 'busy').length, 2, 'the synchronization and its dry run were refused');
    assert.equal(await settings().countDocuments({ key: { $regex: '^CATALOG_LOCK:' } }), 0, 'the lock is given back');
    // And the import goes first: the synchronization finds the group taken.
    await settings().insertOne({ key: `CATALOG_LOCK:${hex(gid())}`, value: { owner: 'x', expiresAt: new Date(Date.now() + 60_000) } });
    limiter.reset();
    const blocked = await uploadWorkbook(world, `/groups/${hex(gid())}/catalog-import`, workbook, sa());
    assert.equal(blocked.status, 409);
    assert.equal((await run({})).status, 409);
    assert.equal(summaries().filter((item) => item.metadata!['reason'] === 'busy').length, 3);
    // Another group is not held up.
    assert.equal((await world.as.call(world.group(1).sa, 'GET', `/groups/${hex(world.group(1).groupId)}/tobacco-sync`)).status, 200);
  });

  it('takes over a lock that has expired, and gives the lock back after a failure', async () => {
    await listing(entry(1), entry(2, { category: 'Trinciati' }));
    for (const expiresAt of [new Date(Date.now() - 1000), 'garbage']) {
      await settings().deleteMany({});
      await settings().insertOne({ key: `CATALOG_LOCK:${hex(gid())}`, value: { owner: 'dead', expiresAt } });
      assert.equal((await run({}, { query: '?dryRun=true' })).status, 200);
      assert.equal(await settings().countDocuments({ key: { $regex: '^CATALOG_LOCK:' } }), 0);
    }
    assert.equal((await run({}, { segment: 'sync-fault' })).status, 500);
    assert.equal(await settings().countDocuments({ key: { $regex: '^CATALOG_LOCK:' } }), 0);
  });

  it('answers `503` and records the failure when the lock cannot be taken, and records any other failure outside the transaction', async () => {
    await listing(entry(1));
    assert.equal((await run({}, { segment: 'sync-nolock' })).status, 503);
    assert.equal(summaries()[0]!.metadata!['reason'], 'error');
    audit.entries.length = 0;
    assert.equal((await run({}, { segment: 'sync-nocatalogs' })).status, 500);
    assert.deepEqual(summaries().map((item) => [item.outcome, item.metadata!['reason']]), [['failure', 'error']]);
    assert.equal(await settings().countDocuments({ key: { $regex: '^CATALOG_LOCK:' } }), 0);
  });

  it('refuses to disable more than a fifth of the enabled tobaccos unless it is confirmed', async () => {
    await listing(entry(1), entry(2), entry(3));
    for (const code of ['T0001', 'T0002', 'T0003', 'T0004', 'T0005']) {
      await seed({ code });
    }
    const before = await products();
    const refused = await run({});
    assert.equal(refused.status, 409);
    assert.deepEqual(
      { ...refused.body.error, message: undefined },
      { code: 'CONFLICT', message: undefined, details: [{ field: 'group', issue: 'massDisable' }], disabled: 2, active: 5, thresholdPercent: 20 },
    );
    assert.deepEqual(await products(), before);
    assert.deepEqual([summaries()[0]!.outcome, summaries()[0]!.metadata!['reason'], summaries()[0]!.metadata!['disabled'], summaries()[0]!.metadata!['active']], ['failure', 'massDisable', 2, 5]);
    // The dry run says so and counts all the same.
    const dry = counts(await run({}, { query: '?dryRun=true' }));
    assert.deepEqual([dry.products.disabled, dry.massDisable], [2, { active: 5, exceeded: true }]);
    // Confirmed, it goes on.
    const done = counts(await run({ confirmMassDisable: true }));
    assert.deepEqual([done.products.disabled, done.massDisable], [2, { active: 5, exceeded: true }]);
    assert.deepEqual((await products()).map((product) => product['status']), [true, true, true, false, false]);
    assert.equal(summaries().at(-1)!.metadata!['confirmMassDisable'], true);
    assert.equal((await run({ confirmMassDisable: 'yes' })).status, 422);
  });

  it('disables exactly a fifth without a confirmation', async () => {
    await listing(entry(1), entry(2), entry(3), entry(4));
    for (const code of ['T0001', 'T0002', 'T0003', 'T0004', 'T0005']) {
      await seed({ code });
    }
    const reply = counts(await run({}));
    assert.deepEqual([reply.products.disabled, reply.massDisable], [1, { active: 5, exceeded: false }]);
  });

  it('undoes everything when it takes too long, categories included', async () => {
    await listing(entry(1), entry(2, { category: 'Trinciati' }));
    await seed({ code: 'T0001' });
    const before = [await products(), await categoriesByName()];
    const reply = await run({}, { segment: 'sync-slow' });
    assert.equal(reply.status, 413);
    assert.deepEqual([await products(), await categoriesByName()], before);
    assert.equal(summaries()[0]!.metadata!['reason'], 'tooSlow');
  });

  it('counts the time from the lock, the read of the price list included', async () => {
    await listing(entry(1));
    const reply = await run({}, { segment: 'sync-slowlist' });
    assert.equal(reply.status, 413);
    assert.deepEqual(await products(), []);
    assert.equal(summaries()[0]!.metadata!['reason'], 'tooSlow');
    assert.equal(await settings().countDocuments({ key: { $regex: '^CATALOG_LOCK:' } }), 0, 'the lock is given back');
  });

  it('undoes everything when something fails in the middle', async () => {
    await listing(entry(1), entry(2, { category: 'Trinciati' }));
    const reply = await run({}, { segment: 'sync-fault' });
    assert.equal(reply.status, 500);
    assert.deepEqual([await products(), await categoriesByName()], [[], []]);
    assert.equal(summaries()[0]!.metadata!['reason'], 'error');
  });

  it('refuses what is too big', async () => {
    await listing(entry(1), entry(2), entry(3));
    assert.equal((await run({}, { segment: 'sync-small' })).status, 413);
    assert.equal(summaries()[0]!.metadata!['reason'], 'tooLarge');
    await list().deleteOne({ code: 'T0003' });
    await seed({ code: 'A' });
    await seed({ code: 'B' });
    assert.equal((await run({}, { segment: 'sync-small' })).status, 413);
    await db.products.deleteMany({});
    await db.categories.insertMany([legacyCategory(), legacyCategory()]);
    assert.equal((await run({}, { segment: 'sync-small' })).status, 413);
  });

  it('answers `503` from the transaction as an error it records', async () => {
    await listing(entry(1));
    assert.equal((await run({}, { segment: 'sync-unavailable' })).status, 503);
    assert.equal(summaries()[0]!.metadata!['reason'], 'error');
  });

  it('works for a client with no address, entries included', async () => {
    await listing(entry(1), entry(2));
    const principal = principalOf('SA', { groupId: gid(), userId: sa() });
    const access = await accessWithFeatures(principal);
    const service = serviceWith();
    const client = { requestId: 'req-1', ip: null, userAgent: null } as const;
    assert.equal((await service.sync(principal, access, {}, true, client)).products.inserted, 2);
    assert.equal((await service.sync(principal, access, {}, false, client)).products.inserted, 2);
    assert.equal(audit.entries.filter((item) => item.ip !== undefined).length, 0);
    assert.equal(audit.entries.length, 5);
    await assert.rejects(service.sync(principal, access, { warehouse: false, placeIds: [new ObjectId()] }, false, client), (error: AppError) => error.code === 'VALIDATION_ERROR');
  });

  it('limits how often a user starts it, a dry run on its own account', async () => {
    await listing(entry(1));
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await world.as.call(sa(), 'POST', path(), {}, { 'idempotency-key': randomUUID() })).status, 200);
    }
    assert.equal((await world.as.call(sa(), 'POST', path(), {}, { 'idempotency-key': randomUUID() })).status, 429);
    assert.equal((await world.as.call(sa(), 'POST', path('?dryRun=true'), {}, { 'idempotency-key': randomUUID() })).status, 200);
    limiter.reset();
  });

  it('answers the same request with the same answer, once', async () => {
    await listing(entry(1));
    const key = randomUUID();
    const first = await run({}, { key });
    const again = await run({}, { key });
    assert.deepEqual([first.status, again.status, again.body], [200, 200, first.body]);
    assert.equal(summaries().length, 1);
    // The same key with the other mode is another request.
    assert.equal((await run({}, { key, query: '?dryRun=true' })).status, 409);
    assert.equal((await run({ noDiscount: true }, { key })).status, 409);
  });
});

describe('the limits of the catalog on the price list', () => {
  it('skips an entry that is outside them, and never disables anything for it', async () => {
    const barcodes = (count: number) => Array.from({ length: count }, (_, index) => ({ barcode: String(8000000000000 + index), quantity: 1 }));
    await listing(
      entry(1, { name: '  Tabacco  uno  ', category: '  Trinciati ', barcodes: [{ barcode: '8000000000011', quantity: 7.9 }, { barcode: ' 8000000000011 ', quantity: 3 }, { barcode: '8000000000028', quantity: -3 }, { barcode: '8000000000035', quantity: MAX_BARCODE_QUANTITY }] }),
      entry(2, { name: 'Con\u0007controllo' }),
      entry(3, { name: 'x'.repeat(151) }),
      entry(4, { code: 'x'.repeat(65) }),
      entry(5, { code: 'T\u0000005' }),
      entry(6, { category: 'Con\u001Fcontrollo' }),
      entry(7, { category: 'x'.repeat(151) }),
      entry(8, { barcodes: [{ barcode: 'x'.repeat(65), quantity: 1 }] }),
      entry(9, { barcodes: [{ barcode: '80000\u000700009', quantity: 1 }] }),
      entry(10, { barcodes: [{ barcode: '8000000000100', quantity: MAX_BARCODE_QUANTITY + 1 }] }),
      entry(11, { barcodes: barcodes(101) }),
      entry(12, { price: MAX_PRICE + 1 }),
      entry(13, { description: 'Riga uno\nriga due' }),
      entry(14, { description: 'Con\u0007controllo' }),
      entry(15, { barcodes: barcodes(100) }),
      entry(16, { price: MAX_PRICE }),
    );
    await seed({ code: 'T0002' });
    await seed({ code: 'T0006' });
    const reply = await run({});
    productCounts(reply, { inserted: 5, skipped: 11 });
    const [one, thirteen, fourteen, fifteen, sixteen] = (await products()).filter((product) => !['T0002', 'T0006'].includes(product['code'] as string));
    assert.deepEqual([one!['name'], one!['categories'].length, (await categoriesByName())[0]!['name']], [{ it: 'Tabacco  uno' }, 1, { it: 'Trinciati' }]);
    assert.deepEqual(one!['barcode'], [{ value: '8000000000011', qtLoad: null, qtSale: 7 }, { value: '8000000000028', qtLoad: null, qtSale: null }, { value: '8000000000035', qtLoad: null, qtSale: MAX_BARCODE_QUANTITY }]);
    assert.deepEqual([thirteen!['description'], fourteen!['description'], fifteen!['barcode'].length, sixteen!['prices'][0].taxed], [{ it: 'Riga uno\nriga due' }, { it: '' }, 100, MAX_PRICE]);
    // The products of the skipped entries were left as they were: enabled, nothing disabled.
    assert.deepEqual([(await byCode('T0002'))!['status'], (await byCode('T0006'))!['status']], [true, true]);
  });
});

describe('what is refused', () => {
  it('does not give a dealer of another group the group', async () => {
    assert.equal((await world.as.call(world.office.cluster.dealerB, 'GET', path())).status, 404);
    assert.equal((await run({}, { actor: world.office.cluster.dealerB })).status, 404);
  });

  it('limits the dry runs on their own bucket', async () => {
    await listing(entry(1));
    limiter.reset();
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await world.as.call(sa(), 'POST', path('?dryRun=true'), {}, { 'idempotency-key': randomUUID() })).status, 200);
    }
    const refused = await world.as.call(sa(), 'POST', path('?dryRun=true'), {}, { 'idempotency-key': randomUUID() });
    assert.equal(refused.status, 429);
    // The real synchronizations have their own bucket.
    assert.equal((await world.as.call(sa(), 'POST', path(), {}, { 'idempotency-key': randomUUID() })).status, 200);
    limiter.reset();
  });

  it('needs the Idempotency-Key', async () => {
    const reply = await world.as.call(sa(), 'POST', path(), {});
    assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'Idempotency-Key', issue: 'required' }]]);
  });

  it('refuses operators of the database in the body', async () => {
    for (const body of [{ $set: {} }, { placeIds: [{ $ne: null }] }, { warehouse: { $ne: false } }, { noDiscount: { $gt: 0 } }, { placeIds: { $in: [] } }, { 'placeIds.0': 'x' }]) {
      const reply = await run(body);
      assert.equal(reply.status, 422, JSON.stringify(body));
      assert.deepEqual(await products(), []);
    }
  });
});

describe('the last synchronization is read with its index', () => {
  it('uses the index of the action and the date', async () => {
    const [filter, options] = lastSyncQuery(gid());
    assert.equal(options.hint, LAST_SYNC_INDEX);
    const explain = await ctx.databases.common().collection('activityEvents').find(filter, options).explain('queryPlanner');
    assert.match(JSON.stringify(explain['queryPlanner']), /"indexName":"action_1_at_-1"/);
  });
});

describe('the lock of the catalog', () => {
  it('is given to one of many that ask at the same time', async () => {
    await settings().deleteMany({});
    const lock = createCatalogLock({ databases: ctx.databases, logger: memoryLogger().logger });
    const results = await Promise.all(Array.from({ length: 12 }, () => lock.acquire(gid())));
    assert.equal(results.filter((held) => held !== null).length, 1);
    await results.find((held) => held !== null)!.release();
    assert.equal(await settings().countDocuments({ key: { $regex: '^CATALOG_LOCK:' } }), 0);
  });

  let fail = new Set<string>();
  const faulty = (): typeof ctx.databases => ({
    ...ctx.databases,
    common: () =>
      new Proxy(ctx.databases.common(), {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property, target);
          if (property !== 'collection') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (name: string) =>
            new Proxy(target.collection(name), {
              get: (collection, operation) => {
                const member: unknown = Reflect.get(collection, operation, collection);
                return typeof member === 'function' ? (...args: unknown[]) => (fail.has(`dup:${String(operation)}`) ? Promise.reject(Object.assign(new Error('dup'), { code: 11000 })) : fail.has(String(operation)) ? Promise.reject(new Error('down')) : (member as (...call: unknown[]) => unknown).apply(collection, args)) : member;
              },
            });
        },
      }),
  });

  it('is taken by one, renewed, lost and given back, and never fails a release', async () => {
    fail = new Set();
    const messages = memoryLogger();
    const lock = createCatalogLock({ databases: faulty(), logger: messages.logger, lifetimeMs: 60_000 });
    const mine = (await lock.acquire(gid()))!;
    assert.equal(await lock.acquire(gid()), null);
    const document = (await settings().findOne({ key: `CATALOG_LOCK:${hex(gid())}` }))!;
    // The expiry is the clock of the database plus the lifetime, and so is the comparison: a lock that is valid for the database is not free whatever the clock of this server says.
    const left = (document['value'].expiresAt as Date).getTime() - Date.now();
    assert.ok(left > 50_000 && left <= 61_000, String(left));
    const dbNow = (await ctx.databases.common().collection('settings').aggregate([{ $limit: 1 }, { $project: { _id: 0, now: '$$NOW' } }]).toArray())[0]!['now'] as Date;
    assert.ok(Math.abs(dbNow.getTime() - Date.now()) < 5000);
    await mine.renew();
    const renewed = (await settings().findOne({ _id: document['_id'] }))!['value'].expiresAt as Date;
    assert.ok(renewed.getTime() >= (document['value'].expiresAt as Date).getTime());
    // A holder that lost it (it expired and another took it) cannot renew, and its release leaves the other's lock alone.
    await settings().updateOne({ _id: document['_id'] }, { $set: { 'value.owner': 'other' } });
    await assert.rejects(mine.renew(), (error: AppError) => error.code === 'CONFLICT' && error.details![0]!.issue === 'busy');
    await mine.release();
    assert.equal(await settings().countDocuments({ key: `CATALOG_LOCK:${hex(gid())}` }), 1);
    await settings().deleteMany({});
    // The database fails: nothing is taken (503), a renewal fails (503), a release is only logged and the lock expires by itself.
    const again = (await lock.acquire(gid()))!;
    fail = new Set(['updateOne']);
    await assert.rejects(again.renew(), (error: AppError) => error.code === 'SERVICE_UNAVAILABLE');
    fail = new Set(['dup:findOneAndUpdate']);
    assert.equal(await lock.acquire(world.group(1).groupId), null, 'a duplicate key means taken');
    fail = new Set(['updateOne', 'findOneAndUpdate']);
    await assert.rejects(lock.acquire(world.group(1).groupId), (error: AppError) => error.code === 'SERVICE_UNAVAILABLE');
    fail = new Set(['deleteOne']);
    await again.release();
    assert.ok(messages.events.length >= 3);
    fail = new Set();
    await settings().deleteMany({});
  });
});

describe('the summary of a synchronization, as the real activity log stores it', () => {
  it('is accepted by the log with every metadata key it carries, and nothing in it is redacted', async () => {
    await listing(entry(1));
    const mark = world.office.activity.entries.length;
    assert.equal((await run({}, { query: '?dryRun=true' })).status, 200);
    assert.equal((await run({})).status, 200);
    const found = summaries(mark);
    assert.ok(found.length >= 2);
    const { stored, refused } = await throughRealLog(ctx, found);
    assert.deepEqual(refused, []);
    assert.equal(stored.length, found.length);
    assert.ok(!JSON.stringify(stored.map((event) => event['metadata'])).includes('REDACTED'));
  });
});
