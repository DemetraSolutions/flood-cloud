import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { PRODUCTS_OWNED_FIELDS } from '../../src/db/collections.ts';
import type { ClientContext } from '../../src/shared/http/client-context.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import type { GroupAccess } from '../../src/shared/security/scope/group-access.ts';
import { assertPlacesInPerimeter, isEditableProduct, isVisibleProduct, productPlacesDocument, productPlacesOf, samePlaces, shownProductPlaces } from '../../src/modules/products/products.availability.ts';
import { blankProduct, duplicateProduct, mediaWrites, productLoggable } from '../../src/modules/products/products.document.ts';
import { componentsOf, costsOf, familyOf, idOf, idsOf, menuOf, modifierTypeOf, productRow, productView, stockOf, suppliersOf, totalStock, typeOf } from '../../src/modules/products/products.mapper.ts';
import { grossOf, instantOf, listedPrice, netOf, priceDocument, priceView } from '../../src/modules/products/products.pricing.ts';
import { cyclicComponents, planProduct } from '../../src/modules/products/products.plan.ts';
import type { PlanDeps } from '../../src/modules/products/products.plan.ts';
import { createProductsRepository } from '../../src/modules/products/products.repository.ts';
import { usableRate } from '../../src/modules/products/products.pricing.ts';
import { createProductsService, productVersion } from '../../src/modules/products/products.service.ts';
import type { ProductsServiceDeps } from '../../src/modules/products/products.service.ts';
import { memoryActivityLog } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { principalOf } from '../helpers/principal.ts';
import { legacyFullProduct, legacyPrice, placeEntry } from '../helpers/products.ts';

const groupId = fixtureId('group', 1);
const own = fixtureId('place', 1);
const other = fixtureId('place', 2);
const sa = principalOf('SA', { groupId });
const pa = principalOf('PA', { groupId, placeIds: [own] });
const ca = principalOf('CA', { groupId, placeIds: [own], companyIds: [fixtureId('company', 1)] });
const FEATURES = { cash: true, warehouse: true, rooms: true, productsVariants: true, services: true, scales: true, media: true, ordering: true, customersApp: true, tobaccosGamesMonopoly: true };
const access = { groupId, clusterId: 'cluster0', crossGroup: false, features: FEATURES } as unknown as GroupAccess;
const bare = { ...access, features: {} } as unknown as GroupAccess;
const client: ClientContext = { requestId: 'r1', ip: '10.0.0.1', userAgent: null };
const key = Buffer.alloc(32, 7);
const hex = (id: ObjectId) => id.toHexString();
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const reject = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

describe('the availability of a product', () => {
  it('reads every form of the list, and rewrites a list that is not one', () => {
    const id = new ObjectId();
    const stored = productPlacesOf([id, placeEntry(id, { favorite: true, position: new Int32(2) }), 5, { id: 'x' }, placeEntry(other)]);
    assert.deepEqual([stored.entries.length, stored.length, stored.anomalous, stored.historical], [2, 5, true, true]);
    assert.deepEqual(productPlacesOf(undefined), { entries: [], length: 0, anomalous: false, historical: false });
    assert.deepEqual(shownProductPlaces(pa, [placeEntry(own), placeEntry(other)]).map((entry) => entry.placeId), [hex(own)]);
    assert.equal(shownProductPlaces(sa, [placeEntry(own), placeEntry(other)]).length, 2);
    assert.equal(isVisibleProduct(pa, [5, { id: 'x' }]), false);
    assert.equal(isVisibleProduct(pa, undefined), true);
    assert.deepEqual([isVisibleProduct(pa, null), isVisibleProduct(pa, []), isVisibleProduct(pa, 'x'), isVisibleProduct(pa, 5), isVisibleProduct(pa, { id: own })], [true, true, false, false, false]);
    assert.equal(isVisibleProduct(sa, [placeEntry(other)]), true);
    assert.equal(isEditableProduct(pa, [placeEntry(own), 5]), false);
    assert.equal(isEditableProduct(sa, undefined), true);
    assert.deepEqual(productPlacesDocument(pa, 'not a list', [{ placeId: hex(own), favorite: false, favoriteHandheld: false, position: null, productionCenterId: null }]).map((element) => hex(element['id'] as ObjectId)), [hex(own)]);
    const kept = productPlacesDocument(pa, [placeEntry(other), 5, placeEntry(own, { extra: 1 })], []);
    assert.equal(kept.length, 2);
    assert.equal(samePlaces([placeEntry(own)], [placeEntry(own)]), true);
    assert.equal(samePlaces([own], [placeEntry(own)]), false);
    assert.equal(samePlaces([placeEntry(own), placeEntry(other)], [placeEntry(other), placeEntry(own)]), true);
    assert.doesNotThrow(() => assertPlacesInPerimeter(sa, [hex(other)], 0));
    assert.throws(() => assertPlacesInPerimeter(pa, [hex(other)], 1), reject('FORBIDDEN'));
  });
});

