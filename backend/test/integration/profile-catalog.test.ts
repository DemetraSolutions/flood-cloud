import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { profileCatalog, sampleEvenly } from '../../src/tools/profile-legacy/catalog.ts';
import type { CatalogProfile } from '../../src/tools/profile-legacy/catalog.ts';
import {
  BandTally,
  DuplicateTally,
  EnumTally,
  TypeTally,
  sameValue,
  tallyKeyRef,
} from '../../src/tools/profile-legacy/catalog-checks.ts';
import { CATALOG_MAX_DEPTH, normalizeCatalogKey, numericValue } from '../../src/tools/profile-legacy/catalog-paths.ts';
import { emptyRefProfile } from '../../src/tools/profile-legacy/classify.ts';
import { main } from '../../src/tools/profile-legacy/main.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { mongoEnv, openTestDatabases, TEST_CLUSTER } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

const SECRET_CODE = 'Secret-Code-XYZ';
const SECRET_BARCODE = 'Secret-Barcode-123';
const SECRET_NAME = 'Secret-Name-Pizza';
const SECRET_LIST = 'Secret-List-Id';
const SECRET_DUP = 'Secret-Duplicate-Name';
const SECRET_KEY = 'Weird Free Text Key';

const hex = () => new ObjectId().toHexString();

function nested(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < levels; level += 1) {
    value = { n: value };
  }
  return value;
}

describe('catalog path keys and numbers', () => {
  it('normalizes the dynamic keys of the catalog', () => {
    const id = hex();
    assert.equal(normalizeCatalogKey('quantity', `__${id}`), '<id>');
    assert.equal(normalizeCatalogKey('quantity', 'whatever'), '<id>');
    assert.equal(normalizeCatalogKey('quantity.<id>', `__${id}`), '<id>');
    assert.equal(normalizeCatalogKey('printStations', 'x'), '<id>');
    assert.equal(normalizeCatalogKey('printStationsNoRooms', 'x'), '<id>');
    assert.equal(normalizeCatalogKey('lastAveragePrice.suppliers', id), '<id>');
    assert.equal(normalizeCatalogKey('anything', `__${id}`), '<id>');
    assert.equal(normalizeCatalogKey('anything', id), '<id>');
    assert.equal(normalizeCatalogKey('quantity.<id>.<id>', 'value'), 'value');
    assert.equal(normalizeCatalogKey('name', 'it'), 'it');
    assert.equal(normalizeCatalogKey('variant.description', 'pt-BR'), 'pt-BR');
    assert.equal(normalizeCatalogKey('attributes[].name', 'en_us'), 'en_us');
    assert.equal(normalizeCatalogKey('shortName', SECRET_KEY), '<key>');
    assert.equal(normalizeCatalogKey('description', 'Mario'.repeat(3)), '<key>');
    assert.equal(normalizeCatalogKey('x', 'colors'), 'colors');
    assert.equal(normalizeCatalogKey('x', 'a'.repeat(65)), '<key>');
    assert.equal(normalizeCatalogKey('x', 'deadbeefdeadbeef'), '<key>');
    assert.equal(normalizeCatalogKey('x', 'with space'), '<key>');
  });

  it('reads every kind of BSON number', () => {
    assert.equal(numericValue(3), 3);
    assert.equal(numericValue(new Int32(4)), 4);
    assert.equal(numericValue(new Double(1.5)), 1.5);
    assert.equal(numericValue(Long.fromNumber(9)), 9);
    assert.equal(numericValue(Decimal128.fromString('2.5')), 2.5);
    assert.ok(Number.isNaN(numericValue(Decimal128.fromString('NaN'))));
    assert.equal(numericValue('3'), undefined);
    assert.equal(numericValue(null), undefined);
    assert.equal(numericValue(new ObjectId()), undefined);
  });
});

describe('catalog tallies', () => {
  it('puts values in bands, empty bands included', () => {
    const bands = new BandTally([0, 1, 10]);
    for (const value of [0, 0, 1, 2, 10, 11, 5000]) {
      bands.add(value);
    }
    assert.deepEqual(bands.result(), { '0': 2, '1': 1, '2-10': 2, '11+': 2 });
    assert.deepEqual(new BandTally([5]).result(), { '0-5': 0, '6+': 0 });
  });

  it('counts types, with missing for an absent value', () => {
    const types = new TypeTally();
    for (const value of ['a', 'b', undefined, null, 1, new ObjectId()]) {
      types.add(value);
    }
    assert.deepEqual(types.result(), { int: 1, missing: 1, null: 1, objectId: 1, string: 2 });
  });

  it('lists enum words from 3 documents on and counts the rest by kind', () => {
    const tally = new EnumTally();
    const values = ['product', 'product', 'product', 'rare', 'rare2', 7, 7, 7, 8, 1000, 1.5, NaN, Infinity, -Infinity, true, false, null, undefined, 'a long text that is not a short word', new ObjectId(), [], {}];
    for (const value of values) {
      tally.add(value);
    }
    tally.add(new Int32(7));
    assert.deepEqual(tally.result(), {
      '7': 4,
      '<array>': 1,
      '<missing>': 1,
      '<number>': 2,
      '<objectId>': 1,
      '<object>': 1,
      '<rare>': 3,
      '<text>': 1,
      '-Infinity': 1,
      Infinity: 1,
      NaN: 1,
      false: 1,
      null: 1,
      product: 3,
      true: 1,
    });
    assert.deepEqual(new EnumTally().result(), {});
  });

  it('counts duplicates per group and forgets the values of the closed group', () => {
    const tally = new DuplicateTally();
    for (const value of ['a', 'a', 'a', 'b', 'c', 'c']) {
      tally.add(value);
    }
    tally.endGroup();
    tally.add('a');
    tally.endGroup();
    tally.add('x');
    tally.add('x');
    tally.endGroup();
    assert.deepEqual(tally.result(), { groupsWithDuplicates: 2, duplicateValues: 3, documentsInvolved: 7 });
  });

  it('compares references to keys by text or by ObjectId and keeps unverifiable ones apart', () => {
    const profile = emptyRefProfile();
    const known = new ObjectId();
    const existing = new Set(['list', known.toHexString()]);
    assert.equal(tallyKeyRef(profile, 'list', existing), 'list');
    assert.equal(tallyKeyRef(profile, 'other', existing), 'other');
    assert.equal(tallyKeyRef(profile, known, existing), known.toHexString());
    assert.equal(tallyKeyRef(profile, new ObjectId(), existing)?.length, 24);
    assert.equal(tallyKeyRef(profile, undefined, existing), undefined);
    assert.equal(tallyKeyRef(profile, 5, existing), undefined);
    assert.equal(tallyKeyRef(profile, 'list', undefined), 'list');
    assert.equal(profile.orphans, 2);
    assert.equal(profile.unverifiable, 1);
    assert.deepEqual(profile.kinds, { objectId: 2, hexString: 0, otherString: 3, null: 0, missing: 1, otherType: 1 });
  });

  it('compares stored values by content, numbers whatever their type', () => {
    assert.ok(sameValue(new Int32(22), new Double(22)));
    assert.ok(sameValue(0, -0));
    assert.ok(sameValue(NaN, new Double(NaN)));
    assert.ok(!sameValue(22, 23));
    assert.ok(!sameValue(22, '22'));
    assert.ok(!sameValue('a', 22));
    assert.ok(sameValue('a', 'a'));
    assert.ok(!sameValue('a', 'b'));
    assert.ok(sameValue(undefined, undefined));
    assert.ok(sameValue([1, { a: 'x' }], [new Int32(1), { a: 'x' }]));
    assert.ok(!sameValue([1], [1, 2]));
    assert.ok(!sameValue([1, 2], [1, 3]));
    assert.ok(!sameValue([1], { 0: 1 }));
    assert.ok(sameValue({ it: 'a', en: 'b' }, { en: 'b', it: 'a' }));
    assert.ok(!sameValue({ it: 'a' }, { it: 'a', en: 'b' }));
    assert.ok(!sameValue({ it: 'a' }, { en: 'a' }));
    assert.ok(!sameValue({ it: 'a' }, { it: 'b' }));
  });
});