describe('the documents of the products', () => {
  it('writes the keys of the media where they can be written', () => {
    assert.deepEqual(mediaWrites({ images: { main: {} } }, { gallery: null, main: null }), { set: {}, unset: { 'medias.images.main': '' } });
    assert.deepEqual(mediaWrites({ images: 'x' }, { main: null }), { set: {}, unset: {} });
    assert.deepEqual(mediaWrites(undefined, { gallery: null }), { set: {}, unset: {} });
    assert.deepEqual(mediaWrites({ images: { a: 1 } }, { externalUrl: 'https://x.test' }), { set: { 'medias.images.externalUrl': 'https://x.test' }, unset: {} });
  });

  it('copies a product without what must not be copied, whatever the stock and the names look like', () => {
    const id = new ObjectId();
    const copy = duplicateProduct(legacyFullProduct({ quantity: 'no', name: 'text', integrations: undefined }), id, new Date(5));
    assert.deepEqual([copy['quantity'], copy['name'], copy['integrations']], [{}, {}, { floodOrders: false, easyappear: false, yellgo: false, leggimenu: false }]);
    const stocked = duplicateProduct(legacyFullProduct({ quantity: { __a: { __b: { value: 4 }, __c: 5 }, __d: 'x' } }), id, new Date(5));
    assert.deepEqual(stocked['quantity'], { __a: { __b: { value: 0, min: null, max: null, location: null } } });
    const blank = blankProduct({ id, type: 'service', isModifier: true, now: new Date(7) });
    assert.deepEqual([blank['type'], (blank['variant'] as Document)['status'], blank['insertDate']], ['service', true, new Date(7)]);
  });

  it('logs what a product has, cut and counted, and only the places and the references a restricted actor reaches', () => {
    const modifier = new ObjectId();
    const document = legacyFullProduct({
      attributes: 'no',
      medias: { images: { gallery: 'no', main: { _id: 'm', basename: 'a.png' }, externalUrl: 'https://a.test/x?token=1' } },
      variant: { status: true, type: 'zz' },
      variants: [modifier],
      barcode: Array.from({ length: 30 }, (_, index) => ({ value: String(index) })),
      placesAvailability: [placeEntry(own), placeEntry(other)],
      printStations: { [`__${hex(own)}`]: ['a'], [`__${hex(other)}`]: ['b'] },
      quantity: { [`__${hex(own)}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { min: 1 } }, [`__${hex(other)}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: { min: 2 } } },
    });
    const all = productLoggable(sa, document);
    assert.deepEqual([all['attributes'], all['gallery'], all['externalUrl'], all['modifier']], [{ count: 0, first: [] }, { count: 0, first: [] }, 'https://a.test/x', { type: null, plus: null, minus: null }]);
    assert.deepEqual([(all['barcodes'] as { count: number; first: unknown[] }).count, (all['barcodes'] as { first: unknown[] }).first.length, (all['places'] as { count: number }).count, (all['modifiers'] as { count: number }).count], [30, 20, 2, 1]);
    const restricted = productLoggable(pa, document);
    assert.deepEqual([restricted['hasBrand'], restricted['suppliers'], 'brandId' in restricted, all['brandId']], [false, { count: 0 }, false, null]);
    assert.deepEqual([(restricted['places'] as { count: number }).count, restricted['modifiers'], (restricted['stock'] as { count: number }).count, (restricted['printStations'] as { count: number }).count, restricted['components']], [1, { count: 1 }, 1, 1, { count: 0 }]);
    assert.equal(productLoggable(sa, legacyFullProduct({ variant: undefined, medias: undefined })).modifier, null);
  });
});