describe('profileCatalog (real MongoDB)', () => {
  let ctx: TestDatabases;
  let report: CatalogProfile;
  let progress: Array<[number, number]>;
  const now = new Date('2032-01-02T03:04:05.000Z');
  const [g1, g2, g3] = [fixtureId('group', 1), fixtureId('group', 2), fixtureId('group', 3)] as const;
  const ids = {
    pl1: new ObjectId(),
    b1: new ObjectId(),
    b2: new ObjectId(),
    c1: new ObjectId(),
    c2: new ObjectId(),
    c3: new ObjectId(),
    c4: new ObjectId(),
    p1: new ObjectId(),
    p2: new ObjectId(),
    p3: new ObjectId(),
    p4: new ObjectId(),
    x1: new ObjectId(),
    x2: new ObjectId(),
    x3: new ObjectId(),
  };
  const stranger = new ObjectId();
  const group = (id: ObjectId): Db => ctx.databases.group(id, TEST_CLUSTER);

  before(async () => {
    ctx = await openTestDatabases();
    const common = ctx.databases.common();
    await common.collection('groups').insertMany([
      {
        _id: g1,
        priceLists: { LA: { id: 'LA' }, [SECRET_LIST]: { id: SECRET_LIST } },
        taxes: [{ id: 't1', value: 22, department: 1, description: 'IVA 22', natura: '' }, 'junk', { id: 5 }],
      },
      { _id: g2, priceLists: 'bad', taxes: 'bad' },
    ]);

    const one = group(g1);
    await one.collection('places').insertOne({ _id: ids.pl1, name: 'Place' });
    await one.collection('products_brands').insertMany([
      { _id: ids.b1, name: { it: 'Brand' }, placesAvailability: [ids.pl1, new ObjectId()] },
      { _id: ids.b2, placesAvailability: [ids.pl1.toHexString(), 'not-a-hex-id'] },
    ]);
    await one.collection('products_categories').insertMany([
      { _id: ids.c3, parentId: ids.c2, name: { it: SECRET_DUP } },
      { _id: ids.c2, parentId: ids.c1, name: { it: SECRET_DUP } },
      { _id: ids.c4, parentId: ids.c2, name: { it: SECRET_DUP } },
      { _id: ids.c1, parentId: null, name: { it: SECRET_NAME }, placesAvailability: [{ id: ids.pl1, position: 1, productionCenterId: null }] },
      { parentId: 'zzz', name: {} },
      { parentId: new ObjectId(), placesAvailability: 'bad' },
      { name: { it: '' }, placesAvailability: [{ foo: 1 }, 5] },
    ]);
    await one.collection('products_departments').insertMany([
      { code: '1', tax: { id: 't1', value: 22, department: 1 }, placesAvailability: [ids.pl1] },
      { code: new Int32(1) },
      { code: null, tax: 22, trash: true },
      { code: NaN },
      { code: '1', trash: true },
      { code: '' },
      {},
      { code: 'A' },
    ]);
    await one.collection('products_attributes').insertOne({ name: { it: 'Colors' }, attributes: [{ id: 'x', name: { it: 'Red' } }] });
    await one.collection('products').insertMany([
      {
        _id: ids.p1,
        type: 'product',
        status: true,
        trash: false,
        scaleType: 0,
        code: SECRET_CODE,
        plu: 'PLU1',
        time: '',
        max: NaN,
        barcode: [{ value: SECRET_BARCODE, qtLoad: null }, { value: SECRET_BARCODE }, { value: '' }, { noValue: true }],
        categories: [ids.c1, ids.c2],
        brandId: ids.b1,
        placesAvailability: [{ id: ids.pl1, favorite: true }, { id: ids.pl1 }],
        prices: [
          { id: 'a', listId: 'LA', taxed: 1.234, startDate: '2020-01-01T00:00:00.000Z', endDate: null, taxData: { id: 't1', value: 22, department: 1, description: 'IVA 22', natura: '' } },
          { listId: 'LA', taxed: 2.5, startDate: new Date(0), taxData: { id: 't1', value: 10, department: 1, description: 'IVA 22', natura: '' } },
          { listId: SECRET_LIST, taxed: NaN, taxData: { id: 'tX' } },
          'junk',
          { listId: new ObjectId(), taxed: new Int32(5), taxData: 5 },
          { taxed: 'text' },
        ],
        quantity: { [`__${hex()}`]: { [`__${hex()}`]: { value: 3, min: 0, max: null, location: 'A' } } },
        printStations: { [`__${hex()}`]: ['s1'] },
        lastAveragePrice: { lastSupplierId: null, total: { year: 2026 }, suppliers: { [hex()]: { total: { year: 2026 } } } },
        name: { it: SECRET_NAME, en: 'x', [SECRET_KEY]: 'y' },
        variant: { status: false, type: 'pm', description: { it: '' } },
        modularBundle: { priceRule: 'avarage' },
      },
      {
        _id: ids.p2,
        type: 'product',
        status: true,
        trash: false,
        scaleType: 1,
        code: SECRET_CODE,
        plu: 'PLU1',
        time: '10:00',
        barcode: [{ value: SECRET_BARCODE }],
        variant: { status: true, type: 'p' },
        variants: [ids.p1, 'nothex'],
        variantsRequired: [ids.p1],
        variantsExcluded: [new ObjectId()],
        variantsCategories: [ids.c1],
        bundleProducts: [{ _id: ids.p1, quantity: 1, waste: null }, { _id: new ObjectId() }],
        selectableBundleProducts: [{ categoryId: ids.c1, quantity: 1, exit: NaN, products: [{ _id: ids.p1 }] }, { categoryId: null }],
        selectableVariantsBundleProducts: [{ categoryId: new ObjectId(), freeQt: new Double(Infinity), priceType: 'h', products: [{ _id: new ObjectId() }] }],
        categories: [],
        brandId: null,
        modularBundle: { priceRule: 'sum' },
      },
      {
        _id: ids.p3,
        type: 'service',
        status: false,
        trash: true,
        scaleType: NaN,
        code: null,
        plu: null,
        time: null,
        barcode: [{ value: SECRET_BARCODE }],
        placesAvailability: [],
        prices: [],
        brandId: new ObjectId(),
        categories: 'bad',
        modularBundle: { priceRule: null },
      },
      { _id: ids.p4, type: 'product', status: true, trash: false, plu: '', code: '', time: '', barcode: 'bad', placesAvailability: 'oops', categories: [ids.c1], brandId: ids.b1 },
      { type: 'product', code: null, time: null, plu: '', trash: false },
    ]);

    const two = group(g2);
    await two.collection('products').insertOne({
      type: 'product',
      trash: false,
      code: SECRET_CODE,
      prices: [{ listId: 'LA', taxData: { id: 't1' } }],
      categories: [new ObjectId()],
    });
    await two.collection('products_departments').insertOne({ code: '1', tax: { id: 't1' } });

    const three = group(g3);
    await three.collection('products').insertMany([
      { type: 'rare1' },
      { type: 'rare2' },
      { type: 'trio' },
      { type: 'trio' },
      { type: 'trio' },
      { type: 'a very long text beyond twenty characters' },
      { type: 7 },
      { type: 1000.5 },
      { type: NaN },
      { type: Infinity },
      { type: new ObjectId() },
      { type: null },
      { type: true },
      { type: [] },
      { status: 'x' },
      { prices: [{ listId: 'LA', taxData: { id: 't1' } }], custom: nested(CATALOG_MAX_DEPTH + 1), decimal: Decimal128.fromString('Infinity') },
    ]);
    await three.collection('products_categories').insertMany([
      { _id: ids.x1, parentId: ids.x2 },
      { _id: ids.x2, parentId: ids.x1 },
      { _id: ids.x3, parentId: ids.x3 },
    ]);
    await three.createCollection('products_brands');
    progress = [];
    report = await profileCatalog(ctx.databases, { appEnv: 'development', now: () => now, progressEvery: 2, onProgress: (done, total) => progress.push([done, total]) });
  });
  after(async () => {
    await ctx.cleanup();
  });

  it('describes the run and the groups', () => {
    assert.equal(report.generatedAt, '2032-01-02T03:04:05.000Z');
    assert.equal(report.appEnv, 'development');
    assert.equal(report.focus, 'catalog');
    assert.deepEqual(report.groups, { databases: 3, available: 3, withCommonDocument: 2, withoutCommonDocument: 1 });
    assert.deepEqual(progress, [[2, 3]]);
    assert.deepEqual(Object.keys(report), ['generatedAt', 'appEnv', 'focus', 'groups', 'collections', 'checks']);
    assert.deepEqual(Object.keys(report.collections), ['products', 'products_categories', 'products_departments', 'products_brands', 'products_attributes']);
    assert.deepEqual(Object.keys(report.checks), ['products', 'products_categories', 'products_departments', 'products_brands']);
  });

  it('counts groups, documents, sizes and indexes of each collection', () => {
    const { products, products_categories: categories, products_departments: departments, products_brands: brands, products_attributes: attributes } = report.collections;
    assert.equal(products.groupsWithCollection, 3);
    assert.equal(products.documents, 5 + 1 + 16);
    assert.deepEqual(products.documentsPerGroup.bands, { '0': 0, '1': 1, '2-10': 1, '11-100': 1, '101-1000': 0, '1001-10000': 0, '10001-100000': 0, '100001+': 0 });
    assert.equal(products.documentsPerGroup.max, 16);
    assert.ok(products.bsonSize.max > 1024);
    assert.equal(Object.values(products.bsonSize.bands).reduce((sum, count) => sum + count, 0), products.documents);
    assert.deepEqual(Object.keys(products.bsonSize.bands), ['0-1024', '1025-4096', '4097-16384', '16385-65536', '65537-262144', '262145-1048576', '1048577+']);
    assert.deepEqual(products.indexes.map(({ name, key, databases }) => ({ name, key, databases })), [{ name: '_id_', key: { _id: 1 }, databases: 3 }]);
    assert.equal(categories.groupsWithCollection, 2);
    assert.equal(categories.documents, 10);
    assert.equal(departments.groupsWithCollection, 2);
    assert.equal(departments.documents, 9);
    assert.equal(brands.groupsWithCollection, 2);
    assert.equal(brands.documents, 2);
    assert.deepEqual(brands.documentsPerGroup.bands['0'], 1);
    assert.equal(attributes.groupsWithCollection, 1);
    assert.equal(attributes.documents, 1);
    assert.equal(attributes.documentsPerGroup.max, 1);
  });

  it('lists the paths with types, counts, flags and non-finite numbers, with normalized keys', () => {
    const { paths, depthLimited, truncated } = report.collections.products;
    assert.equal(truncated, false);
    assert.equal(depthLimited, true);
    assert.deepEqual(Object.keys(paths), [...Object.keys(paths)].sort());
    assert.deepEqual(paths['code']!.types, { null: 2, string: 4 });
    assert.deepEqual(paths['code']!.flags, { true: 0, false: 0, null: 2 });
    assert.deepEqual(paths['max']!.numeric, { nan: 1, infinite: 0 });
    assert.deepEqual(paths['scaleType']!.numeric, { nan: 1, infinite: 0 });
    assert.deepEqual(paths['selectableBundleProducts[].exit']!.numeric, { nan: 1, infinite: 0 });
    assert.deepEqual(paths['selectableVariantsBundleProducts[].freeQt']!.numeric, { nan: 0, infinite: 1 });
    assert.deepEqual(paths['decimal']!.numeric, { nan: 0, infinite: 1 });
    assert.deepEqual(paths['prices[].taxed']!.types, { double: 3, int: 1, string: 1 });
    assert.deepEqual(paths['prices[].taxed']!.numeric, { nan: 1, infinite: 0 });
    assert.deepEqual(paths['trash']!.flags, { true: 1, false: 5, null: 0 });
    assert.equal(paths['trash']!.docs, 6);
    assert.equal(paths['name']!.docs, 1);
    for (const path of [
      'quantity.<id>.<id>.value',
      'quantity.<id>.<id>.location',
      'printStations.<id>[]',
      'lastAveragePrice.suppliers.<id>.total.year',
      'name.it',
      'name.en',
      'name.<key>',
      'variant.description.it',
      'barcode[].noValue',
      `custom${'.n'.repeat(CATALOG_MAX_DEPTH - 1)}`,
    ]) {
      assert.ok(path in paths, path);
    }
    assert.ok(!Object.keys(paths).some((path) => path.endsWith('.leaf')));
    assert.equal(report.collections.products_departments.paths['tax']!.types['int'], 1);
    assert.deepEqual(report.collections.products_categories.paths['placesAvailability[]']!.types, { int: 1, object: 2 });
  });

  it('counts enumerated values, listing only words seen in at least 3 documents', () => {
    const { enums, types, nullDefects } = report.checks.products;
    assert.deepEqual(Object.keys(enums), [
      'products.type',
      'products.variant.type',
      'products.variant.status',
      'products.status',
      'products.trash',
      'products.scaleType',
      'products.modularBundle.priceRule',
    ]);
    assert.deepEqual(enums['products.type'], {
      '<array>': 1,
      '<missing>': 2,
      '<number>': 1,
      '<objectId>': 1,
      '<rare>': 4,
      '<text>': 1,
      Infinity: 1,
      NaN: 1,
      null: 1,
      product: 5,
      trio: 3,
      true: 1,
    });
    assert.deepEqual(enums['products.variant.type'], { '<missing>': 20, '<rare>': 2 });
    assert.deepEqual(enums['products.variant.status'], { '<missing>': 20, false: 1, true: 1 });
    assert.deepEqual(enums['products.trash'], { '<missing>': 16, false: 5, true: 1 });
    assert.deepEqual(enums['products.scaleType'], { '<missing>': 19, '<rare>': 2, NaN: 1 });
    assert.deepEqual(enums['products.modularBundle.priceRule'], { '<missing>': 19, '<rare>': 2, null: 1 });
    assert.deepEqual(types, { plu: { missing: 17, null: 1, string: 4 }, code: { missing: 16, null: 2, string: 4 } });
    assert.deepEqual(nullDefects, { time: 2, code: 2, plu: 1, allThree: 1 });
  });

  it('counts duplicates inside each group among the documents not in the trash, never across groups', () => {
    const { products, products_categories: categories, products_departments: departments } = report.checks;
    const once = { groupsWithDuplicates: 1, duplicateValues: 1, documentsInvolved: 2 };
    assert.deepEqual(products.duplicates, { code: once, plu: once, barcode: once });
    assert.deepEqual(categories.duplicateNames, once);
    assert.deepEqual(departments.duplicateCodes, once);
    assert.equal(categories.groupsWithCycle, 1);
  });

  it('classifies references and finds the orphans inside the group', () => {
    const { references } = report.checks.products;
    const refs = (name: string) => references[name]!;
    assert.deepEqual(refs('products.categories[] -> products_categories'), { kinds: { objectId: 4, hexString: 0, otherString: 1, null: 0, missing: 17, otherType: 0 }, orphans: 1, unverifiable: 0 });
    assert.deepEqual(refs('products.variants[] -> products').kinds, { objectId: 1, hexString: 0, otherString: 1, null: 0, missing: 21, otherType: 0 });
    assert.equal(refs('products.variantsRequired[] -> products').orphans, 0);
    assert.equal(refs('products.variantsExcluded[] -> products').orphans, 1);
    assert.equal(refs('products.variantsCategories[] -> products_categories').orphans, 0);
    assert.equal(refs('products.bundleProducts[]._id -> products').orphans, 1);
    assert.equal(refs('products.selectableBundleProducts[].categoryId -> products_categories').kinds.null, 1);
    assert.equal(refs('products.selectableBundleProducts[].products[]._id -> products').orphans, 0);
    assert.equal(refs('products.selectableVariantsBundleProducts[].categoryId -> products_categories').orphans, 1);
    assert.equal(refs('products.selectableVariantsBundleProducts[].products[]._id -> products').orphans, 1);
    assert.deepEqual(refs('products.brandId -> products_brands'), { kinds: { objectId: 3, hexString: 0, otherString: 0, null: 1, missing: 18, otherType: 0 }, orphans: 1, unverifiable: 0 });
    assert.deepEqual(report.checks.products_categories.parentId, { kinds: { objectId: 7, hexString: 0, otherString: 1, null: 1, missing: 1, otherType: 0 }, orphans: 1, unverifiable: 0 });
  });

  it('reports the shapes of placesAvailability and of the references to places', () => {
    const { products, products_categories: categories, products_departments: departments, products_brands: brands } = report.checks;
    assert.deepEqual(products.placesAvailability, {
      shapes: { objectWithId: 2, string: 0, objectId: 0, other: 0 },
      documentsEmptyOrAbsent: 21,
      references: { kinds: { objectId: 2, hexString: 0, otherString: 0, null: 0, missing: 0, otherType: 0 }, orphans: 0, unverifiable: 0 },
    });
    assert.deepEqual(categories.placesAvailability.shapes, { objectWithId: 1, string: 0, objectId: 0, other: 2 });
    assert.equal(categories.placesAvailability.documentsEmptyOrAbsent, 8);
    assert.equal(categories.placesAvailability.references.kinds.otherType, 2);
    assert.deepEqual(departments.placesAvailability.shapes, { objectWithId: 0, string: 0, objectId: 1, other: 0 });
    assert.deepEqual(brands.placesAvailability.shapes, { objectWithId: 0, string: 2, objectId: 2, other: 0 });
    assert.equal(brands.placesAvailability.documentsEmptyOrAbsent, 0);
    assert.deepEqual(brands.placesAvailability.references, { kinds: { objectId: 2, hexString: 1, otherString: 1, null: 0, missing: 0, otherType: 0 }, orphans: 1, unverifiable: 0 });
  });

  it('describes the prices, the tax copies and the list references against the group document', () => {
    const { prices } = report.checks.products;
    assert.deepEqual(prices.perProduct, { '0': 19, '1': 2, '2': 0, '3-5': 0, '6-10': 1, '11-50': 0, '51+': 0 });
    assert.equal(prices.documentsWithRepeatedList, 1);
    assert.equal(prices.nonObjectElements, 1);
    assert.deepEqual(prices.startDate, { date: 1, missing: 5, string: 1 });
    assert.deepEqual(prices.endDate, { missing: 6, null: 1 });
    assert.deepEqual(prices.taxedOver2Decimals, { prices: 1, documents: 1 });
    assert.deepEqual(prices.taxData, { absent: 2, differsFromCurrent: 1 });
    assert.deepEqual(prices.listId, { kinds: { objectId: 1, hexString: 0, otherString: 5, null: 0, missing: 1, otherType: 0 }, orphans: 2, unverifiable: 1 });
    assert.deepEqual(prices.taxDataId, { kinds: { objectId: 0, hexString: 0, otherString: 5, null: 0, missing: 2, otherType: 0 }, orphans: 2, unverifiable: 1 });
  });

  it('shows the shape of departments: type of code and of tax', () => {
    assert.deepEqual(report.checks.products_departments.types, {
      code: { double: 1, int: 1, missing: 1, null: 1, string: 5 },
      tax: { int: 1, missing: 6, object: 2 },
    });
  });

  it('never outputs a value, an id, a database name or a key of free text', () => {
    const text = JSON.stringify(report);
    const forbidden = [SECRET_CODE, SECRET_BARCODE, SECRET_NAME, SECRET_LIST, SECRET_KEY, 'Secret', 'PLU1', 'Brand', 'Colors', ctx.prefix, 'flood_cloud_test', g1.toHexString(), g2.toHexString(), g3.toHexString(), stranger.toHexString()];
    for (const id of Object.values(ids)) {
      forbidden.push(id.toHexString());
    }
    for (const word of forbidden) {
      assert.ok(!text.includes(word), word);
    }
  });

  it('caps the distinct paths and says so, and reports no group without databases', async () => {
    const small = await openTestDatabases();
    try {
      const empty = await profileCatalog(small.databases, { appEnv: 'development' });
      assert.deepEqual(empty.groups, { databases: 0, available: 0, withCommonDocument: 0, withoutCommonDocument: 0 });
      assert.equal(empty.collections.products.documents, 0);
      assert.deepEqual(empty.collections.products.documentsPerGroup, { max: 0, bands: { '0': 0, '1': 0, '2-10': 0, '11-100': 0, '101-1000': 0, '1001-10000': 0, '10001-100000': 0, '100001+': 0 } });
      assert.deepEqual(empty.collections.products.paths, {});
      assert.ok(Date.now() - Date.parse(empty.generatedAt) < 60_000);
      await group2(small).collection('products').insertOne({ a: 1, b: 2, c: 3, d: 4 });
      const capped = await profileCatalog(small.databases, { appEnv: 'development', maxPaths: 3, progressEvery: 1 });
      assert.equal(capped.collections.products.truncated, true);
      assert.deepEqual(Object.keys(capped.collections.products.paths), ['_id', 'a', 'b']);
    } finally {
      await small.cleanup();
    }
  });
});