describe('the reads of a product', () => {
  it('knows the types, the families and the references of any stored value', () => {
    assert.deepEqual([typeOf('service'), typeOf('gift'), typeOf(undefined)], ['service', null, null]);
    assert.deepEqual([familyOf({ type: 'exempt' }), familyOf({ type: 'games' }), familyOf({ type: 'service', variant: { status: true } }), familyOf({})], ['products', 'tgm', 'modifiers', 'products']);
    const id = new ObjectId();
    assert.deepEqual(idsOf([id, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'x', 4]), [hex(id), 'aaaaaaaaaaaaaaaaaaaaaaaa']);
    assert.deepEqual([idOf(id), idOf('x'), idOf(undefined)], [hex(id), null, null]);
    assert.deepEqual([modifierTypeOf('pm'), modifierTypeOf('i'), modifierTypeOf('zz'), modifierTypeOf(undefined)], ['addRemove', 'info', null, null]);
    assert.deepEqual(componentsOf([{ _id: id, quantity: 2 }, { quantity: 1 }, 4]), [{ productId: hex(id), quantity: 2, waste: null }]);
    assert.deepEqual(menuOf([{ categoryId: id, quantity: 2, exit: 3 }], { rooms: false }), [{ categoryId: hex(id), quantity: 2, productIds: [] }]);
    assert.deepEqual(suppliersOf([{ id, deliveryTime: 2, deliveryTimeUnit: 'days' }, { id: 'zz', delivetyTime: 5 }]).map((supplier) => [supplier.contactId, supplier.deliveryTime, supplier.deliveryTimeUnit]), [[hex(id), 2, 'days'], [null, 5, null]]);
    assert.deepEqual([costsOf(undefined).bySupplier, costsOf({ suppliers: 'x', total: 5 }).last], [{}, null]);
    assert.equal(totalStock({ __aaaaaaaaaaaaaaaaaaaaaaaa: { __bbbbbbbbbbbbbbbbbbbbbbbb: { value: new Double(0.1) }, __cccccccccccccccccccccccc: { value: new Double(0.2) } } }, null), 0.3);
    assert.equal(totalStock('no', null), null);
    assert.deepEqual(stockOf({ [`__${hex(own)}`]: { __aaaaaaaaaaaaaaaaaaaaaaaa: 4 } }, null), { [hex(own)]: {} });
  });

  it('shows a product with the fields of the functions of the group only, and a row with the name it has', () => {
    const document = legacyFullProduct({ name: undefined });
    assert.equal(productView(document, sa, { ...FEATURES, productsVariants: false } as never).name !== undefined, true);
    const shown = productView(legacyFullProduct({ variant: { status: true, type: 'p' } }), sa, { ...FEATURES, media: false, productsVariants: false } as never);
    assert.ok(!('modifier' in shown) && !('image' in shown) && !('modifierChoices' in shown));
    assert.equal(productRow(document, sa, FEATURES as never, 'it', null).name, null);
    assert.equal(productRow(legacyFullProduct({ name: { en: 'Water' } }), sa, FEATURES as never, 'it', null).name, 'Water');
  });

  it('reads the price rules and picks the one the list shows', () => {
    assert.equal(instantOf(new Date('x')), null);
    assert.equal(instantOf(5), null);
    assert.deepEqual([netOf(122, 22), grossOf(100, 22)], [100, 122]);
    assert.equal(priceView({ taxData: 'x' }).tax, null);
    assert.equal(listedPrice([], null), null);
    assert.equal(listedPrice([legacyPrice({ listId: 'a', price: 10, tax: 22 })], 'b'), null);
    assert.equal(listedPrice([legacyPrice({ listId: 'a', price: 10, tax: 22, discount: 'x' })], 'a'), 12.2);
    assert.equal(listedPrice([legacyPrice({ listId: 'a', price: Number.NaN, taxed: Number.NaN })], 'a'), null);
    assert.equal(listedPrice([legacyPrice({ listId: 'a', price: 10, tax: undefined, taxData: undefined, taxed: 11 })], 'a'), 11);
    const tax = { id: 't', rate: 10, department: null, description: null, vatNature: null };
    const written = priceDocument({ priceListId: 'l', currency: 'EUR', taxId: 't', net: 10, maxSaleQuantity: 3 }, tax, 'p1', { id: 'p1', taxData: 'junk' });
    assert.deepEqual([written['taxed'], written['fromQt'], written['maxQtSell'], written['taxData']], [11, 1, 3, { id: 't', value: 10, department: null, description: null, natura: null }]);
  });
});

/** The collaborators of the planner that never reach a database. */
function planDeps(overrides: Partial<Record<keyof PlanDeps, unknown>> = {}): PlanDeps {
  return {
    repository: { invalid: async () => [], componentsOf: async () => new Map() },
    links: { invalid: async () => [] },
    places: { setupOf: async () => new Map() },
    references: { missing: async () => [] },
    catalogs: { list: async () => [] },
    images: { imageSource: async () => null },
    languages: { of: async () => ['it'] },
    users: { findById: async () => ({ user: { language: 'it' } }) },
    newElementId: () => 'new-id',
    ...overrides,
  } as unknown as PlanDeps;
}

describe('the planner of the writes, with collaborators that fail in the ways a database can', () => {
  const id = new ObjectId();
  const stored = legacyFullProduct({ _id: id });

  it('answers 404 when the caller disappeared since the authentication', async () => {
    await assert.rejects(planProduct(planDeps({ users: { findById: async () => null } }), { principal: sa, access, id, stored, body: { name: { it: 'x' } }, creating: false }), reject('NOT_FOUND'));
  });

  it('walks the bills of materials, refuses one it cannot read to the end, and knows a product that is its own component', async () => {
    const calls: string[][] = [];
    const a = hex(new ObjectId());
    const wide = planDeps({
      repository: {
        invalid: async () => [],
        componentsOf: async (_p: unknown, _a: unknown, ids: string[]) => {
          calls.push(ids);
          return new Map(ids.map((component) => [component, Array.from({ length: 600 }, () => hex(new ObjectId()))]));
        },
      },
    });
    assert.equal(await cyclicComponents(wide, { principal: sa, access, id }, [a]), null);
    assert.equal(calls.length, 2);
    const finished = planDeps({ repository: { componentsOf: async () => new Map([[a, [hex(id)]]]) } });
    assert.deepEqual(await cyclicComponents(finished, { principal: sa, access, id }, [a, a, hex(id)]), [0, 2]);
    const tooMany = await planProduct(wide, { principal: sa, access, id, stored, body: { components: [{ productId: a, quantity: 1 }] }, creating: false });
    assert.deepEqual(tooMany.issues, [{ field: 'components', issue: 'tooMany' }]);
  });

  it('writes the supplier price lists, the empty supplier list of a document that has none, and the empty values of a menu', async () => {
    const supplier = hex(new ObjectId());
    const empty = await planProduct(planDeps(), { principal: sa, access, id, stored: legacyFullProduct({ _id: id, suppliers: undefined }), body: { suppliers: [] }, creating: false });
    assert.deepEqual(empty.set['suppliers'], []);
    const written = await planProduct(planDeps(), { principal: sa, access, id, stored, body: { suppliers: [{ contactId: supplier, priceLists: [{ id: 'l' }] }] }, creating: false });
    assert.deepEqual((written.set['suppliers'] as Document[])[0]!['companyLists'], [{ id: 'l', price: null, discount1: null, discount2: null, discount3: null }]);
  });

  it('keeps the quantity apart from the version', () => {
    const document = legacyFullProduct({ quantity: { __a: { __b: { value: 1, min: 2 } } }, lastAveragePrice: { total: { lastPrice: 1 } } });
    const before = productVersion(document, key);
    assert.equal(productVersion({ ...document, quantity: { __a: { __b: { value: 99, min: 2 } } }, lastAveragePrice: { total: { lastPrice: 9 } }, tags: ['x'] }, key), before);
    assert.notEqual(productVersion({ ...document, quantity: { __a: { __b: { value: 1, min: 3 } } } }, key), before);
    assert.ok(!PRODUCTS_OWNED_FIELDS.includes('integrations.easyappear') === false);
    assert.equal(productVersion({ ...document, quantity: 'junk' }, key).length, 43);
    assert.equal(productVersion({ ...document, quantity: { x: 5, __a: [] } }, key).length, 43);
  });
});