function group2(databases: TestDatabases): Db {
  return databases.databases.group(fixtureId('group', 9), TEST_CLUSTER);
}

describe('catalog sample', () => {
  it('picks evenly spaced items in order, or everything when the sample is not smaller than the list', () => {
    assert.deepEqual(sampleEvenly([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
    assert.deepEqual(sampleEvenly([1, 2, 3, 4, 5, 6, 7], 2), [1, 4]);
    assert.deepEqual(sampleEvenly([1, 2], 2), [1, 2]);
    assert.deepEqual(sampleEvenly([1, 2], 9), [1, 2]);
    assert.deepEqual(sampleEvenly([], 3), []);
  });

  it('profiles only the sampled group databases and says how many there were', async () => {
    const ctx = await openTestDatabases();
    try {
      for (const n of [1, 2, 3, 4]) {
        await ctx.databases.group(fixtureId('group', n), TEST_CLUSTER).collection('products').insertOne({ n });
      }
      const report = await profileCatalog(ctx.databases, { appEnv: 'development', sample: 2 });
      assert.deepEqual(report.groups, { databases: 2, available: 4, withCommonDocument: 0, withoutCommonDocument: 2 });
      assert.equal(report.collections.products.documents, 2);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('profile:legacy --focus catalog', () => {
  let dir: string;
  let ctx: TestDatabases;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flood-catalog-'));
    ctx = await openTestDatabases();
    await ctx.databases.group(fixtureId('group', 1), TEST_CLUSTER).collection('products').insertOne({ code: SECRET_CODE });
  });
  after(async () => {
    await ctx.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
  const env = () => mongoEnv({ DB_NAME_PREFIX: ctx.prefix }) as Record<string, string>;
  const run = async (argv: string[], cwd: string, extra: { progressEvery?: number } = {}) => {
    const info: string[] = [];
    const error: string[] = [];
    const code = await main(argv, { env: env(), cwd, loadEnvFile: () => undefined, info: (l) => info.push(l), error: (l) => error.push(l), ...extra });
    return { code, info, error };
  };

  it('writes legacy-catalog-<env>-<timestamp>.json under backend/reports with 0600 and numbers-only progress', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'flood-repo-'));
    try {
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'backend'));
      const result = await run(['--focus', 'catalog'], join(repo, 'backend'));
      assert.equal(result.code, 0, result.error.join());
      assert.deepEqual(result.error, ['Profiling catalog of development: 1 group databases found on 1 cluster(s), read-only']);
      const [file] = await readdir(join(repo, 'backend', 'reports'));
      assert.match(file ?? '', /^legacy-catalog-development-\d{8}T\d{9}Z\.json$/);
      const path = join(repo, 'backend', 'reports', file ?? '');
      const text = await readFile(path, 'utf8');
      assert.ok(!text.includes(SECRET_CODE));
      assert.equal((JSON.parse(text) as CatalogProfile).collections.products.documents, 1);
      const { stat } = await import('node:fs/promises');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('prints the progress as numbers only, refuses to overwrite and keeps the environment guard', async () => {
    const out = join(dir, 'catalog.json');
    const first = await run(['--focus', 'catalog', '--out', out], dir, { progressEvery: 1 });
    assert.equal(first.code, 0, first.error.join());
    assert.deepEqual(first.error.filter((line) => line.startsWith('profiled')), ['profiled 1/1 group databases']);
    const again = await run(['--focus', 'catalog', '--out', out], dir);
    assert.equal(again.code, 1);
    assert.match(again.error.join(), /overwrite/);
    const mismatch = await run(['--focus', 'catalog', '--env', 'production', '--out', join(dir, 'm.json')], dir);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.error.join(), /does not match/);
    const bad = await run(['--focus', 'catalogs'], dir);
    assert.equal(bad.code, 1);
    assert.match(bad.error.join(), /Usage: .*--focus subobjects\|catalog/);
  });

  it('reads only a sample of the group databases with --sample, which needs --focus catalog and a positive integer', async () => {
    const out = join(dir, 'sample.json');
    const sampled = await run(['--focus', 'catalog', '--sample', '5', '--out', out], dir);
    assert.equal(sampled.code, 0, sampled.error.join());
    assert.deepEqual(sampled.error, ['Profiling catalog of development: 1 group databases found on 1 cluster(s), read-only, sample of 1']);
    assert.deepEqual((JSON.parse(await readFile(out, 'utf8')) as CatalogProfile).groups, { databases: 1, available: 1, withCommonDocument: 0, withoutCommonDocument: 1 });
    for (const argv of [['--sample', '5'], ['--focus', 'subobjects', '--sample', '5'], ['--focus', 'catalog', '--sample', '0'], ['--focus', 'catalog', '--sample', '1.5'], ['--focus', 'catalog', '--sample', '1000000']]) {
      const refused = await run([...argv, '--out', join(dir, 'refused.json')], dir);
      assert.equal(refused.code, 1, argv.join(' '));
      assert.match(refused.error.join(), /Usage: .*--sample/);
    }
  });
});