/** The collaborators of the service that never reach a database. */
function fakes(stored: Document | null, options: { language?: string | null; update?: Array<'updated' | 'conflict'>; setTrash?: boolean; removeTrashed?: boolean; componentsOf?: Array<Map<string, string[]>>; lists?: unknown[] } = {}) {
  const logs = memoryLogger();
  const updates = [...(options.update ?? ['updated'])];
  const reads = [...(options.componentsOf ?? [new Map<string, string[]>()])];
  const calls: Document[] = [];
  const log = memoryActivityLog();
  const repository = {
    list: async () => ({ items: [], page: { limit: 50, next: null } }),
    findById: async () => stored,
    insert: async () => undefined,
    update: async (_p: unknown, _a: unknown, _id: unknown, change: Document) => {
      calls.push(change);
      return updates.shift() ?? 'updated';
    },
    usingValues: async () => [{ _id: new ObjectId(), code: 'DUP', barcode: 'junk' }, { _id: new ObjectId(), code: 'DUP', barcode: [{ value: 5 }, null, { value: 'B' }], placesAvailability: [] }],
    invalid: async () => [],
    componentsOf: async () => (reads.length > 1 ? reads.shift()! : reads[0]!),
    users: async () => [],
    categoriesWithModifier: async () => [],
    serviceUsers: async () => [],
    setTrash: async () => options.setTrash ?? true,
    removeTrashed: async () => options.removeTrashed ?? true,
    trashedIds: async () => [],
    countTrashed: async () => 0,
  };
  const deps = {
    repository,
    links: { invalid: async () => [] },
    places: { setupOf: async () => new Map() },
    references: { missing: async () => [] },
    catalogs: { list: async () => options.lists ?? [] },
    images: { imageSource: async () => null },
    languages: { of: async () => ['it'] },
    users: { findById: async () => (options.language === null ? null : ({ user: { language: options.language ?? 'it' } } as never)) },
    activityLog: log,
    logger: logs.logger,
    versionKey: key,
    now: () => 5000,
  } as unknown as ProductsServiceDeps;
  return { service: createProductsService(deps), logs, calls, log };
}

describe('the service of the products, with collaborators that fail in the ways a database can', () => {
  const stored = legacyFullProduct({ updateDate: new Date(1000), code: 'DUP', barcode: [{ value: 'B' }, { value: 5 }, { value: '' }] });
  const id = stored['_id'] as ObjectId;
  const version = productVersion(stored, key);

  it('answers 404 when the caller disappeared since the authentication', async () => {
    await assert.rejects(fakes(stored, { language: null }).service.list(sa, access, {}), reject('NOT_FOUND'));
  });

  it('answers 409 when the product changed, was trashed or was deleted while the request ran', async () => {
    await assert.rejects(fakes(stored, { update: ['conflict'] }).service.update(sa, access, id, version, { enabled: false }, client), reject('CONFLICT'));
    await assert.rejects(fakes(stored, { setTrash: false }).service.trash(sa, access, id, version, client), reject('CONFLICT'));
    const trashed = { ...stored, trash: true };
    await assert.rejects(fakes(trashed, { removeTrashed: false }).service.remove(sa, access, id, productVersion(trashed, key), client), reject('CONFLICT'));
    await assert.rejects(fakes(null).service.get(sa, access, id), reject('NOT_FOUND'));
  });

  it('warns about the values another product uses, whatever shape its barcodes have, and lists without a default price list', async () => {
    const reply = await fakes(stored).service.get(sa, access, id);
    assert.deepEqual(reply.entity.warnings!.map((warning) => [warning.field, warning.productIds.length, warning.others]), [['code', 2, 0], ['barcodes.0', 1, 0]]);
    const page = await fakes(stored, { lists: [{ id: 'l', isDefault: false }] }).service.list(sa, access, {});
    assert.deepEqual(page.items, []);
  });

  it('undoes a write that left a cycle behind, and says so in the log when it cannot', async () => {
    const component = new ObjectId();
    const cycle = new Map([[hex(component), [hex(id)]]]);
    const body = { components: [{ productId: hex(component), quantity: 1 }] };
    const done = fakes(stored, { componentsOf: [new Map(), cycle] });
    await assert.rejects(done.service.update(sa, access, id, version, body, client), (error: unknown) => error instanceof AppError && error.code === 'CONFLICT' && error.details![0]!.field === 'components');
    assert.equal(done.calls.length, 2);
    assert.deepEqual(Object.keys(done.calls[1]!['set'] as Document), ['bundleProducts']);
    // The undo holds only while the field is what this request wrote.
    assert.deepEqual(Object.keys(done.calls[1]!['readValues'] as Document), ['bundleProducts']);
    assert.deepEqual(plain((done.calls[1]!['readValues'] as Document)['bundleProducts']), [{ _id: hex(component), quantity: 1, waste: null }]);
    assert.deepEqual(done.logs.events.filter((entry) => entry['level'] === 'error'), []);
    const failed = fakes(stored, { componentsOf: [new Map(), cycle], update: ['updated', 'conflict'] });
    await assert.rejects(failed.service.update(sa, access, id, version, body, client), reject('CONFLICT'));
    assert.equal(failed.logs.events.filter((entry) => entry['level'] === 'error').length, 1);
    // A write whose touched field the stored document lacks is undone by removing it.
    const lacking = legacyFullProduct({ updateDate: new Date(1000), bundleProducts: undefined });
    const undo = fakes(lacking, { componentsOf: [new Map(), new Map([[hex(component), [hex(lacking['_id'] as ObjectId)]]])] });
    await assert.rejects(undo.service.update(sa, access, lacking['_id'] as ObjectId, productVersion(lacking, key), body, client), reject('CONFLICT'));
    assert.deepEqual(undo.calls[1]!['unset'], { bundleProducts: '' });
  });

  it('records the events with and without the address of the actor', async () => {
    const quiet = fakes(stored);
    await quiet.service.update(sa, access, id, version, { enabled: false }, { ...client, ip: null });
    await quiet.service.update(sa, access, id, version, { enabled: false }, client);
    assert.deepEqual(quiet.log.entries.map((entry) => 'ip' in entry), [false, true]);
    // A place administrator and a company administrator are told the same.
    for (const actor of [pa, ca]) {
      await assert.rejects(fakes(stored).service.update(actor, bare, id, version, { code: 'x' }, client), reject('FORBIDDEN'));
    }
    assert.ok(bare);
  });
});

describe('the last barrier of the writes to the products', () => {
  it('refuses to write the quantity as a whole, or its value, or the costs', async () => {
    const repository = createProductsRepository({} as never);
    const id = new ObjectId();
    const place = `quantity.__${hex(own)}`;
    for (const path of ['quantity', 'quantity.__a', place, `${place}.__${'a'.repeat(24)}`, `${place}.__${'a'.repeat(24)}.value`, 'lastAveragePrice', 'lastAveragePrice.total.lastPrice', 'tags', 'parentId', 'integrations.easyappear']) {
      await assert.rejects(repository.update({} as never, {} as never, id, { set: { [path]: 1 }, unset: {}, updateDate: new Date(), readPlaces: undefined }, undefined), /not an owned field/, path);
      await assert.rejects(repository.update({} as never, {} as never, id, { set: {}, unset: { [path]: '' }, updateDate: new Date(), readPlaces: undefined }, undefined), /not an owned field/, path);
    }
  });
});

describe('the rules of a tax rate, the bulk trash and the check of the cycles', () => {
  it('uses only a rate that can be divided by', () => {
    assert.deepEqual([usableRate(22), usableRate(0), usableRate(-99.9), usableRate(-100), usableRate(Number.NaN), usableRate(Number.POSITIVE_INFINITY), usableRate('22')], [true, true, true, false, false, false, false]);
  });

  it('refuses a price that names a tax rate of the group it cannot use', async () => {
    const lists = { list: async (catalog: { name: string }) => (catalog.name === 'tax' ? [{ id: 't', rate: -100, department: null, description: null, vatNature: null }] : catalog.name === 'priceList' ? [{ id: 'l' }] : [{ code: 'EUR' }]) };
    const plan = await planProduct(planDeps({ catalogs: lists }), { principal: sa, access, id: new ObjectId(), stored: legacyFullProduct(), body: { prices: [{ priceListId: 'l', currency: 'EUR', taxId: 't', gross: 1 }] }, creating: false });
    assert.deepEqual(plan.issues, [{ field: 'prices.0.taxId', issue: 'incorrect' }]);
  });

  it('tells a lost race from a product that was already trashed, and does not look for a cycle when nothing was added to the bill', async () => {
    const stored = legacyFullProduct({ updateDate: new Date(1000) });
    const [id] = [stored['_id'] as ObjectId];
    const other = new ObjectId();
    const result = await fakes(stored, { setTrash: false }).service.trashMany(sa, access, [id], client);
    assert.deepEqual(result.results, [{ id: hex(id), outcome: 'skipped', issue: 'conflict' }]);
    // The bill already holds a component that makes a cycle, and the request only changes the code: the write stands.
    const cyclic = legacyFullProduct({ updateDate: new Date(1000), bundleProducts: [{ _id: other, quantity: 1 }] });
    const cycle = new Map([[hex(other), [hex(cyclic['_id'] as ObjectId)]]]);
    const done = fakes(cyclic, { componentsOf: [cycle] });
    const reply = await done.service.update(sa, access, cyclic['_id'] as ObjectId, productVersion(cyclic, key), { code: 'Z', components: [{ productId: hex(other), quantity: 1 }] }, client);
    assert.equal(reply.entity.code, 'Z');
    assert.equal(done.calls.length, 1);
  });
});
