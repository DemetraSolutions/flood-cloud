import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { runImport } from '../../src/modules/catalog-xlsx/catalog-xlsx.import.ts';
import type { ImportGraph } from '../../src/modules/catalog-xlsx/catalog-xlsx.import.ts';
import { parseWorkbook } from '../../src/modules/catalog-xlsx/catalog-xlsx.parse.ts';
import { createCatalogXlsxController } from '../../src/modules/catalog-xlsx/catalog-xlsx.controller.ts';
import { MAX_COLLECTED_ERRORS, MAX_REPORTED_ERRORS } from '../../src/modules/catalog-xlsx/catalog-xlsx.errors.ts';
import { createCatalogXlsxRoutes } from '../../src/modules/catalog-xlsx/catalog-xlsx.routes.ts';
import { createCatalogXlsxService } from '../../src/modules/catalog-xlsx/catalog-xlsx.service.ts';
import type { CatalogXlsxDeps, CatalogXlsxService } from '../../src/modules/catalog-xlsx/catalog-xlsx.service.ts';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createCatalogsService } from '../../src/modules/groups/catalogs/catalogs.service.ts';
import { createReferencesRepository } from '../../src/modules/groups/catalogs/references.repository.ts';
import { createTaxDepartments } from '../../src/modules/product-departments/product-departments.repository.ts';
import { createUsersRepository } from '../../src/modules/users/users.repository.ts';
import { createGate } from '../../src/modules/media/gate.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';
import { createIdempotencyStore, idempotencyBodyKey } from '../../src/shared/http/idempotency.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { addUser } from '../helpers/backoffice.ts';
import { catalogWorkbook, downloadWorkbook, uploadWorkbook } from '../helpers/catalog-xlsx.ts';
import type { TestSheet } from '../helpers/catalog-xlsx.ts';
import { legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { catalogCollections, legacyCategory } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { legacyFullProduct, legacyPrice, placeEntry } from '../helpers/products.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';
import { accessFor } from '../helpers/group-access.ts';
import { principalOf } from '../helpers/principal.ts';
import { xlsxChunks } from '../../src/shared/xlsx/writer.ts';
import { workbookOf, zipOf } from '../helpers/xlsx.ts';
import type { TestZipFile } from '../helpers/xlsx.ts';

/** The import of the catalog workbook (step C6): every behaviour goes through `POST /v1/groups/{groupId}/catalog-import`, over a real MongoDB. */
let ctx: TestDatabases;
let world: StoreWorld;
let db: CatalogCollections;
let store: ActivatedKey;
const limiter = memoryRateLimiter();
const audit = memoryActivityLog();
const hex = (id: ObjectId) => id.toHexString();
const gid = () => world.group(0).groupId;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const pa = () => world.group(0).pa;
const own = () => world.group(0).ownPlaceId;
const other = () => world.group(0).otherPlaceId;
const groups = () => ctx.databases.common().collection('groups');
/** The points of sale the workbook reads: the copies in the common database. */
const places = () => ctx.databases.common().collection('places');
const groupPlaces = () => ctx.databases.group(gid(), 'cluster0').collection('places');
const placeCopies = () => ctx.databases.common().collection('places');
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/catalog-import`;
const exportBase = (index = 0) => `/groups/${hex(world.group(index).groupId)}/catalog-export`;
const ALL = { cash: true, warehouse: true, customersApp: true, tobaccosGamesMonopoly: true, productsVariants: true, services: true, scales: true, ordering: true, rooms: true, media: true };
const imported = (mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'catalog.imported');
const TAX_B = 'tax-b';
let listId = '';
let taxId = '';

/** Rows of one sheet, then the answer. */
type Reply = Awaited<ReturnType<typeof uploadWorkbook>>;
interface Options {
  readonly actor?: ObjectId;
  readonly query?: string;
  readonly headers?: Partial<Record<'products' | 'variants' | 'categories', readonly string[]>>;
  readonly path?: string;
  readonly key?: string;
}

/** Imports a workbook made of the given rows. */
async function run(sheets: Partial<Record<'products' | 'variants' | 'categories', TestSheet>>, options: Options = {}): Promise<Reply> {
  limiter.reset();
  const bytes = await catalogWorkbook(sheets, options.headers);
  return uploadWorkbook(world, `${options.path ?? base()}${options.query ?? ''}`, bytes, options.actor ?? sa(), options.key === undefined ? undefined : { 'idempotency-key': options.key });
}
/** Imports the bytes of a file as they are. */
async function runBytes(bytes: Buffer, options: Options = {}): Promise<Reply> {
  limiter.reset();
  return uploadWorkbook(world, `${options.path ?? base()}${options.query ?? ''}`, bytes, options.actor ?? sa(), options.key === undefined ? undefined : { 'idempotency-key': options.key });
}
const products = (rows: TestSheet, options: Options = {}) => run({ products: rows }, options);
const variants = (rows: TestSheet, options: Options = {}) => run({ variants: rows }, options);
const categories = (rows: TestSheet, options: Options = {}) => run({ categories: rows }, options);

/** The problems of a refused import as `sheet:row:column:code`. */
const problems = (reply: Reply): string[] => {
  assert.equal(reply.status, 422, JSON.stringify(reply.body));
  assert.equal(reply.body.error.code, 'VALIDATION_ERROR');
  return (reply.body.error.rows as Array<{ sheet: string; row: number | null; column: string | null; code: string }>).map((row) => `${row.sheet}:${row.row ?? '-'}:${row.column ?? '-'}:${row.code}`);
};
/** The codes of the problems of a refused import. */
const codes = (reply: Reply): string[] => problems(reply).map((line) => line.split(':').at(-1)!);
/** The counts of a successful import. */
const counts = (reply: Reply, dryRun = false) => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.data.dryRun, dryRun);
  return reply.body.data.sheets as Record<'products' | 'variants' | 'categories', { inserted: number; updated: number; removed: number; unchanged: number }>;
};
const ZERO = { inserted: 0, updated: 0, removed: 0, unchanged: 0 };
const only = (sheet: 'products' | 'variants' | 'categories', value: Partial<typeof ZERO>) => ({ products: ZERO, variants: ZERO, categories: ZERO, [sheet]: { ...ZERO, ...value } });

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
const product = (id: ObjectId) => db.products.findOne({ _id: id });
const category = (id: ObjectId) => db.categories.findOne({ _id: id });
const byName = async (collection: 'products' | 'categories', name: string) => (await db[collection].find({ 'name.it': name }).toArray()) as Document[];
const dump = async () => ({ products: await db.products.find({}, { ...EXACT_TYPES }).sort({ _id: 1 }).toArray(), categories: await db.categories.find({}, { ...EXACT_TYPES }).sort({ _id: 1 }).toArray() });
const untouched = async (action: () => Promise<Reply>): Promise<Reply> => {
  const before = await dump();
  const reply = await action();
  assert.deepEqual(await dump(), before, 'the database is as it was');
  return reply;
};
/** A workbook with the sheets and the cells exactly as given (headers included), written through the real writer. */
async function rawBook(sheets: Record<string, { columns: string[]; rows: string[][] }>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of xlsxChunks(Object.entries(sheets).map(([name, sheet]) => ({ name, columns: sheet.columns, rows: sheet.rows })))) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The catalogs of the group, as the server builds them. */
const realCatalogs = () => createCatalogsService({ catalogs: createCatalogsRepository(ctx.databases), references: createReferencesRepository(ctx.databases), activityLog: audit, logger: memoryLogger().logger, newId: () => randomUUID(), now: Date.now, taxDepartments: createTaxDepartments(ctx.databases) });

/** The service of the workbook over the test databases (the real catalogs, references and users), with the limits and the clock a test injects. */
function serviceWith(limits: CatalogXlsxDeps['limits'], now: () => number = Date.now, databases: TestDatabases['databases'] = ctx.databases, overrides: Partial<CatalogXlsxDeps> = {}): CatalogXlsxService {
  return createCatalogXlsxService({
    databases,
    catalogs: realCatalogs(),
    images: { imageSource: () => Promise.resolve(null) },
    users: createUsersRepository(ctx.databases),
    activityLog: audit,
    logger: memoryLogger().logger,
    versionKey: Buffer.alloc(32, 1),
    now,
    ...(limits === undefined ? {} : { limits }),
    ...overrides,
  });
}

/** A hold of an import: it stops in the middle until a test lets it go. */
let hold: { started: () => void; released: Promise<void> } | null = null;
function holdingService(): CatalogXlsxService {
  const real = realCatalogs();
  // The hold is inside the import, once the group is locked and the transaction is open: the first read of the catalogs of the group waits.
  return serviceWith(undefined, Date.now, ctx.databases, {
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

/** What the faulty databases do: refuse the call number `after` (from 0) to an operation of a collection of the group, then behave. */
let fault: { collection: string; operation: string; after: number; error: Error } | null = null;
/** The accessor of the databases with a collection whose operations fail on request (the way a database that dies in the middle of an import would). */
function faultyDatabases(databases: TestDatabases['databases']): TestDatabases['databases'] {
  const wrapCollection = (name: string, collection: object) =>
    new Proxy(collection, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          if (fault !== null && fault.collection === name && fault.operation === property) {
            if (fault.after <= 0) {
              return Promise.reject(fault.error);
            }
            fault.after -= 1;
          }
          return (value as (...call: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return {
    ...databases,
    group: (groupId, clusterId) =>
      new Proxy(databases.group(groupId, clusterId), {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property, target);
          if (property === 'collection') {
            return (name: string) => wrapCollection(name, target.collection(name));
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  };
}

/** The routes of the import over another service, under another segment. */
function importRoutes(name: string, service: CatalogXlsxService, perGroup = false) {
  const idempotency = createIdempotencyStore(ctx.databases, idempotencyBodyKey(TEST_VERSION_KEY), Date.now);
  return createCatalogXlsxRoutes(createCatalogXlsxController(service), idempotency, perGroup ? undefined : createGate(2, 2))
    .filter((route) => route.method === 'POST')
    .map((route) => ({ ...route, path: route.path.replace('catalog-import', name) }));
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, {
    rateLimiter: limiter,
    extraRoutes: [
      ...importRoutes('import-rows', serviceWith({ rows: { sheet: 2, total: 3 } })),
      ...importRoutes('import-slow', serviceWith({ maxImportMs: 0 }, (() => { let time = 0; return () => (time += 10); })())),
      ...importRoutes('import-held', holdingService()),
      ...importRoutes('import-pergroup', holdingService(), true),
      ...importRoutes('import-faulty', serviceWith(undefined, Date.now, faultyDatabases(ctx.databases))),
    ],
  });
  db = catalogCollections(ctx, world);
  await groups().updateOne({ _id: gid() }, { $set: Object.fromEntries(Object.entries(ALL).map(([key, flag]) => [`settings.${key}`, flag])) });
  const group = (await groups().findOne({ _id: gid() }))!;
  listId = Object.keys(group['priceLists'] as Document)[0]!;
  taxId = (group['taxes'] as Document[])[0]!['id'] as string;
  await groups().updateOne({ _id: gid() }, { $set: Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`priceLists.L${String(index + 2)}`, { id: `L${String(index + 2)}`, name: `Listino ${String(index + 2)}`, status: true, default: false }])) });
  await places().updateOne({ _id: own() }, { $set: { name: 'Bar Alfa', productionCenter: [{ id: 'pc-1' }], printStations: [{ id: 'st-1', name: 'Cucina' }, { id: 'st-2', name: 'Bar' }, { id: 'st-4', name: '' }] } });
  await places().updateOne({ _id: other() }, { $set: { name: 'Bar Beta', printStations: [{ id: 'st-9', name: 'Forno' }] } });
  // The catalog services read the stations and the production centers of a place from its copy in the common database.
  await placeCopies().updateOne({ _id: own() }, { $set: { name: 'Bar Alfa', productionCenter: [{ id: 'pc-1' }], printStations: [{ id: 'st-1', name: 'Cucina' }, { id: 'st-2', name: 'Bar' }] } });
  await placeCopies().updateOne({ _id: other() }, { $set: { name: 'Bar Beta', printStations: [{ id: 'st-9', name: 'Forno' }] } });
  store = await world.activate(own());
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  hold = null;
  fault = null;
  world.office.activity.entries.length = 0;
  audit.entries.length = 0;
  await Promise.all([db.products.deleteMany({}), db.categories.deleteMany({})]);
});

/** A catalog that uses everything the workbook represents and a good deal it does not. */
async function richCatalog(): Promise<void> {
  const root = await seedCategory({
    name: { it: 'Bevande', en: 'Drinks' },
    description: { it: 'Tutte', en: 'All' },
    position: new Int32(4),
    backgroundColor: '#ff0000',
    availability: { pos: true, ecommerce: true },
    printStations: { [`__${hex(own())}`]: ['st-1', 'st-2'] },
    printStationsNoRooms: { [`__${hex(other())}`]: ['st-9'] },
  });
  const child = await seedCategory({
    name: { it: 'Birre' },
    parentId: root,
    position: null,
    backgroundColor: '#AABBCC',
    availability: { pos: false, ecommerce: false },
    variantsCategories: [root],
    placesAvailability: [placeEntry(own(), { position: 2, productionCenterId: 'pc-1' })],
  });
  await seedCategory({ name: { it: 'Dolci' }, placesAvailability: [other()] });
  await seed({
    name: { it: 'Acqua', en: 'Water' },
    shortName: { it: 'H2O' },
    description: { it: 'Naturale', en: 'Still' },
    shortDescription: { it: 'Liscia' },
    code: 'A-1',
    plu: '0123',
    position: new Int32(7),
    scaleType: new Int32(1),
    categories: [child, root],
    favorite: true,
    favoriteHandheld: true,
    availability: { pos: true, warehouse: true, scales: true, ecommerce: true },
    barcode: [{ value: '111', qtLoad: new Double(2), qtSale: new Double(1) }, { value: '222', qtLoad: null, qtSale: new Double(6) }],
    placesAvailability: [placeEntry(own(), { favorite: true, favoriteHandheld: true, position: 3, productionCenterId: 'pc-1' })],
    prices: [
      legacyPrice({ id: 'late', listId, price: new Double(0.98), taxed: new Double(1.2), fromQt: 5 }),
      legacyPrice({ id: 'base', listId, price: new Double(1.22950820), taxed: new Double(1.5), discount: 10 }),
      ...Array.from({ length: 15 }, (_, index) => legacyPrice({ id: `p${String(index + 2)}`, listId: `L${String(index + 2)}`, price: new Double(index + 2), taxed: new Double((index + 2) * 1.22) })),
    ],
  });
  await seed({ name: { it: 'Vino' }, position: null, scaleType: new Int32(0), prices: [], placesAvailability: [other()] });
  await seed({ name: { it: 'Pane' }, prices: [], placesAvailability: [placeEntry(own()), placeEntry(other(), { position: 5 })] });
  await seed({
    name: { it: 'Extra' },
    variant: { status: true, type: 'pm', pricePercentagePlus: new Double(10), pricePercentageMinus: new Double(5), description: { it: 'Doppia' } },
    categories: [root],
    prices: [legacyPrice({ id: 'v1', listId, taxed: new Double(0.5), price: new Double(0.40983607) })],
  });
  await seed({ name: { it: 'Senza' }, prices: [], variant: { status: true, type: 'm', pricePercentagePlus: null, pricePercentageMinus: null, description: { it: '' } }, placesAvailability: [placeEntry(own())] });
}

describe('catalog import: the file the export writes', () => {
  for (const mode of ['ids', 'names'] as const) {
    it(`changes nothing when the export of a rich catalog (references=${mode}) is imported again, whatever the workbook does not represent`, async () => {
      await richCatalog();
      const before = await dump();
      const file = await downloadWorkbook(world, `${exportBase()}?references=${mode}`, sa());
      assert.equal(file.status, 200);
      const mark = world.office.activity.entries.length;
      const reply = await runBytes(file.bytes);
      assert.deepEqual(counts(reply), { products: { ...ZERO, unchanged: 3 }, variants: { ...ZERO, unchanged: 2 }, categories: { ...ZERO, unchanged: 3 } });
      assert.deepEqual(await dump(), before, 'every document is byte for byte what it was');
      const [entry] = imported(mark);
      assert.deepEqual([entry!.outcome, entry!.metadata], ['success', { dryRun: false, inserted: 0, updated: 0, removed: 0, unchanged: 8 }]);
    });
  }

  it('is also the same for a dry run, which answers the same counts', async () => {
    await richCatalog();
    const before = await dump();
    const file = await downloadWorkbook(world, exportBase(), sa());
    const reply = await runBytes(file.bytes, { query: '?dryRun=true' });
    assert.deepEqual(counts(reply, true).products, { ...ZERO, unchanged: 3 });
    assert.deepEqual(await dump(), before);
  });

  it('keeps what the other places have when a place or company administrator imports his own part of the file', async () => {
    await richCatalog();
    const before = await dump();
    for (const actor of [ca(), pa()]) {
      const file = await downloadWorkbook(world, exportBase(), actor);
      const reply = await runBytes(file.bytes, { actor });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(await dump(), before);
    }
  });
});

describe('catalog import: what an export cannot give back unchanged', () => {
  it('writes the print stations of a category in the order of the stations of the place, so a category stored in another order is written once', async () => {
    const id = await seedCategory({ name: { it: 'Ordine' }, printStations: { [`__${hex(own())}`]: ['st-2', 'st-1'] } });
    const file = await downloadWorkbook(world, exportBase(), sa());
    assert.deepEqual(counts(await runBytes(file.bytes)).categories, { ...ZERO, updated: 1 });
    assert.deepEqual((await category(id))!['printStations'][`__${hex(own())}`], ['st-1', 'st-2']);
    assert.deepEqual(counts(await runBytes(file.bytes)).categories, { ...ZERO, unchanged: 1 });
  });

  it('refuses its own file when a price is in a price list the group no longer has, naming the column', async () => {
    await seed({ name: { it: 'Fantasma' }, prices: [legacyPrice({ id: 'g', listId: 'listino-fantasma' })] });
    const file = await downloadWorkbook(world, exportBase(), sa());
    assert.deepEqual(problems(await untouched(() => runBytes(file.bytes))), ['Prodotti:2:LISTINO 1 (ID / NOME ):notFoundReference']);
  });

  it('refuses its own file when a category has a print station whose name another station of the place has', async () => {
    await places().updateOne({ _id: own() }, { $push: { printStations: { id: 'st-3', name: 'Bar' } } as never });
    try {
      await seedCategory({ name: { it: 'Doppio' }, printStations: { [`__${hex(own())}`]: ['st-3'] } });
      const file = await downloadWorkbook(world, exportBase(), sa());
      assert.deepEqual(problems(await untouched(() => runBytes(file.bytes))), ['Categorie:2:POSTAZIONI SALA | Bar Alfa:ambiguousName']);
    } finally {
      await places().updateOne({ _id: own() }, { $pull: { printStations: { id: 'st-3' } } as never });
    }
  });
});

describe('catalog import: names that a spreadsheet could take for a formula', () => {
  const NAMES = [' =1+1', ' +x', '＝1', '＋2', '－3', '＠x', '\u00a0=nbsp', '=1+1', "'=quoted", ' \' =a'];

  it('gives back an exported name that starts like a formula as it was stored, whatever the width of the sign', async () => {
    const names = NAMES.filter((name) => name === name.trim());
    for (const name of names) {
      await seed({ name: { it: name }, code: name, description: { it: name }, prices: [] });
    }
    const before = await dump();
    const reply = await runBytes((await downloadWorkbook(world, exportBase(), sa())).bytes);
    assert.deepEqual(counts(reply).products, { ...ZERO, unchanged: names.length });
    assert.deepEqual(await dump(), before);
  });

  it('reads a text with its white space trimmed, so a stored name that starts with a space is written trimmed by the first import of its export', async () => {
    const id = await seed({ name: { it: ' =1+1' }, code: '\u00a0=nbsp', prices: [] });
    const reply = await runBytes((await downloadWorkbook(world, exportBase(), sa())).bytes);
    assert.deepEqual(counts(reply).products, { ...ZERO, updated: 1 });
    const stored = (await product(id))!;
    assert.deepEqual([stored['name'], stored['code']], [{ it: '=1+1' }, '=nbsp'], 'the neutralization is undone, then the text is trimmed like every cell');
  });
});

describe('catalog import: words that are keys of an object', () => {
  it('refuses a type of variant that is a property of every object, and a header that is one, as any other value', async () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.deepEqual(problems(await untouched(() => variants([{ name: 'V', type: word }]))), ['Varianti:2:TIPO (pm / p / m / i):invalidValue'], word);
    }
    const reply = await untouched(async () => runBytes(await rawBook({ Prodotti: { columns: ['NOME', 'constructor | x', '__proto__ | x', 'toString | Bar Alfa'], rows: [['A', '', '', '']] } })));
    assert.deepEqual(problems(reply), ['Prodotti:-:constructor | x:unknownColumn', 'Prodotti:-:__proto__ | x:unknownColumn', 'Prodotti:-:toString | Bar Alfa:unknownColumn']);
  });
});

describe('catalog import: how the references are recognized', () => {
  let root: ObjectId;
  let child: ObjectId;
  beforeEach(async () => {
    root = await seedCategory({ name: { it: 'Bevande' } });
    child = await seedCategory({ name: { it: ' Birre ' }, parentId: root });
    await seedCategory({ name: { it: 'Doppia' } });
    await seedCategory({ name: { it: 'Doppia' } });
  });
  const categoriesOf = async (name: string) => ((await byName('products', name))[0]!['categories'] as ObjectId[]).map(hex);

  it('takes a category by its id first, then by its exact name, and several of them separated by a bar, without repetitions', async () => {
    const reply = await products([
      { name: 'Per id', categories: hex(root) },
      { name: 'Per nome', categories: 'Bevande' },
      { name: 'Misto', categories: `${hex(child)} | Bevande|  Birre | ${hex(child)} || ` },
      { name: 'Nessuna', categories: '' },
    ]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 4 });
    assert.deepEqual(await categoriesOf('Per id'), [hex(root)]);
    assert.deepEqual(await categoriesOf('Per nome'), [hex(root)]);
    assert.deepEqual(await categoriesOf('Misto'), [hex(child), hex(root)]);
    assert.deepEqual(await categoriesOf('Nessuna'), []);
  });

  it('compares a name as it is: case and inner spaces count, and a name two categories have is a problem, as is one that matches nothing', async () => {
    const reply = await untouched(() =>
      products([
        { name: 'A', categories: 'bevande' },
        { name: 'B', categories: 'Doppia' },
        { name: 'C', categories: 'Bev ande' },
        { name: 'D', categories: `Bevande | ${'0'.repeat(24)}` },
        { name: 'E', categories: 'Bevande | Doppia | Altro' },
      ]),
    );
    assert.deepEqual(problems(reply), [
      'Prodotti:2:CATEGORIE (ID / NOME):notFoundReference',
      'Prodotti:3:CATEGORIE (ID / NOME):ambiguousName',
      'Prodotti:4:CATEGORIE (ID / NOME):notFoundReference',
      'Prodotti:5:CATEGORIE (ID / NOME):notFoundReference',
      'Prodotti:6:CATEGORIE (ID / NOME):ambiguousName',
      'Prodotti:6:CATEGORIE (ID / NOME):notFoundReference',
    ]);
  });

  it('keeps the categories of a product when the cell says the same, changes them when it does not, and an empty cell takes them all away', async () => {
    const id = await seed({ name: { it: 'Birra' }, categories: [root, child] });
    const same = await products([{ id: hex(id), categories: `Birre|${hex(root)}` }]);
    assert.deepEqual(counts(same).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(await categoriesOf('Birra'), [hex(root), hex(child)], 'the order of a cell does not rewrite');
    assert.deepEqual(counts(await products([{ id: hex(id), categories: 'Birre' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(await categoriesOf('Birra'), [hex(child)]);
    assert.deepEqual(counts(await products([{ id: hex(id), categories: '' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(await categoriesOf('Birra'), []);
  });

  it('gives the variants the same categories', async () => {
    const reply = await variants([{ name: 'Extra', categories: 'Bevande | Birre', type: 'p' }]);
    assert.deepEqual(counts(reply).variants, { ...ZERO, inserted: 1 });
    const [created] = await byName('products', 'Extra');
    assert.deepEqual((created!['categories'] as ObjectId[]).map(hex), [hex(root), hex(child)]);
    assert.equal((await untouched(() => variants([{ name: 'Altra', categories: 'Doppia' }]))).status, 422);
  });

  it('takes the parent and the categories of the modifiers of a category by id or by name, and an empty cell takes them away', async () => {
    const reply = await categories([{ name: 'Figlia', parent: 'Bevande', modifierCategories: `Birre | ${hex(root)}` }, { name: 'Radice', parent: '' }]);
    assert.deepEqual(counts(reply).categories, { ...ZERO, inserted: 2 });
    const [daughter] = await byName('categories', 'Figlia');
    assert.equal(hex(daughter!['parentId'] as ObjectId), hex(root));
    assert.deepEqual((daughter!['variantsCategories'] as ObjectId[]).map(hex), [hex(child), hex(root)]);
    const cleared = await categories([{ id: hex(daughter!['_id'] as ObjectId), parent: '', modifierCategories: '' }]);
    assert.deepEqual(counts(cleared).categories, { ...ZERO, updated: 1 });
    const [after] = await byName('categories', 'Figlia');
    assert.deepEqual([after!['parentId'], after!['variantsCategories']], [null, []]);
    assert.deepEqual(problems(await categories([{ name: 'Orfana', parent: 'Nessuno' }, { name: 'Ambigua', parent: 'Doppia' }, { name: 'Modifica', modifierCategories: 'Boh | Doppia' }])), [
      'Categorie:2:GENITORE:notFoundReference',
      'Categorie:3:GENITORE:ambiguousName',
      'Categorie:4:CATEGORIE VARIANTI (ID / NOME):notFoundReference',
      'Categorie:4:CATEGORIE VARIANTI (ID / NOME):ambiguousName',
    ]);
  });

  it('takes a price list by id first, then by name, and refuses one that does not exist', async () => {
    const reply = await products([
      { name: 'Per id', list1: listId, price1: '1', tax1: taxId, list2: 'L2', price2: '2', tax2: taxId },
      { name: 'Per nome', list1: 'Listino 1', price1: '1', tax1: taxId, list2: ` Listino 3 `, price2: '3', tax2: taxId },
    ]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 2 });
    const listsOf = async (name: string) => ((await byName('products', name))[0]!['prices'] as Document[]).map((price) => price['listId']);
    assert.deepEqual(await listsOf('Per id'), [listId, 'L2']);
    assert.deepEqual(await listsOf('Per nome'), [listId, 'L3']);
    assert.deepEqual(problems(await untouched(() => products([{ name: 'X', list1: 'listino 1', price1: '1', tax1: taxId }, { name: 'Y', list1: 'Nessuno', price1: '1', tax1: taxId }]))), [
      'Prodotti:2:LISTINO 1 (ID / NOME ):notFoundReference',
      'Prodotti:3:LISTINO 1 (ID / NOME ):notFoundReference',
    ]);
  });

  it('takes a tax rate by id first, then by percentage with a point or a comma, and refuses a rate the group does not have', async () => {
    const reply = await products([
      { name: 'Id', list1: listId, price1: '10', tax1: taxId },
      { name: 'Punto', list1: listId, price1: '10', tax1: '22.0' },
      { name: 'Virgola', list1: listId, price1: '10', tax1: ' 22,00 ' },
    ]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 3 });
    for (const name of ['Id', 'Punto', 'Virgola']) {
      const [price] = (await byName('products', name))[0]!['prices'] as Document[];
      assert.deepEqual([price!['taxData'].id, price!['taxed'], price!['tax']], [taxId, 10, 22], name);
    }
    assert.deepEqual(problems(await products([{ name: 'A', list1: listId, price1: '1', tax1: '10' }, { name: 'B', list1: listId, price1: '1', tax1: 'iva' }, { name: 'C', list1: listId, price1: '1', tax1: '22%' }])), [
      'Prodotti:2:ALIQUOTA 1 (ID / VALORE):notFoundReference',
      'Prodotti:3:ALIQUOTA 1 (ID / VALORE):notFoundReference',
      'Prodotti:4:ALIQUOTA 1 (ID / VALORE):notFoundReference',
    ]);
  });

  it('refuses a percentage that two tax rates have, unless the price being updated already has one of them, which is kept', async () => {
    await groups().updateOne({ _id: gid() }, { $push: { taxes: { id: TAX_B, value: 22, department: 2, description: null, natura: null } } as never });
    try {
      assert.deepEqual(problems(await products([{ name: 'Nuovo', list1: listId, price1: '1', tax1: '22' }])), ['Prodotti:2:ALIQUOTA 1 (ID / VALORE):ambiguousName']);
      const withB = await seed({ name: { it: 'Con B' }, prices: [legacyPrice({ id: 'b', listId, taxed: new Double(1), taxData: { id: TAX_B, value: 22, department: 2, description: null, natura: null } })] });
      const withA = await seed({ name: { it: 'Con A' }, prices: [legacyPrice({ id: 'a', listId, taxed: new Double(1) })] });
      const reply = await products([{ id: hex(withB), list1: listId, price1: '3', tax1: '22' }, { id: hex(withA), list1: listId, price1: '4', tax1: '22' }]);
      assert.deepEqual(counts(reply).products, { ...ZERO, updated: 2 });
      assert.deepEqual([(await product(withB))!['prices'][0].taxData.id, (await product(withA))!['prices'][0].taxData.id], [TAX_B, taxId]);
      assert.deepEqual([(await product(withB))!['prices'][0].taxed, (await product(withA))!['prices'][0].taxed], [3, 4]);
      const byId = await products([{ id: hex(withA), list1: listId, price1: '4', tax1: TAX_B }]);
      assert.deepEqual(counts(byId).products, { ...ZERO, updated: 1 }, 'an id says which one');
      assert.equal((await product(withA))!['prices'][0].taxData.id, TAX_B);
    } finally {
      await groups().updateOne({ _id: gid() }, { $pull: { taxes: { id: TAX_B } } as never });
    }
  });

  it('takes a color from 1 to 12 or as #rrggbb in any case, keeps it when it is the same, and refuses anything else; an empty cell leaves the color alone', async () => {
    const reply = await categories([{ name: 'Uno', color: '1' }, { name: 'Dodici', color: '12' }, { name: 'Esa', color: '#AbCdEf' }, { name: 'Vuoto', color: '' }]);
    assert.deepEqual(counts(reply).categories, { ...ZERO, inserted: 4 });
    assert.deepEqual((await byName('categories', 'Uno'))[0]!['backgroundColor'], '#ff8064');
    assert.deepEqual((await byName('categories', 'Dodici'))[0]!['backgroundColor'], '#5c98b1');
    assert.deepEqual((await byName('categories', 'Esa'))[0]!['backgroundColor'], '#abcdef');
    const empty = (await byName('categories', 'Vuoto'))[0]!['backgroundColor'];
    const again = await categories([{ id: hex((await byName('categories', 'Esa'))[0]!['_id'] as ObjectId), color: '#ABCDEF' }, { id: hex((await byName('categories', 'Vuoto'))[0]!['_id'] as ObjectId), color: '' }]);
    assert.deepEqual(counts(again).categories, { ...ZERO, unchanged: 2 });
    assert.equal((await byName('categories', 'Vuoto'))[0]!['backgroundColor'], empty);
    const refused = await categories([{ name: 'A', color: '0' }, { name: 'B', color: '13' }, { name: 'C', color: '#abc' }, { name: 'D', color: 'rosso' }, { name: 'E', color: '#12345g' }, { name: 'F', color: '1.5' }]);
    assert.deepEqual(codes(refused), Array(6).fill('invalidValue'));
    assert.ok(problems(refused).every((line) => line.includes('COLORE (1-12 / HEX)')));
  });
});

describe('catalog import: the other cells of a product', () => {
  it('reads the flags: X in any case is on, an empty cell is off, any other text is not a value; a flag that does not change writes nothing', async () => {
    const reply = await products([
      { name: 'Tutti', pos: 'x', favorite: 'X', favoriteHandheld: ' x ', warehouse: 'X', scales: 'X', ecommerce: 'X' },
      { name: 'Nessuno', pos: '', favorite: '', favoriteHandheld: '', warehouse: '', scales: '', ecommerce: '' },
    ]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 2 });
    const [all] = await byName('products', 'Tutti');
    assert.deepEqual([all!['availability'], all!['favorite'], all!['favoriteHandheld']], [{ pos: true, warehouse: true, scales: true, ecommerce: true }, true, true]);
    const [none] = await byName('products', 'Nessuno');
    assert.deepEqual([none!['availability'], none!['favorite'], none!['favoriteHandheld']], [{ pos: false, warehouse: false, scales: false, ecommerce: false }, false, false], 'an empty cell of a column that is there is a no, for a new product too');
    assert.deepEqual(counts(await products([{ id: hex(all!['_id'] as ObjectId), pos: 'X', favorite: 'x' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(none!['_id'] as ObjectId), favorite: '', warehouse: '' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(none!['_id'] as ObjectId), pos: '' }])).products, { ...ZERO, unchanged: 1 }, 'an empty cell is off');
    assert.deepEqual(counts(await products([{ id: hex(none!['_id'] as ObjectId), pos: 'X' }])).products, { ...ZERO, updated: 1 });
    assert.equal((await product(none!['_id'] as ObjectId))!['availability'].pos, true);
    const flipped = await products([{ id: hex(all!['_id'] as ObjectId), pos: '', favorite: '' }]);
    assert.deepEqual(counts(flipped).products, { ...ZERO, updated: 1 });
    assert.deepEqual([(await product(all!['_id'] as ObjectId))!['availability'].pos, (await product(all!['_id'] as ObjectId))!['favorite']], [false, false]);
    const refused = await untouched(() => products([{ name: 'A', pos: 'si' }, { name: 'B', favorite: '1' }, { name: 'C', favoriteHandheld: 'xx' }, { name: 'D', warehouse: 'no' }, { name: 'E', scales: 'true' }, { name: 'F', ecommerce: '✓' }]));
    assert.deepEqual(codes(refused), Array(6).fill('invalidValue'));
    const absent = await products([{ name: 'Senza colonna' }]);
    assert.deepEqual(counts(absent).products, { ...ZERO, inserted: 1 });
    assert.equal((await byName('products', 'Senza colonna'))[0]!['availability'].pos, true, 'a column that is not there leaves a new product what the catalog makes it (on the cash register)');
    assert.deepEqual(problems(refused).map((line) => line.split(':')[2]), ['DISPONIBILE CASSA (X)', 'PREFERITO (X)', 'PREFERITO PALMARE (X)', 'MOVIMENTA MAGAZZINO (X)', 'DISPONIBILE BILANCIA (X)', 'DISPONIBILE E-COMMERCE (X)']);
  });

  it('does not send a no for a function the group does not have, and refuses an X for it', async () => {
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.cash': false, 'settings.warehouse': false, 'settings.scales': false, 'settings.customersApp': false, 'settings.rooms': false } });
    try {
      const reply = await products([{ name: 'Senza funzioni', pos: '', warehouse: '', scales: '', ecommerce: '', favoriteHandheld: '', favorite: '' }]);
      assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 1 });
      const refused = await untouched(() => products([{ name: 'Con X', pos: 'X', warehouse: 'X' }]));
      assert.equal(refused.status, 422);
      assert.ok(problems(refused).every((line) => /:(invalid|forbidden|conflict)$/.test(line)), problems(refused).join(' '));
    } finally {
      await groups().updateOne({ _id: gid() }, { $set: Object.fromEntries(Object.entries(ALL).map(([key, flag]) => [`settings.${key}`, flag])) });
    }
  });

  it('reads the scale type: p is by piece, w by weight in any case; an empty cell makes a weight a piece and leaves a new product as it is; anything else is not a value', async () => {
    const reply = await products([{ name: 'Pezzo', scaleType: 'p' }, { name: 'Peso', scaleType: 'W' }, { name: 'Vuoto', scaleType: '' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 3 });
    const scale = async (name: string) => Number((await byName('products', name))[0]!['scaleType']);
    assert.deepEqual([await scale('Pezzo'), await scale('Peso'), await scale('Vuoto')], [1, 0, 0]);
    const id = (await byName('products', 'Peso'))[0]!['_id'] as ObjectId;
    assert.deepEqual(counts(await products([{ id: hex(id), scaleType: 'w' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(id), scaleType: '' }])).products, { ...ZERO, updated: 1 });
    assert.equal(Number((await product(id))!['scaleType']), 1, 'the legacy took any other text for a piece');
    assert.deepEqual(counts(await products([{ id: hex(id), scaleType: '' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(codes(await untouched(() => products([{ name: 'X', scaleType: 'kg' }, { name: 'Y', scaleType: 'pw' }]))), ['invalidValue', 'invalidValue']);
  });

  it('reads the type of a variant in any case, makes a new variant a modifier, keeps a type that does not change, and refuses another one', async () => {
    const reply = await variants([{ name: 'Piu', type: 'P' }, { name: 'Meno', type: 'm' }, { name: 'Entrambi', type: 'pm' }, { name: 'Nota', type: 'i' }, { name: 'Senza tipo' }]);
    assert.deepEqual(counts(reply).variants, { ...ZERO, inserted: 5 });
    const kinds = async (name: string) => (await byName('products', name))[0]!['variant'] as Document;
    assert.deepEqual(await Promise.all(['Piu', 'Meno', 'Entrambi', 'Nota', 'Senza tipo'].map(async (name) => (await kinds(name))['type'])), ['p', 'm', 'pm', 'i', 'pm']);
    assert.ok((await Promise.all(['Piu', 'Senza tipo'].map(async (name) => (await kinds(name))['status']))).every((status) => status === true));
    const id = (await byName('products', 'Piu'))[0]!['_id'] as ObjectId;
    assert.deepEqual(counts(await variants([{ id: hex(id), type: 'p' }, { id: hex((await byName('products', 'Meno'))[0]!['_id'] as ObjectId), type: '' }])).variants, { ...ZERO, unchanged: 2 });
    assert.deepEqual(counts(await variants([{ id: hex(id), type: 'i' }])).variants, { ...ZERO, updated: 1 });
    assert.equal(((await product(id))!['variant'] as Document)['type'], 'i');
    assert.deepEqual(codes(await untouched(() => variants([{ name: 'X', type: 'q' }, { name: 'Y', type: 'pp' }]))), ['invalidValue', 'invalidValue']);
    assert.ok(problems(await variants([{ name: 'X', type: 'q' }])).every((line) => line.includes('TIPO (pm / p / m / i)')));
  });

  it('reads the barcode: the first one is the cell, the others and the quantities stay, an empty cell takes the first away, and an existing one moves to the first place', async () => {
    const id = await seed({
      name: { it: 'Acqua' },
      barcode: [{ value: '111', qtLoad: new Double(2), qtSale: new Double(1) }, { value: '222', qtLoad: new Double(4), qtSale: new Double(6) }, { value: '333', qtLoad: null, qtSale: new Double(1) }],
    });
    const stored = async () => ((await product(id))!['barcode'] as Document[]).map((entry) => [entry['value'], entry['qtLoad'] === null ? null : Number(entry['qtLoad']), entry['qtSale'] === null ? null : Number(entry['qtSale'])]);
    assert.deepEqual(counts(await products([{ id: hex(id), barcode: '111' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(id), barcode: ' 999 ' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(await stored(), [['999', null, null], ['222', 4, 6], ['333', null, 1]], 'the first is replaced, the others keep their quantities');
    assert.deepEqual(counts(await products([{ id: hex(id), barcode: '333' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(await stored(), [['333', null, 1], ['222', 4, 6]], 'an existing barcode moves to the first place and is not repeated');
    assert.deepEqual(counts(await products([{ id: hex(id), barcode: '' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(await stored(), [['222', 4, 6]]);
    assert.deepEqual(counts(await products([{ id: hex(id), barcode: '' }])).products, { ...ZERO, updated: 1 }, 'the next barcode takes the place of the first');
    assert.deepEqual(counts(await products([{ id: hex(id), barcode: '' }])).products, { ...ZERO, unchanged: 1 }, 'nothing left to take away');
    assert.deepEqual(counts(await products([{ name: 'Nuovo', barcode: '555' }])).products, { ...ZERO, inserted: 1 });
    assert.deepEqual(((await byName('products', 'Nuovo'))[0]!['barcode'] as Document[]).map((entry) => entry['value']), ['555']);
  });

  it('lets a barcode be on more than one product, as the catalog does', async () => {
    await seed({ name: { it: 'Altro' }, barcode: [{ value: '777', qtLoad: null, qtSale: 1 }] });
    const reply = await products([{ name: 'Uno', barcode: '777' }, { name: 'Due', barcode: '888' }, { name: 'Tre', barcode: '888' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 3 });
    assert.equal(await db.products.countDocuments({ 'barcode.value': '888' }), 2);
  });

  it('reads the plu, the code and the position, and an empty cell takes the plu and the position away', async () => {
    const reply = await products([{ name: 'Con tutto', plu: '12', code: 'A-1', position: '9' }, { name: 'Vuoto', plu: '', code: '', position: '' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 2 });
    const [full] = await byName('products', 'Con tutto');
    assert.deepEqual([full!['plu'], full!['code'], Number(full!['position'])], ['12', 'A-1', 9]);
    const id = full!['_id'] as ObjectId;
    assert.deepEqual(counts(await products([{ id: hex(id), plu: '12', code: 'A-1', position: '9' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(id), plu: '', code: 'B-2', position: '' }])).products, { ...ZERO, updated: 1 });
    const after = (await product(id))!;
    assert.deepEqual([after['plu'], after['code'], after['position']], [null, 'B-2', null]);
    assert.deepEqual(codes(await untouched(() => products([{ name: 'X', position: 'x' }, { name: 'Y', position: '-1' }, { name: 'Z', position: '1.5' }, { name: 'W', position: '1000000000' }]))), Array(4).fill('invalidValue'));
  });

  it('takes the texts of the other languages and the ones the sheet does not have as they are, changes only the italian text, and takes a text away with an empty cell', async () => {
    const id = await seed({ name: { it: 'Acqua', en: 'Water' }, shortName: { it: 'H2O', en: 'W' }, description: { it: 'Liscia', en: 'Still' }, shortDescription: { it: 'Corta', en: 'Short' } });
    const reply = await products([{ id: hex(id), name: 'Acqua minerale', shortName: '', description: 'Frizzante' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, updated: 1 });
    const after = (await product(id))!;
    assert.deepEqual([after['name'], after['shortName'], after['description'], after['shortDescription']], [{ it: 'Acqua minerale', en: 'Water' }, { en: 'W' }, { it: 'Frizzante', en: 'Still' }, { it: 'Corta', en: 'Short' }]);
  });

  it('refuses a name that is empty or missing for a new element, and the texts the catalog refuses, naming the column', async () => {
    const reply = await untouched(() => products([{ name: '', code: 'x' }, { shortName: 'x' }, { name: 'Lungo', shortName: 'abcdefghijklmnopqrs' }, { name: 'N'.repeat(300) }]));
    assert.deepEqual(problems(reply).map((line) => line.split(':').slice(0, 4).join(':')), ['Prodotti:2:NOME:required', 'Prodotti:3:NOME:required', 'Prodotti:4:NOME BREVE:invalid', 'Prodotti:5:NOME:invalid']);
    const existing = await seed({ name: { it: 'Esiste' } });
    assert.deepEqual(problems(await untouched(() => products([{ id: hex(existing), name: '' }]))), ['Prodotti:2:NOME:required']);
    assert.deepEqual(counts(await products([{ id: hex(existing), code: 'C-1' }])).products, { ...ZERO, unchanged: 1 }, 'a sheet with no name column leaves the name alone');
  });

  it('takes the symbols that would be a formula or an operator of the database as plain text', async () => {
    const reply = await products([{ name: '=SUM(A1)', description: "'=cmd|' /C calc'!A0", code: '$gt', plu: '42' }, { name: "'=quoted", description: '{"$ne":null}', code: 'a.b' }, { name: '+1', description: '-1', code: '@x' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 3 });
    const [formula] = await byName('products', '=SUM(A1)');
    assert.deepEqual([formula!['description'], formula!['code'], formula!['plu']], [{ it: "'=cmd|' /C calc'!A0" }, '$gt', '42']);
    assert.equal((await byName('products', "'=quoted")).length, 1);
    assert.equal((await byName('products', '+1')).length, 1);
    assert.deepEqual(await db.products.countDocuments({ code: '$gt' }), 1);
  });
});

describe('catalog import: the prices', () => {
  const pricesOf = async (id: ObjectId) => ((await product(id))!['prices'] as Document[]).map((price) => ({ id: price['id'], listId: price['listId'], taxed: Number(price['taxed']), tax: price['taxData']?.id, discount: price['discount'] === undefined ? undefined : Number(price['discount']), fromQt: price['fromQt'] === undefined ? undefined : Number(price['fromQt']) }));

  it('creates a price for each complete triple, with the net price computed, in euro, and reads the price with a comma or a point', async () => {
    const reply = await products([{ name: 'Due prezzi', list1: listId, price1: '1,5', tax1: taxId, list2: 'L2', price2: ' 2.25 ', tax2: '22' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 1 });
    const [created] = await byName('products', 'Due prezzi');
    const rules = created!['prices'] as Document[];
    assert.deepEqual(rules.map((rule) => [rule['listId'], Number(rule['taxed']), Number(rule['price']), rule['currency'], rule['taxData'].id, Number(rule['fromQt'])]), [
      [listId, 1.5, 1.2295082, 'EUR', taxId, 1],
      ['L2', 2.25, 1.8442623, 'EUR', taxId, 1],
    ]);
    assert.ok(rules.every((rule) => typeof rule['id'] === 'string' && rule['id'] !== ''));
  });

  it('gives a new price the first currency of the group when it has no euro', async () => {
    await groups().updateOne({ _id: gid() }, { $set: { currencies: { USD: { code: 'USD', symbol: '$' } } } });
    try {
      assert.deepEqual(counts(await products([{ name: 'Dollari', list1: listId, price1: '1', tax1: taxId }])).products, { ...ZERO, inserted: 1 });
      assert.equal((await byName('products', 'Dollari'))[0]!['prices'][0].currency, 'USD');
    } finally {
      await groups().updateOne({ _id: gid() }, { $set: { currencies: { EUR: { code: 'EUR', symbol: '&euro;' }, USD: { code: 'USD', symbol: '$' } } } });
    }
    await groups().updateOne({ _id: gid() }, { $set: { currencies: {} } });
    try {
      const reply = await untouched(() => products([{ name: 'Senza valuta', list1: listId, price1: '1', tax1: taxId }]));
      assert.ok(['invalid', 'conflict'].includes(codes(reply)[0]!), 'a group with no currency is a catalog the service refuses, with a problem of the row');
    } finally {
      await groups().updateOne({ _id: gid() }, { $set: { currencies: { EUR: { code: 'EUR', symbol: '&euro;' }, USD: { code: 'USD', symbol: '$' } } } });
    }
  });

  it('updates the rule a price list has, keeping its id, its discount and its periods, and the other rules and lists as they are; it writes nothing when nothing changes', async () => {
    const id = await seed({
      name: { it: 'Prezzi' },
      prices: [
        legacyPrice({ id: 'late', listId, taxed: new Double(1.2), price: new Double(0.98), fromQt: 5 }),
        legacyPrice({ id: 'timed', listId, taxed: new Double(1.1), price: new Double(0.9), startDate: '2026-01-01T00:00:00.000Z' }),
        legacyPrice({ id: 'base', listId, taxed: new Double(1.5), price: new Double(1.2295082), discount: 10 }),
        legacyPrice({ id: 'l2', listId: 'L2', taxed: new Double(2), price: new Double(1.6393443), discount: 0 }),
      ],
    });
    assert.deepEqual(counts(await products([{ id: hex(id), list1: listId, price1: '1.5', tax1: taxId, list2: 'L2', price2: '2', tax2: taxId }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(id), list1: 'Listino 1', price1: '3,5', tax1: '22' }])).products, { ...ZERO, updated: 1 });
    const stored = await pricesOf(id);
    assert.deepEqual(stored.map((rule) => [rule.id, rule.listId, rule.taxed, rule.discount, rule.fromQt]), [['late', listId, 1.2, 0, 5], ['timed', listId, 1.1, 0, 1], ['base', listId, 3.5, 10, 1], ['l2', 'L2', 2, 0, 1]]);
    assert.equal(((await product(id))!['prices'] as Document[])[1]!['startDate'], '2026-01-01T00:00:00.000Z', 'the validity of the other rules stays');
  });

  it('changes the tax rate of a price by its id, and keeps a price in a list the row does not name; nothing is ever taken away', async () => {
    await groups().updateOne({ _id: gid() }, { $push: { taxes: { id: TAX_B, value: 10, department: 3, description: null, natura: null } } as never });
    try {
      const id = await seed({ name: { it: 'Aliquote' }, prices: [legacyPrice({ id: 'a', listId, taxed: new Double(1) }), legacyPrice({ id: 'b', listId: 'L2', taxed: new Double(2) })] });
      assert.deepEqual(counts(await products([{ id: hex(id), list1: listId, price1: '1', tax1: '10' }])).products, { ...ZERO, updated: 1 });
      assert.deepEqual((await pricesOf(id)).map((rule) => [rule.listId, rule.tax, rule.taxed]), [[listId, TAX_B, 1], ['L2', taxId, 2]]);
      assert.deepEqual(counts(await products([{ id: hex(id), list1: '', price1: '', tax1: '' }])).products, { ...ZERO, unchanged: 1 }, 'an empty triple is nothing');
      assert.equal(((await product(id))!['prices'] as Document[]).length, 2);
    } finally {
      await groups().updateOne({ _id: gid() }, { $pull: { taxes: { id: TAX_B } } as never });
    }
  });

  it('keeps a price that has only the net amount or no discount as it is while another list is updated', async () => {
    const id = await seed({
      name: { it: 'Netto' },
      prices: [legacyPrice({ id: 'n', listId: 'L2', taxed: undefined, price: new Double(5), discount: undefined }), legacyPrice({ id: 'g', listId, taxed: new Double(1) })],
    });
    assert.deepEqual(counts(await products([{ id: hex(id), list1: listId, price1: '2', tax1: taxId }])).products, { ...ZERO, updated: 1 });
    const [net, gross] = (await product(id))!['prices'] as Document[];
    assert.deepEqual([net!['id'], Number(net!['price']), gross!['id'], Number(gross!['taxed'])], ['n', 5, 'g', 2]);
    assert.deepEqual(counts(await products([{ id: hex(id), list1: 'L2', price1: '6', tax1: taxId }])).products, { ...ZERO, updated: 1 });
    assert.equal(Number(((await product(id))!['prices'] as Document[])[0]!['taxed']), 6, 'a price given as a gross amount replaces the net one');
  });

  it('is a problem of the row when the triple is not complete, repeats a price list, or has a price that is not a number', async () => {
    const reply = await untouched(() =>
      products([
        { name: 'A', list1: listId, price1: '', tax1: taxId },
        { name: 'B', list1: '', price1: '1', tax1: taxId },
        { name: 'C', list1: listId, price1: '1', tax1: '' },
        { name: 'D', list1: listId, price1: '1', tax1: taxId, list2: 'Listino 1', price2: '2', tax2: taxId },
        { name: 'E', list1: listId, price1: 'abc', tax1: taxId },
        { name: 'F', list1: listId, price1: '-1', tax1: taxId },
        { name: 'G', list1: listId, price1: '1e3', tax1: taxId },
        { name: 'H', list1: listId, price1: '1,2,3', tax1: taxId },
        { name: 'I', list1: listId, price1: '1', tax1: taxId, price2: '5' },
      ]),
    );
    assert.deepEqual(problems(reply), [
      'Prodotti:2:PREZZO 1:incompletePrice',
      'Prodotti:3:LISTINO 1 (ID / NOME ):incompletePrice',
      'Prodotti:4:ALIQUOTA 1 (ID / VALORE):incompletePrice',
      'Prodotti:5:LISTINO 2 (ID / NOME ):duplicatePriceList',
      'Prodotti:6:PREZZO 1:invalidValue',
      'Prodotti:7:PREZZO 1:invalidValue',
      'Prodotti:8:PREZZO 1:invalidValue',
      'Prodotti:9:PREZZO 1:invalidValue',
      'Prodotti:10:LISTINO 2 (ID / NOME ):incompletePrice',
    ]);
  });

  it('cannot update the prices of a product that has one the workbook cannot represent, and says so without touching it', async () => {
    const cases: Document[] = [
      legacyPrice({ id: 'x', listId: undefined }),
      legacyPrice({ id: 'x', currency: undefined }),
      legacyPrice({ id: 'x', taxData: undefined }),
      legacyPrice({ id: 'x', taxed: undefined, price: undefined }),
    ];
    for (const [index, broken] of cases.entries()) {
      const id = await seed({ name: { it: `Rotto ${String(index)}` }, prices: [broken, legacyPrice({ id: 'ok', listId })] });
      const reply = await untouched(() => products([{ id: hex(id), list1: listId, price1: '9', tax1: taxId }]));
      assert.deepEqual(problems(reply), ['Prodotti:2:LISTINO 1 (ID / NOME ):notRepresentable'], `case ${String(index)}`);
    }
  });

  it('leaves the prices alone when the sheet has no price column, even on a product the workbook cannot represent', async () => {
    const id = await seed({ name: { it: 'Rotto' }, prices: [legacyPrice({ id: 'x', listId: 'listino-fantasma' })] });
    assert.deepEqual(counts(await products([{ id: hex(id), name: 'Rotto' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(id), name: 'Aggiustato' }])).products, { ...ZERO, updated: 1 });
    assert.equal(((await product(id))!['prices'] as Document[])[0]!['listId'], 'listino-fantasma');
  });

  it('adds the price of a list to a product that has a price in a list the group no longer has, and keeps the old one', async () => {
    const id = await seed({ name: { it: 'Fantasma' }, prices: [legacyPrice({ id: 'g', listId: 'listino-fantasma' })] });
    assert.deepEqual(counts(await products([{ id: hex(id), list1: listId, price1: '1', tax1: taxId }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual((await pricesOf(id)).map((rule) => rule.listId), ['listino-fantasma', listId]);
  });
});

const ALFA = 'DISPO | Bar Alfa';
const BETA = 'DISPO | Bar Beta';
const SALA_ALFA = 'POSTAZIONI SALA | Bar Alfa';
const BANCO_ALFA = 'POSTAZIONI BANCO | Bar Alfa';
const SALA_BETA = 'POSTAZIONI SALA | Bar Beta';
const entriesOf = (document: Document | null) => ((document!['placesAvailability'] as unknown[]) ?? []).map((entry) => (entry instanceof ObjectId ? hex(entry) : hex((entry as Document)['id'] as ObjectId)));

describe('catalog import: the points of sale', () => {
  it('leaves the places of an element alone when the sheet has no column of a point of sale, and when the columns say what it has', async () => {
    const id = await seed({ name: { it: 'Acqua' }, placesAvailability: [placeEntry(own(), { favorite: true, favoriteHandheld: true, position: 3, productionCenterId: 'pc-1' }), placeEntry(other(), { position: 5 })] });
    const before = (await product(id))!['placesAvailability'];
    assert.deepEqual(counts(await products([{ id: hex(id), name: 'Acqua minerale' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual((await product(id))!['placesAvailability'], before);
    assert.deepEqual(counts(await products([{ id: hex(id), [ALFA]: 'X', [BETA]: 'x' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual((await product(id))!['placesAvailability'], before);
  });

  it('adds a place with an X and takes it away without one, keeping what the other places have; nothing in the columns of a product that has some makes it one for every place', async () => {
    const id = await seed({ name: { it: 'Acqua' }, placesAvailability: [placeEntry(own(), { favorite: true, favoriteHandheld: true, position: 3, productionCenterId: 'pc-1' })] });
    assert.deepEqual(counts(await products([{ id: hex(id), [ALFA]: 'X', [BETA]: 'X' }])).products, { ...ZERO, updated: 1 });
    const added = ((await product(id))!['placesAvailability'] as Document[]).map((entry) => [hex(entry['id'] as ObjectId), entry['favorite'], Number(entry['position'] ?? 0), entry['productionCenterId']]);
    assert.deepEqual(added, [[hex(own()), true, 3, 'pc-1'], [hex(other()), false, 0, null]], 'the place that was there is as it was, the new one is blank');
    assert.deepEqual(counts(await products([{ id: hex(id), [ALFA]: '', [BETA]: 'X' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(entriesOf(await product(id)), [hex(other())]);
    assert.deepEqual(counts(await products([{ id: hex(id), [BETA]: '' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual((await product(id))!['placesAvailability'], [], 'no place is every place');
    assert.deepEqual(counts(await products([{ id: hex(id), [ALFA]: '', [BETA]: '' }])).products, { ...ZERO, unchanged: 1 });
  });

  it('takes away only the places of the columns of the sheet: a place whose column the file does not have stays', async () => {
    const id = await seed({ name: { it: 'Acqua' }, placesAvailability: [placeEntry(own(), { favorite: true }), placeEntry(other(), { position: 5 })] });
    assert.deepEqual(counts(await products([{ id: hex(id), [ALFA]: '' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(entriesOf(await product(id)), [hex(other())]);
  });

  it('gives a new product the places of the X and one with none to every place', async () => {
    const reply = await products([{ name: 'Qui', [ALFA]: 'X', [BETA]: '' }, { name: 'Ovunque', [ALFA]: '', [BETA]: '' }, { name: 'Tutti e due', [ALFA]: 'x', [BETA]: 'X' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 3 });
    assert.deepEqual([entriesOf((await byName('products', 'Qui'))[0]!), entriesOf((await byName('products', 'Ovunque'))[0]!), entriesOf((await byName('products', 'Tutti e due'))[0]!)], [[hex(own())], [], [hex(own()), hex(other())]]);
  });

  it('keeps an element of the historical form (a plain id) when the column says the same, and writes the entries when it changes', async () => {
    const id = await seed({ name: { it: 'Storico' }, placesAvailability: [other()] });
    assert.deepEqual(counts(await products([{ id: hex(id), [BETA]: 'X' }])).products, { ...ZERO, unchanged: 1 });
    assert.ok((await product(id))!['placesAvailability'][0] instanceof ObjectId);
    assert.deepEqual(counts(await products([{ id: hex(id), [BETA]: 'X', [ALFA]: 'X' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(entriesOf(await product(id)), [hex(other()), hex(own())]);
  });

  it('refuses a column that names a point of sale the group does not have, once for the sheet and without reading its rows', async () => {
    const reply = await untouched(() => run({ products: [{ name: 'A', 'DISPO | Bar Gamma': 'X' }, { name: '' , code: 'x' }], categories: [{ name: 'Valida' }] }));
    assert.deepEqual(problems(reply), ['Prodotti:-:DISPO | Bar Gamma:unknownPlace']);
    assert.equal(reply.body.error.rows[0].message, 'The point of sale of the column does not exist, is in the trash or is not in the perimeter of the caller');
    const trashed = await untouched(async () => {
      await places().updateOne({ _id: other() }, { $set: { trash: true } });
      try {
        return await products([{ name: 'A', [BETA]: 'X' }]);
      } finally {
        await places().updateOne({ _id: other() }, { $set: { trash: false } });
      }
    });
    assert.deepEqual(problems(trashed), ['Prodotti:-:DISPO | Bar Beta:unknownPlace']);
    const spaced = await products([{ name: 'A', 'POSTAZIONI SALA | Bar Alfa': 'x' }]);
    assert.deepEqual(problems(spaced), ['Prodotti:-:POSTAZIONI SALA | Bar Alfa:unknownColumn']);
  });

  it('refuses a column whose point of sale name is shared by two points of sale', async () => {
    await places().updateOne({ _id: other() }, { $set: { name: 'Bar Alfa' } });
    try {
      const reply = await untouched(() => run({ products: [{ name: 'A', [ALFA]: 'X' }], categories: [{ name: 'B', [`POSTAZIONI SALA | Bar Alfa`]: '' }] }));
      assert.deepEqual(problems(reply), ['Prodotti:-:DISPO | Bar Alfa:ambiguousPlace', 'Categorie:-:POSTAZIONI SALA | Bar Alfa:ambiguousPlace']);
      assert.equal(reply.body.error.rows[0].message, 'More than one point of sale has the name of the column');
    } finally {
      await places().updateOne({ _id: other() }, { $set: { name: 'Bar Beta' } });
    }
  });

  it('refuses the columns of a point of sale outside the perimeter of a company or place administrator, and lets him use his own', async () => {
    for (const actor of [ca(), pa()]) {
      assert.deepEqual(problems(await untouched(() => products([{ name: 'A', [BETA]: 'X' }], { actor }))), ['Prodotti:-:DISPO | Bar Beta:unknownPlace']);
      assert.deepEqual(problems(await untouched(() => categories([{ name: 'A', [SALA_BETA]: 'Forno' }], { actor }))), ['Categorie:-:POSTAZIONI SALA | Bar Beta:unknownPlace']);
      const reply = await products([{ name: `Mio ${hex(actor)}`, [ALFA]: 'X' }], { actor });
      assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 1 });
    }
  });

  it('refuses a mark that is not an X in the column of a point of sale, naming the column', async () => {
    const reply = await untouched(() => run({ products: [{ name: 'A', [ALFA]: 'si' }, { name: 'B', [BETA]: '1' }], categories: [{ name: 'C', [ALFA]: 'no' }] }));
    assert.deepEqual(problems(reply), ['Categorie:2:DISPO | Bar Alfa:invalidValue', 'Prodotti:2:DISPO | Bar Alfa:invalidValue', 'Prodotti:3:DISPO | Bar Beta:invalidValue'], 'the categories come first');
  });

  it('does not let a company or place administrator make an element for every place, a new one or an existing one he does not own', async () => {
    for (const actor of [ca(), pa()]) {
      const reply = await untouched(() => products([{ name: 'Per tutti', [ALFA]: '' }], { actor }));
      assert.deepEqual(codes(reply), ['forbidden']);
      assert.deepEqual(problems(await untouched(() => products([{ name: 'Per tutti' }], { actor }))), ['Prodotti:2:-:forbidden']);
      assert.deepEqual(problems(await untouched(() => categories([{ name: 'Per tutte' }], { actor }))), ['Categorie:2:-:forbidden']);
    }
  });

  it('gives the categories their places by the X and their print stations by the names of the stations, for the dining room and the counter', async () => {
    const reply = await categories([{ name: 'Sala', [SALA_ALFA]: 'Cucina | Bar', [BANCO_ALFA]: 'Bar', [SALA_BETA]: 'Forno', [ALFA]: 'X', [BETA]: '' }]);
    assert.deepEqual(counts(reply).categories, { ...ZERO, inserted: 1 });
    const [created] = await byName('categories', 'Sala');
    assert.deepEqual(created!['printStations'], { [`__${hex(own())}`]: ['st-1', 'st-2'], [`__${hex(other())}`]: ['st-9'] });
    assert.deepEqual(created!['printStationsNoRooms'], { [`__${hex(own())}`]: ['st-2'] });
    assert.deepEqual(entriesOf(created!), [hex(own())]);
    const id = created!['_id'] as ObjectId;
    assert.deepEqual(counts(await categories([{ id: hex(id), [SALA_ALFA]: 'Cucina|Bar', [BANCO_ALFA]: 'Bar', [SALA_BETA]: 'Forno' }])).categories, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await categories([{ id: hex(id), [SALA_ALFA]: 'Bar', [BANCO_ALFA]: '', [SALA_BETA]: '' }])).categories, { ...ZERO, updated: 1 });
    const after = (await category(id))!;
    assert.deepEqual([after['printStations'][`__${hex(own())}`], after['printStationsNoRooms'][`__${hex(own())}`], after['printStations'][`__${hex(other())}`]], [['st-2'], [], []], 'an empty cell clears the stations of the place');
  });

  it('refuses a station that does not exist in the point of sale and one whose name two stations of the place have', async () => {
    await places().updateOne({ _id: own() }, { $push: { printStations: { id: 'st-3', name: 'Bar' } } as never });
    try {
      const reply = await untouched(() => categories([{ name: 'A', [SALA_ALFA]: 'Magazzino' }, { name: 'B', [BANCO_ALFA]: 'Bar' }, { name: 'C', [SALA_ALFA]: 'Cucina | Forno' }, { name: 'D', [SALA_BETA]: 'Cucina' }]));
      assert.deepEqual(problems(reply), [
        'Categorie:2:POSTAZIONI SALA | Bar Alfa:unknownStation',
        'Categorie:3:POSTAZIONI BANCO | Bar Alfa:ambiguousName',
        'Categorie:4:POSTAZIONI SALA | Bar Alfa:unknownStation',
        'Categorie:5:POSTAZIONI SALA | Bar Beta:unknownStation',
      ]);
    } finally {
      await places().updateOne({ _id: own() }, { $pull: { printStations: { id: 'st-3' } } as never });
    }
  });

  it('keeps the print stations of the places a company or place administrator does not see', async () => {
    const id = await seedCategory({ name: { it: 'Mista' }, printStations: { [`__${hex(own())}`]: ['st-1'], [`__${hex(other())}`]: ['st-9'] }, placesAvailability: [placeEntry(own())] });
    for (const actor of [ca(), pa()]) {
      const reply = await categories([{ id: hex(id), [SALA_ALFA]: 'Bar', [ALFA]: 'X' }], { actor });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
    }
    const after = (await category(id))!;
    assert.deepEqual(after['printStations'][`__${hex(other())}`], ['st-9']);
    assert.deepEqual(after['printStations'][`__${hex(own())}`], ['st-2']);
    assert.deepEqual(entriesOf(after), [hex(own())]);
  });
});

describe('catalog import: which element a row is', () => {
  it('inserts a row with no id and updates one with an id, in any case, in the sheet it belongs to', async () => {
    const id = await seed({ name: { it: 'Acqua' } });
    const variant = await seed({ name: { it: 'Extra' }, variant: { status: true, type: 'p' } });
    const reply = await run({ products: [{ id: hex(id).toUpperCase(), name: 'Acqua gassata' }, { name: 'Nuovo' }], variants: [{ id: ` ${hex(variant)} `, name: 'Extra grande' }] });
    assert.deepEqual(counts(reply), { products: { ...ZERO, inserted: 1, updated: 1 }, variants: { ...ZERO, updated: 1 }, categories: ZERO });
    assert.equal((await product(id))!['name'].it, 'Acqua gassata');
    assert.equal((await product(variant))!['name'].it, 'Extra grande');
  });

  it('refuses an id that is not an id, one that appears twice in the sheet, and one that matches nothing', async () => {
    const id = await seed({ name: { it: 'Acqua' } });
    const reply = await untouched(() =>
      products([
        { id: 'abc', name: 'A' },
        { id: hex(id).slice(1), name: 'B' },
        { id: `${hex(id)}0`, name: 'C' },
        { id: hex(id), name: 'D' },
        { id: hex(id).toUpperCase(), name: 'E' },
        { id: hex(new ObjectId()), name: 'F' },
        { id: 'z'.repeat(24), name: 'G' },
      ]),
    );
    assert.deepEqual(problems(reply), [
      'Prodotti:2:ID:invalidId',
      'Prodotti:3:ID:invalidId',
      'Prodotti:4:ID:invalidId',
      'Prodotti:6:ID:duplicateId',
      'Prodotti:7:ID:notFound',
      'Prodotti:8:ID:invalidId',
    ]);
  });

  it('refuses a product in the trash, a variant in the sheet of the products and a product in the sheet of the variants, and the kinds the workbook does not handle', async () => {
    const trashed = await seed({ name: { it: 'Cestinato' }, trash: true });
    const variant = await seed({ name: { it: 'Extra' }, variant: { status: true, type: 'p' } });
    const plain = await seed({ name: { it: 'Acqua' } });
    const tobacco = await seed({ name: { it: 'Sigarette' }, type: 'tobaccos' });
    const game = await seed({ name: { it: 'Gratta' }, type: 'games' });
    const monopoly = await seed({ name: { it: 'Monopoli' }, type: 'monopoly' });
    const reply = await untouched(() => run({ products: [{ id: hex(trashed), name: 'a' }, { id: hex(variant), name: 'b' }, { id: hex(tobacco), name: 'c' }, { id: hex(game), name: 'd' }, { id: hex(monopoly), name: 'e' }], variants: [{ id: hex(plain), name: 'f' }, { id: hex(tobacco), name: 'g' }] }));
    assert.deepEqual(problems(reply), [
      'Varianti:2:ID:wrongSheet',
      'Varianti:3:ID:wrongSheet',
      'Prodotti:2:ID:trashed',
      'Prodotti:3:ID:wrongSheet',
      'Prodotti:4:ID:notImportable',
      'Prodotti:5:ID:notImportable',
      'Prodotti:6:ID:notImportable',
    ]);
  });

  it('keeps the catalog of the others out of reach of a company or place administrator: a product he does not reach is not found, one he reaches but does not own can only change its places', async () => {
    const others = await seed({ name: { it: 'Altrui' }, placesAvailability: [placeEntry(other())] });
    const historical = await seed({ name: { it: 'Altrui storico' }, placesAvailability: [other()] });
    const mixed = await seed({ name: { it: 'Misto' }, placesAvailability: [placeEntry(own()), placeEntry(other())] });
    const shared = await seed({ name: { it: 'Per tutti' } });
    const mine = await seed({ name: { it: 'Mio' }, placesAvailability: [placeEntry(own())] });
    for (const actor of [ca(), pa()]) {
      const refused = await untouched(() => products([{ id: hex(others), name: 'x' }, { id: hex(historical), name: 'x' }, { id: hex(mixed), name: 'x' }, { id: hex(shared), name: 'x' }, { id: hex(new ObjectId()), name: 'x' }], { actor }));
      assert.deepEqual(problems(refused), ['Prodotti:2:ID:notFound', 'Prodotti:3:ID:notFound', 'Prodotti:4:NOME:forbidden', 'Prodotti:5:NOME:forbidden', 'Prodotti:6:ID:notFound']);
      assert.deepEqual(counts(await products([{ id: hex(mine), name: `Mio ${hex(actor)}` }], { actor })).products, { ...ZERO, updated: 1 });
      assert.deepEqual(counts(await products([{ id: hex(mixed), [ALFA]: 'X' }], { actor })).products, { ...ZERO, unchanged: 1 });
    }
    assert.deepEqual((await product(mixed))!['name'].it, 'Misto');
  });

  it('deletes a product by sending it to the trash, never for good, counts it and keeps what was in the other sheets', async () => {
    const id = await seed({ name: { it: 'Da cestinare' } });
    const variant = await seed({ name: { it: 'Variante' }, variant: { status: true, type: 'p' } });
    const reply = await run({ products: [{ id: hex(id), delete: 'x' }], variants: [{ id: hex(variant), delete: 'X' }] });
    assert.deepEqual(counts(reply), { products: { ...ZERO, removed: 1 }, variants: { ...ZERO, removed: 1 }, categories: ZERO });
    assert.equal(await db.products.countDocuments(), 2, 'nothing is deleted');
    assert.deepEqual([(await product(id))!['trash'], (await product(variant))!['trash']], [true, true]);
    assert.deepEqual(problems(await untouched(() => products([{ id: hex(id), delete: 'X' }]))), ['Prodotti:2:ID:trashed']);
  });

  it('refuses a deletion with no id, one that is not a mark, and ignores every other cell of a row that deletes', async () => {
    const id = await seed({ name: { it: 'Acqua' } });
    assert.deepEqual(problems(await untouched(() => products([{ name: 'Nuovo', delete: 'X' }, { id: hex(id), delete: 'forse' }]))), ['Prodotti:2:CANCELLAZIONE (X):deleteWithoutId', 'Prodotti:3:CANCELLAZIONE (X):invalidValue']);
    const reply = await products([{ id: hex(id), name: 'Cambiato', price1: 'abc', delete: 'X' }]);
    assert.deepEqual(counts(reply).products, { ...ZERO, removed: 1 });
    assert.equal((await product(id))!['name'].it, 'Acqua');
  });
});

describe('catalog import: the categories', () => {
  it('deletes a category nobody uses and counts it, and refuses one a product refers to, naming why, and one that has subcategories', async () => {
    const free = await seedCategory({ name: { it: 'Libera' } });
    const used = await seedCategory({ name: { it: 'Usata' } });
    const parent = await seedCategory({ name: { it: 'Madre' } });
    await seedCategory({ name: { it: 'Figlia' }, parentId: parent });
    await seed({ name: { it: 'Acqua' }, categories: [used] });
    const refused = await untouched(() => categories([{ id: hex(used), delete: 'X' }, { id: hex(parent), delete: 'X' }, { id: hex(free), delete: 'X' }]));
    assert.deepEqual(problems(refused).map((line) => line.split(':').slice(0, 4).join(':')), ['Categorie:2:-:conflict', 'Categorie:3:-:conflict']);
    const messages = (refused.body.error.rows as Array<{ message: string }>).map((row) => row.message);
    assert.match(messages[0]!, /products/);
    assert.match(messages[1]!, /(children|subcategor|parent)/i);
    const reply = await categories([{ id: hex(free), delete: 'X' }]);
    assert.deepEqual(counts(reply).categories, { ...ZERO, removed: 1 });
    assert.equal(await category(free), null, 'a category is deleted for good');
    assert.equal(await db.categories.countDocuments(), 3);
  });

  it('can delete a category in the file that moves its products away, because the categories are deleted last', async () => {
    const old = await seedCategory({ name: { it: 'Vecchia' } });
    const fresh = await seedCategory({ name: { it: 'Nuova' } });
    const id = await seed({ name: { it: 'Acqua' }, categories: [old] });
    const reply = await run({ categories: [{ id: hex(old), delete: 'X' }], products: [{ id: hex(id), categories: 'Nuova' }] });
    assert.deepEqual(counts(reply), { products: { ...ZERO, updated: 1 }, variants: ZERO, categories: { ...ZERO, removed: 1 } });
    assert.deepEqual(((await product(id))!['categories'] as ObjectId[]).map(hex), [hex(fresh)]);
    assert.equal(await category(old), null);
    const stays = await untouched(() => run({ categories: [{ id: hex(fresh), delete: 'X' }], products: [{ id: hex(id), categories: 'Nuova' }] }));
    assert.deepEqual(codes(stays), ['conflict'], 'a category that is still used when the deletions come is refused');
  });

  it('refuses a deletion without an id, with a category that does not exist, and the same category twice', async () => {
    const id = await seedCategory({ name: { it: 'Una' } });
    const reply = await untouched(() => categories([{ name: 'Nuova', delete: 'X' }, { id: hex(new ObjectId()), name: 'x' }, { id: hex(id), name: 'y' }, { id: hex(id), name: 'z' }, { id: 'xyz', name: 'w' }, { id: hex(new ObjectId()), delete: 'X' }]));
    assert.deepEqual(problems(reply), ['Categorie:2:CANCELLAZIONE (X):deleteWithoutId', 'Categorie:5:ID:duplicateId', 'Categorie:6:ID:invalidId', 'Categorie:3:ID:notFound', 'Categorie:7:-:notFound']);
  });

  it('creates the categories of the file before any row refers to them, in any order: a child before its parent, a parent given by name', async () => {
    const reply = await categories([
      { name: 'Birre', parent: 'Bevande', modifierCategories: 'Bevande', position: '2', color: '3', description: 'Fresche', pos: 'X' },
      { name: 'Bevande', position: '1' },
      { name: 'Alcoliche', parent: 'Birre' },
    ]);
    assert.deepEqual(counts(reply).categories, { ...ZERO, inserted: 3 });
    const [drinks] = await byName('categories', 'Bevande');
    const [beers] = await byName('categories', 'Birre');
    const [alcoholic] = await byName('categories', 'Alcoliche');
    assert.deepEqual([beers!['parentId'], alcoholic!['parentId'], drinks!['parentId']].map((value) => (value === null ? null : hex(value as ObjectId))), [hex(drinks!['_id'] as ObjectId), hex(beers!['_id'] as ObjectId), null]);
    assert.deepEqual((beers!['variantsCategories'] as ObjectId[]).map(hex), [hex(drinks!['_id'] as ObjectId)]);
    assert.deepEqual([Number(beers!['position']), beers!['backgroundColor'], beers!['description'], beers!['availability'].pos], [2, '#c69aff', { it: 'Fresche' }, true]);
    const products = await run({ categories: [{ name: 'Superiore' }], products: [{ name: 'Acqua', categories: 'Superiore | Birre' }], variants: [{ name: 'Extra', categories: 'Superiore' }] });
    assert.deepEqual(counts(products), { products: { ...ZERO, inserted: 1 }, variants: { ...ZERO, inserted: 1 }, categories: { ...ZERO, inserted: 1 } });
  });

  it('refuses a new category with no name or a name used twice in the file as a reference, and a cycle of parents', async () => {
    const reply = await untouched(() => categories([{ name: '', description: 'x' }, { name: 'Doppia' }, { name: 'Doppia' }, { name: 'Figlia', parent: 'Doppia' }]));
    assert.deepEqual(problems(reply).slice(0, 2), ['Categorie:2:NOME:required', 'Categorie:5:GENITORE:ambiguousName']);
    const a = await seedCategory({ name: { it: 'Aa' } });
    const b = await seedCategory({ name: { it: 'Bb' }, parentId: a });
    const cycle = await untouched(() => categories([{ id: hex(a), parent: 'Bb' }]));
    assert.equal(cycle.status, 422);
    assert.deepEqual(codes(cycle).length, 1);
    assert.equal((await category(b))!['parentId'] instanceof ObjectId, true);
  });

  it('counts a category row that says what is stored as unchanged, and one with a position, a description or the availability of the cash register as updated', async () => {
    const id = await seedCategory({ name: { it: 'Bevande' }, description: { it: 'Tutte' }, position: new Int32(4), availability: { pos: true, ecommerce: false }, backgroundColor: '#ff0000' });
    assert.deepEqual(counts(await categories([{ id: hex(id), name: 'Bevande', description: 'Tutte', position: '4', pos: 'X', color: '#FF0000', parent: '', modifierCategories: '' }])).categories, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await categories([{ id: hex(id), position: '', description: '', pos: '' }])).categories, { ...ZERO, updated: 1 });
    const after = (await category(id))!;
    assert.deepEqual([after['position'], after['description'], after['availability'].pos], [null, {}, false]);
  });
});

const single = async (action: () => Promise<void>) => {
  // A group with one point of sale: the other one is in the trash (the copy and the original).
  await Promise.all([placeCopies().updateOne({ _id: other() }, { $set: { trash: true } }), groupPlaces().updateOne({ _id: other() }, { $set: { trash: true } })]);
  try {
    await action();
  } finally {
    await Promise.all([placeCopies().updateOne({ _id: other() }, { $set: { trash: false } }), groupPlaces().updateOne({ _id: other() }, { $set: { trash: false } })]);
  }
};

describe('catalog import: the perimeter of the company and place administrators', () => {
  it('lets them create products and categories of their own places, and a category of their own place with the stations of it', async () => {
    for (const actor of [ca(), pa()]) {
      const reply = await run({ categories: [{ name: `Cat ${hex(actor)}`, [ALFA]: 'X', [SALA_ALFA]: 'Cucina' }], products: [{ name: `Prod ${hex(actor)}`, categories: `Cat ${hex(actor)}`, [ALFA]: 'X' }] }, { actor });
      assert.deepEqual([counts(reply).products.inserted, counts(reply).categories.inserted], [1, 1]);
      assert.deepEqual(entriesOf((await byName('products', `Prod ${hex(actor)}`))[0]!), [hex(own())]);
    }
  });

  it('does not show them the categories of the other places: a category of another place is a reference that does not exist', async () => {
    await seedCategory({ name: { it: 'Altrui' }, placesAvailability: [placeEntry(other())] });
    await seedCategory({ name: { it: 'Per tutti' } });
    for (const actor of [ca(), pa()]) {
      assert.deepEqual(problems(await untouched(() => products([{ name: 'A', categories: 'Altrui', [ALFA]: 'X' }], { actor }))), ['Prodotti:2:CATEGORIE (ID / NOME):notFoundReference']);
      assert.deepEqual(counts(await products([{ name: `Con ${hex(actor)}`, categories: 'Per tutti', [ALFA]: 'X' }], { actor })).products, { ...ZERO, inserted: 1 });
    }
  });

  it('lets them make an element for every place when the group has one point of sale only, in the file as in the routes', async () => {
    await single(async () => {
      for (const actor of [ca(), pa()]) {
        const reply = await run({ products: [{ name: `Per tutti ${hex(actor)}`, [ALFA]: '' }], categories: [{ name: `Tutte ${hex(actor)}`, [ALFA]: '' }] }, { actor });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.deepEqual(entriesOf((await byName('products', `Per tutti ${hex(actor)}`))[0]!), []);
        assert.deepEqual(entriesOf((await byName('categories', `Tutte ${hex(actor)}`))[0]!), []);
      }
      const shared = await seed({ name: { it: 'Condiviso' } });
      assert.deepEqual(counts(await products([{ id: hex(shared), name: 'Condiviso 2' }], { actor: ca() })).products, { ...ZERO, updated: 1 });
    });
    assert.deepEqual(problems(await untouched(() => products([{ name: 'Per tutti', [ALFA]: '' }], { actor: ca() }))), ['Prodotti:2:-:forbidden'], 'with two places again it is not theirs');
  });
});

describe('catalog import: an entry shared with the places of others', () => {
  it('sends only the entries of the perimeter of a company or place administrator: his own place goes and comes, the others stay stored, and nothing is refused', async () => {
    for (const actor of [ca(), pa()]) {
      const id = await seed({ name: { it: `Condiviso ${hex(actor)}` }, placesAvailability: [placeEntry(own(), { favorite: true, position: 3 }), placeEntry(other(), { position: 5 })] });
      assert.deepEqual(counts(await products([{ id: hex(id), [ALFA]: 'X' }], { actor })).products, { ...ZERO, unchanged: 1 });
      assert.deepEqual(counts(await products([{ id: hex(id), [ALFA]: '' }], { actor })).products, { ...ZERO, updated: 1 });
      assert.deepEqual(entriesOf(await product(id)), [hex(other())]);
      assert.equal(Number((await product(id))!['placesAvailability'][0].position), 5, 'what the other place has is as it was');
      assert.deepEqual(problems(await products([{ id: hex(id), [ALFA]: 'X' }], { actor })), ['Prodotti:2:ID:notFound'], 'a product that is no longer of his places is not his to see');
    }
  });

  it('does not let them change a category of the places of both at all: the category is not writable by them, whatever the cell says', async () => {
    const id = await seedCategory({ name: { it: 'Categoria condivisa' }, placesAvailability: [placeEntry(own()), placeEntry(other(), { position: 5 })] });
    for (const actor of [ca(), pa()]) {
      const reply = await untouched(() => categories([{ id: hex(id), [ALFA]: '' }], { actor }));
      assert.deepEqual(problems(reply), ['Categorie:2:-:forbidden']);
      assert.deepEqual(reply.body.error.details, [{ field: 'Categorie!2', issue: 'forbidden' }]);
    }
  });
});

describe('catalog import: all or nothing', () => {
  it('writes nothing when one row of a file of good ones is not valid, whatever the order and the sheet', async () => {
    const reply = await untouched(() =>
      run({
        categories: [{ name: 'Buona' }, { name: 'Cattiva', color: 'rosso' }],
        variants: [{ name: 'Variante buona' }],
        products: [{ name: 'Prima' }, { name: 'Seconda', pos: 'forse' }, { name: 'Terza' }],
      }),
    );
    assert.deepEqual(problems(reply), ['Categorie:3:COLORE (1-12 / HEX):invalidValue', 'Prodotti:3:DISPONIBILE CASSA (X):invalidValue']);
    assert.deepEqual([await db.products.countDocuments(), await db.categories.countDocuments()], [0, 0]);
    assert.equal(reply.body.error.message, 'The workbook has problems: nothing was imported');
    assert.deepEqual([reply.body.error.errorCount, reply.body.error.moreErrors], [2, false]);
  });

  it('lists every problem with its sheet, row, column and code, and a fixed message that holds nothing of the file', async () => {
    const reply = await untouched(() => products([{ name: 'SECRET-NAME', categories: 'SECRET-CATEGORY', pos: 'SECRET-FLAG', list1: 'SECRET-LIST', price1: 'SECRET-PRICE', tax1: 'SECRET-TAX', position: 'SECRET-POSITION' }]));
    const messages: Record<string, string> = { notFoundReference: 'The reference matches nothing (neither an id nor a name)', invalidValue: 'The value is not valid' };
    assert.deepEqual(
      reply.body.error.rows.map((row: { column: string; code: string; message: string }) => [row.column, row.code, row.message === messages[row.code]]).sort(),
      [
        ['ALIQUOTA 1 (ID / VALORE)', 'notFoundReference', true],
        ['CATEGORIE (ID / NOME)', 'notFoundReference', true],
        ['DISPONIBILE CASSA (X)', 'invalidValue', true],
        ['LISTINO 1 (ID / NOME )', 'notFoundReference', true],
        ['POSIZIONE', 'invalidValue', true],
        ['PREZZO 1', 'invalidValue', true],
      ],
    );
    assert.deepEqual(reply.body.error.details.map((detail: { field: string }) => detail.field).sort(), ['Prodotti!2!ALIQUOTA 1 (ID / VALORE)', 'Prodotti!2!CATEGORIE (ID / NOME)', 'Prodotti!2!DISPONIBILE CASSA (X)', 'Prodotti!2!LISTINO 1 (ID / NOME )', 'Prodotti!2!POSIZIONE', 'Prodotti!2!PREZZO 1']);
    assert.deepEqual(reply.body.error.details.map((detail: { issue: string }) => detail.issue).sort(), reply.body.error.rows.map((row: { code: string }) => row.code).sort());
    assert.doesNotMatch(JSON.stringify(reply.body), /SECRET/);
  });

  it('counts up to a thousand problems, lists the first two hundred and says there are more', async () => {
    const exact = await untouched(() => categories(Array.from({ length: MAX_REPORTED_ERRORS }, (_, index) => ({ name: `C${String(index)}`, color: 'x' }))));
    assert.deepEqual([exact.body.error.rows.length, exact.body.error.errorCount, exact.body.error.moreErrors], [200, 200, false]);
    const more = await untouched(() => categories(Array.from({ length: 250 }, (_, index) => ({ name: `C${String(index)}`, color: 'x' }))));
    assert.deepEqual([more.body.error.rows.length, more.body.error.errorCount, more.body.error.moreErrors], [200, 250, true]);
    assert.equal(more.body.error.rows[199].row, 201);
    const rows = Array.from({ length: 800 }, (_, index) => ({ name: `C${String(index)}`, color: 'x' }));
    const huge = await untouched(() =>
      run({
        categories: [...rows, { id: hex(new ObjectId()), delete: 'X' }],
        variants: Array.from({ length: 300 }, (_, index) => ({ name: `V${String(index)}`, pos: 'q' })),
        products: [{ name: 'P', pos: 'q', scaleType: 'q' }],
      }),
    );
    assert.deepEqual([huge.body.error.rows.length, huge.body.error.errorCount, huge.body.error.moreErrors], [200, MAX_COLLECTED_ERRORS, true], 'the reading stops at a thousand');
    assert.ok((huge.body.error.rows as Array<{ sheet: string }>).every((row) => row.sheet === 'Categorie'));
    assert.deepEqual(huge.body.error.details.slice(0, 2), [{ field: 'Categorie!2!COLORE (1-12 / HEX)', issue: 'invalidValue' }, { field: 'Categorie!3!COLORE (1-12 / HEX)', issue: 'invalidValue' }], 'the details of the envelope say where, and why');
    assert.equal(huge.body.error.details.length, 200);
  });

  it('refuses a column that is not of the sheet, or that appears twice, naming it, and does not read the sheet', async () => {
    const bytes = await rawBook({ Prodotti: { columns: ['NOME', 'Nome', 'Colore', "NOME\u0007‮'=x", '$gt', '__proto__'], rows: [['A', 'B', 'C', 'D', 'E', 'F']] }, Categorie: { columns: ['NOME', 'COLORE (1-12 / HEX)'], rows: [['Valida', 'rosso']] } });
    const reply = await untouched(() => runBytes(bytes));
    assert.deepEqual(problems(reply), ['Prodotti:-:Nome:duplicateColumn', 'Prodotti:-:Colore:unknownColumn', "Prodotti:-:NOME '=x:unknownColumn", 'Prodotti:-:$gt:unknownColumn', 'Prodotti:-:__proto__:unknownColumn', 'Categorie:2:COLORE (1-12 / HEX):invalidValue']);
  });

  it('recognizes the columns by what they say, in any order, in any case and with extra spaces, and ignores a column with no header', async () => {
    const bytes = await rawBook({ Prodotti: { columns: ['  nome ', '', 'disponibile  cassa (x)', 'LISTINO 1 (ID / NOME)', 'prezzo 1', 'Aliquota 1 (id / valore)', 'ID'], rows: [['Libero', 'ignorata', 'X', 'Listino 1', '2', '22', '']] } });
    assert.deepEqual(counts(await runBytes(bytes)).products, { ...ZERO, inserted: 1 });
    const [created] = await byName('products', 'Libero');
    assert.deepEqual([created!['availability'].pos, Number(created!['prices'][0].taxed)], [true, 2]);
  });

  it('answers a dry run with the counts of the real one and writes nothing; a dry run of a file with problems is refused like the real one', async () => {
    const id = await seed({ name: { it: 'Acqua' } });
    const doomed = await seed({ name: { it: 'Cestino' } });
    const rows = { products: [{ id: hex(id), name: 'Acqua 2' }, { name: 'Nuovo' }, { id: hex(doomed), name: 'x', delete: 'X' }], categories: [{ name: 'Nuova' }] };
    const dry = await untouched(() => run(rows, { query: '?dryRun=true' }));
    assert.deepEqual(counts(dry, true), { products: { ...ZERO, inserted: 1, updated: 1, removed: 1 }, variants: ZERO, categories: { ...ZERO, inserted: 1 } });
    assert.deepEqual(counts(await run(rows, { query: '?dryRun=false' })), counts(dry, true) ? { products: { ...ZERO, inserted: 1, updated: 1, removed: 1 }, variants: ZERO, categories: { ...ZERO, inserted: 1 } } : null);
    const refused = await untouched(() => run({ products: [{ name: 'Cattivo', pos: 'x', favorite: 'q' }] }, { query: '?dryRun=true' }));
    assert.deepEqual(problems(refused), ['Prodotti:2:PREFERITO (X):invalidValue']);
  });

  it('rolls back what was written before a row the catalog refuses: the categories and the products of the file are not left', async () => {
    const a = await seedCategory({ name: { it: 'Aa' } });
    await seedCategory({ name: { it: 'Bb' }, parentId: a });
    const reply = await untouched(() => run({ categories: [{ name: 'Nuova', parent: '' }, { id: hex(a), name: 'Aa', parent: 'Bb' }], products: [{ name: 'Acqua', categories: 'Nuova' }] }));
    assert.deepEqual(codes(reply), ['invalid']);
    assert.equal(reply.body.error.rows.length, 1);
    assert.deepEqual([await db.products.countDocuments(), await db.categories.countDocuments()], [0, 2]);
  });

  it('rolls back everything and answers 500, with nothing of the failure, when the database fails after earlier writes', async () => {
    const reply = await untouched(async () => {
      fault = { collection: 'products', operation: 'insertOne', after: 1, error: new Error('SECRET database detail') };
      return run({ categories: [{ name: 'Nuova' }], products: [{ name: 'Uno' }, { name: 'Due' }, { name: 'Tre' }] }, { path: base().replace('catalog-import', 'import-faulty') });
    });
    assert.equal(reply.status, 500);
    assert.deepEqual(reply.body, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    assert.equal(fault, null === fault ? null : fault, 'the fault was used');
    assert.equal((fault as unknown as { after: number }).after, 0);
    assert.deepEqual([await db.products.countDocuments(), await db.categories.countDocuments()], [0, 0]);
    assert.deepEqual(audit.entries.map((entry) => [entry.action, entry.outcome, entry.metadata]), [['catalog.imported', 'failure', { dryRun: false, reason: 'error' }]]);
    assert.doesNotMatch(JSON.stringify(audit.entries), /SECRET/);
  });

  it('is not a problem of a row when a refusal that is not one of the catalog (the database is busy) interrupts the file: it is the answer to the request', async () => {
    const { AppError } = await import('../../src/shared/http/errors.ts');
    fault = { collection: 'products', operation: 'insertOne', after: 0, error: new AppError('SERVICE_UNAVAILABLE') };
    const reply = await untouched(() => run({ products: [{ name: 'Uno' }] }, { path: base().replace('catalog-import', 'import-faulty') }));
    assert.deepEqual([reply.status, reply.body.error.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.equal(await db.products.countDocuments(), 0);
  });

  it('refuses with 413 an import that takes longer than the deadline and writes nothing', async () => {
    const reply = await untouched(() => run({ categories: [{ name: 'A' }, { name: 'B' }] }, { path: base().replace('catalog-import', 'import-slow') }));
    assert.equal(reply.status, 413);
    assert.deepEqual([reply.body.error.code, reply.body.error.message], ['PAYLOAD_TOO_LARGE', 'The import takes too long: split the file']);
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'tooSlow' }]]);
  });

  it('allows a sheet 1000 rows and the workbook 1500, and the deadline of an import is 15 seconds', async () => {
    const { MAX_IMPORT_MS } = await import('../../src/modules/catalog-xlsx/catalog-xlsx.service.ts');
    assert.equal(MAX_IMPORT_MS, 15_000);
    const rows = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({ name: `${prefix}${String(index)}` }));
    for (const sheets of [{ products: rows(1001, 'P') }, { products: rows(800, 'P'), variants: rows(701, 'V') }]) {
      const reply = await untouched(() => run(sheets, { query: '?dryRun=true' }));
      assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'tooMany' }]]);
    }
    assert.deepEqual(counts(await run({ products: rows(1000, 'P') }, { query: '?dryRun=true' }), true).products, { ...ZERO, inserted: 1000 });
  });

  it('refuses a file with more rows than the limit, in a sheet or in all of them', async () => {
    const path = base().replace('catalog-import', 'import-rows');
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `R${String(index)}` }));
    assert.equal((await run({ products: rows(2) }, { path })).status, 200);
    for (const sheets of [{ products: rows(3) }, { products: rows(2), categories: rows(2) }]) {
      const reply = await untouched(() => run(sheets, { path }));
      assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'tooMany' }]]);
    }
    assert.equal(await db.products.countDocuments(), 2);
  });
});

/** `POST` of the parts given, as `actor`; the headers replace the default `Idempotency-Key`. */
async function rawUpload(parts: Array<{ name: string; bytes: Buffer | string; filename?: string }>, options: { actor?: ObjectId; headers?: Record<string, string>; path?: string; query?: string; keepLimit?: boolean; contentType?: string; token?: string | null } = {}): Promise<Reply> {
  if (options.keepLimit !== true) {
    limiter.reset();
  }
  const form = new FormData();
  for (const part of parts) {
    if (part.filename === undefined) {
      form.append(part.name, String(part.bytes));
    } else {
      form.append(part.name, new Blob([new Uint8Array(Buffer.from(part.bytes))]), part.filename);
    }
  }
  const token = options.token === undefined ? await world.as.tokenOf(options.actor ?? sa()) : options.token;
  const response = await fetch(`${world.office.app.baseUrl}/v1${options.path ?? base()}${options.query ?? ''}`, {
    method: 'POST',
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(options.headers ?? { 'idempotency-key': randomUUID() }) },
    body: form,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
}
const good = () => catalogWorkbook({ categories: [{ name: 'Valida' }] });
const detailsOf = (reply: Reply) => [reply.status, reply.body.error.code, reply.body.error.details] as const;

describe('catalog import: the request', () => {
  it('refuses a request that is not a clean upload of one file, before anything is read or written', async () => {
    const file = await good();
    const key = (): Record<string, string> => ({ 'idempotency-key': randomUUID() });
    assert.deepEqual(detailsOf(await rawUpload([{ name: 'file', bytes: file, filename: 'a.xlsx' }], { headers: {} })), [422, 'VALIDATION_ERROR', [{ field: 'Idempotency-Key', issue: 'required' }]]);
    assert.deepEqual(detailsOf(await rawUpload([{ name: 'file', bytes: file, filename: 'a.xlsx' }], { headers: { 'idempotency-key': 'abc' } })), [422, 'VALIDATION_ERROR', [{ field: 'Idempotency-Key', issue: 'format' }]]);
    assert.deepEqual(detailsOf(await rawUpload([], { headers: key() })), [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'required' }]]);
    assert.deepEqual(detailsOf(await rawUpload([{ name: 'other', bytes: file, filename: 'a.xlsx' }], { headers: key() })), [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'unknown' }]]);
    assert.equal((await rawUpload([{ name: 'file', bytes: file, filename: 'a.xlsx' }, { name: 'file', bytes: file, filename: 'b.xlsx' }], { headers: key() })).status, 422);
    assert.equal((await rawUpload([{ name: 'file', bytes: file, filename: 'a.xlsx' }, { name: 'note', bytes: 'x' }], { headers: key() })).status, 422);
    const json = await world.office.call('POST', base(), await world.as.tokenOf(sa()), {}, key());
    assert.equal(json.status, 415);
    for (const bytes of [Buffer.from('%PDF-1.7 not a workbook'), Buffer.from('PK'), Buffer.alloc(0)]) {
      assert.equal((await rawUpload([{ name: 'file', bytes, filename: 'a.xlsx' }], { headers: key() })).status, 415);
    }
    assert.equal((await rawUpload([{ name: 'file', bytes: Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(10 * 1024 * 1024)]), filename: 'a.xlsx' }], { headers: key() })).status, 413);
    const broken = await fetch(`${world.office.app.baseUrl}/v1${base()}`, { method: 'POST', headers: { authorization: `Bearer ${await world.as.tokenOf(sa())}`, 'content-type': 'multipart/form-data; boundary=xyz', ...key() }, body: 'not a multipart body' });
    assert.equal(broken.status, 400);
    assert.equal(await db.categories.countDocuments(), 0);
    assert.deepEqual(imported(0), []);
  });

  it('refuses a query that is not dryRun=true or dryRun=false', async () => {
    for (const query of ['?dryRun=yes', '?dryRun=', '?dryRun=true&dryRun=false', '?x=1', '?dryRun[$ne]=1']) {
      const reply = await rawUpload([{ name: 'file', bytes: await good(), filename: 'a.xlsx' }], { query });
      assert.equal(reply.status, 422, query);
    }
    assert.equal(await db.categories.countDocuments(), 0);
    assert.equal(counts(await rawUpload([{ name: 'file', bytes: await good(), filename: 'a.xlsx' }], { query: '?dryRun=true' }), true).categories.inserted, 1);
  });

  it('refuses a workbook that has none of the three sheets, or has nothing under the headers (the model itself), and takes the sheets in any order and the ones that are missing as absent', async () => {
    const none = await rawUpload([{ name: 'file', bytes: workbookOf([['Nome'], ['x']]), filename: 'a.xlsx' }]);
    assert.deepEqual(detailsOf(none), [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'incorrect' }]]);
    const model = await downloadWorkbook(world, `${exportBase()}/template`, sa());
    assert.deepEqual(detailsOf(await runBytes(model.bytes)), [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'incorrect' }]]);
    const reordered = await rawBook({ Categorie: { columns: ['NOME'], rows: [['Ultima']] }, Foglio: { columns: ['x'], rows: [['y']] }, Prodotti: { columns: ['NOME'], rows: [['Prima']] }, Varianti: { columns: ['NOME'], rows: [] } });
    assert.deepEqual(counts(await runBytes(reordered)), { products: { ...ZERO, inserted: 1 }, variants: ZERO, categories: { ...ZERO, inserted: 1 } });
  });

  it('replays the answer for the same key and the same file, and refuses the same key with another file or another mode', async () => {
    const key = randomUUID();
    const file = await catalogWorkbook({ products: [{ name: 'Una' }] });
    const first = await runBytes(file, { key });
    const mark = world.office.activity.entries.length;
    const replay = await runBytes(file, { key });
    assert.deepEqual([replay.status, replay.body], [200, first.body]);
    assert.equal(await db.products.countDocuments(), 1, 'it did not write twice');
    assert.deepEqual(imported(mark), [], 'a replay is not recorded again');
    const other = await runBytes(await catalogWorkbook({ products: [{ name: 'Due' }] }), { key });
    assert.deepEqual(detailsOf(other), [409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]]);
    const dryKey = randomUUID();
    assert.equal((await runBytes(file, { key: dryKey, query: '?dryRun=true' })).status, 200);
    assert.deepEqual(detailsOf(await runBytes(file, { key: dryKey })), [409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]]);
    assert.deepEqual(detailsOf(await runBytes(file, { key: dryKey, query: '?dryRun=false' })), [409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]]);
    assert.equal((await runBytes(file, { key: dryKey, query: '?dryRun=true' })).status, 200, 'the dry run with the same key is a replay');
    assert.equal(await db.products.countDocuments(), 1);
  });

  it('lets a refused file be sent again with the same key once it is fixed', async () => {
    const key = randomUUID();
    assert.equal((await products([{ name: 'A', pos: 'q' }], { key })).status, 422);
    assert.equal((await products([{ name: 'A' }], { key })).status, 200);
  });

  it('is for who may update the products of the group: 401 without a token or with a bad one, 403 without the permission, 404 for another group', async () => {
    const file = await good();
    const part = [{ name: 'file', bytes: file, filename: 'a.xlsx' }];
    assert.equal((await rawUpload(part, { token: null })).status, 401);
    assert.equal((await rawUpload(part, { token: 'not-a-token' })).status, 401);
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: true, w: false } } }) });
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: false, w: false } } }) });
    for (const actor of [reader.id, blind.id]) {
      const reply = await rawUpload(part, { actor });
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN']);
    }
    assert.deepEqual([(await rawUpload(part, { actor: world.group(1).sa })).status, (await rawUpload(part, { actor: world.office.cluster.dealerB })).status], [404, 404]);
    assert.equal((await rawUpload(part, { path: base().replace(hex(gid()), 'not-an-id') })).status, 404);
    const placed = [{ name: 'file', bytes: await catalogWorkbook({ categories: [{ name: 'Valida', [ALFA]: 'X' }] }), filename: 'a.xlsx' }];
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA, ca(), pa()]) {
      assert.equal((await rawUpload(placed, { actor, query: '?dryRun=true' })).status, 200, hex(actor));
    }
    assert.equal(await db.categories.countDocuments(), 0);
    assert.deepEqual(imported(0).map((entry) => entry.outcome), ['success', 'success', 'success', 'success']);
  });

  it('is not open to the key of a point of sale', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await good())]), 'a.xlsx');
    const response = await fetch(`${world.office.app.baseUrl}/v1${base()}`, { method: 'POST', headers: { authorization: `Bearer ${store.key}`, 'idempotency-key': randomUUID() }, body: form });
    assert.equal(response.status, 403);
    assert.equal(await db.categories.countDocuments(), 0);
    assert.deepEqual(imported(0), []);
  });

  it('limits the real imports to six an hour for the user and the verifications (dryRun) to twenty, each in its own bucket', async () => {
    const file = async (name: string) => [{ name: 'file', bytes: await catalogWorkbook({ categories: [{ name }] }), filename: 'a.xlsx' }];
    limiter.reset();
    const mark = limiter.calls.length;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await rawUpload(await file(`Reale ${String(attempt)}`), { keepLimit: true, query: '?dryRun=false' })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429], 'six real imports and then 429');
    const refused = await rawUpload(await file('Settima'), { keepLimit: true });
    assert.deepEqual([refused.status, refused.body.error.code], [429, 'RATE_LIMITED']);
    const dry: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      dry.push((await rawUpload(await file('Prova'), { keepLimit: true, query: '?dryRun=true' })).status);
    }
    assert.deepEqual(dry, [...Array.from({ length: 20 }, () => 200), 429], 'the verifications are not held back by the imports, and are counted apart');
    const bucket = (name: string) => limiter.calls.slice(mark).filter((entry) => entry.bucket === name);
    assert.deepEqual([bucket('catalog-import:user').length, bucket('catalog-import:user')[0]!.limit, bucket('catalog-import:user')[0]!.key], [8, 6, hex(sa())]);
    assert.deepEqual([bucket('catalog-import-dry-run:user').length, bucket('catalog-import-dry-run:user')[0]!.limit], [21, 20]);
    assert.equal((await rawUpload([{ name: 'file', bytes: await catalogWorkbook({ categories: [{ name: 'Valida', [ALFA]: 'X' }] }), filename: 'a.xlsx' }], { actor: ca(), keepLimit: true })).status, 200, 'the limit is per user');
  });

  it('does not run two imports of a group at the same time (the lock of the service), records the refusal, and frees the group when the first one ends, however it ends', async () => {
    const path = base().replace('catalog-import', 'import-held');
    const file = async (name: string, extra: Record<string, string> = {}) => [{ name: 'file', bytes: await catalogWorkbook({ categories: [{ name, ...extra }] }), filename: 'a.xlsx' }];
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    hold = { started, released: new Promise<void>((resolve) => (release = resolve)) };
    const first = rawUpload(await file('Prima'), { path });
    await running;
    const second = await rawUpload(await file('Seconda'), { path });
    assert.deepEqual([second.status, second.body.error.code, second.body.error.message], [409, 'CONFLICT', 'An import of this group is already running']);
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'busy' }]]);
    const otherGroup = await rawUpload(await file('Altra'), { path: path.replace(hex(gid()), hex(world.group(1).groupId)), actor: world.group(1).sa });
    assert.equal(otherGroup.status, 200, 'another group is not held');
    release();
    assert.equal((await first).status, 200);
    assert.deepEqual((await db.categories.find({}).toArray()).map((document) => document['name'].it), ['Prima']);
    assert.equal((await rawUpload(await file('Terza'), { path })).status, 200);
    assert.equal((await rawUpload(await file('Rifiutata', { color: 'x' }), { path })).status, 422);
    assert.equal((await rawUpload(await file('Quarta'), { path })).status, 200, 'a refused import frees the group too');
    assert.equal((await rawUpload(await file('Quinta'), { path: path.replace('import-held', 'import-faulty') })).status, 200);
  });

  it('holds the upload of a group at a time, and a slow import of a group does not hold the others up', async () => {
    const path = base().replace('catalog-import', 'import-pergroup');
    const file = async (name: string) => [{ name: 'file', bytes: await catalogWorkbook({ categories: [{ name }] }), filename: 'a.xlsx' }];
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    hold = { started, released: new Promise<void>((resolve) => (release = resolve)) };
    const first = rawUpload(await file('Prima'), { path });
    await running;
    const queued = rawUpload(await file('In coda'), { path, headers: { 'idempotency-key': randomUUID() }, keepLimit: true });
    const otherGroup = await rawUpload(await file('Altro gruppo'), { path: path.replace(hex(gid()), hex(world.group(1).groupId)), actor: world.group(1).sa, keepLimit: true });
    assert.equal(otherGroup.status, 200, 'the import of another group runs while this one is held');
    release();
    assert.deepEqual([(await first).status, (await queued).status], [200, 200], 'the second import of the group waited for its turn and was not refused');
    assert.deepEqual((await db.categories.find({}).toArray()).map((document) => document['name'].it).sort(), ['In coda', 'Prima']);
  });
});

describe('catalog import: the gate of the process', () => {
  it('holds at most four imports at once over all the groups and eight waiting, and refuses the next with 503 without keeping the slot of its group', async () => {
    const { default: express } = await import('express');
    const parked: Array<() => void> = [];
    const routes = createCatalogXlsxRoutes({ template: () => undefined, export: () => undefined, import: () => undefined }, {} as never);
    const upload = routes.find((route) => route.method === 'POST')!.multipart!;
    const app = express();
    app.post(
      '/up',
      (req, res, next) => {
        res.locals['groupAccess'] = { groupId: new ObjectId(req.get('x-group')!) } as never;
        next();
      },
      upload,
      (_req, res) => void parked.push(() => res.status(204).end()),
    );
    app.use((error: { status?: number; code?: string }, _req: unknown, res: { status(code: number): { json(body: unknown): void } }, _next: unknown) => res.status(error.status ?? 500).json({ code: error.code }));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const bytes = await good();
    const send = (group: ObjectId) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)]), 'a.xlsx');
      return fetch(`http://127.0.0.1:${String(port)}/up`, { method: 'POST', headers: { 'x-group': hex(group), 'idempotency-key': randomUUID() }, body: form });
    };
    try {
      let finished = 0;
      const held = Array.from({ length: 12 }, () => send(new ObjectId()).then((response) => (finished += 1, response)));
      for (let attempt = 0; attempt < 500 && parked.length < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(parked.length, 4, 'four imports run, the others wait for the gate of the process');
      const refused = await send(new ObjectId());
      assert.equal(refused.status, 503, 'four running and eight waiting at the gate of the process');
      for (let attempt = 0; attempt < 500 && finished < 12; attempt += 1) {
        parked.splice(0).forEach((finish) => finish());
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual((await Promise.all(held)).map((response) => response.status), Array(12).fill(204), 'the ones that waited ran in their turn');
    } finally {
      parked.splice(0).forEach((finish) => finish());
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
});

describe('catalog import: documents of the legacy that miss what a row compares with', () => {
  it('reads a missing text as an empty one, and a barcode that is not a list or has odd elements as a list with what is usable', async () => {
    const bare = await seed({ name: { it: 'Nudo' }, shortName: {}, description: undefined, barcode: undefined });
    assert.deepEqual(counts(await products([{ id: hex(bare), shortName: '', description: '', barcode: '' }])).products, { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await products([{ id: hex(bare), shortName: 'Breve', description: 'Lunga', barcode: '12' }])).products, { ...ZERO, updated: 1 });
    const stored = (await product(bare))!;
    assert.deepEqual([stored['shortName'], stored['description'], (stored['barcode'] as Document[]).map((entry) => entry['value'])], [{ it: 'Breve' }, { it: 'Lunga' }, ['12']]);
    const odd = await seed({ name: { it: 'Strano' }, barcode: ['x', null, { value: 3 }, { value: '5', qtLoad: 'x', qtSale: null }, { value: '6', qtLoad: new Double(2), qtSale: new Double(3) }] });
    assert.deepEqual(counts(await products([{ id: hex(odd), barcode: '7' }])).products, { ...ZERO, updated: 1 });
    assert.deepEqual(((await product(odd))!['barcode'] as Document[]).map((entry) => [entry['value'], entry['qtLoad'] === null ? null : Number(entry['qtLoad']), entry['qtSale'] === null ? null : Number(entry['qtSale'])]), [['7', null, null], ['6', 2, 3]]);
  });

  it('keeps the quantity of loading of the other barcodes of a group that does not have the warehouse', async () => {
    const id = await seed({ name: { it: 'Merce' }, barcode: [{ value: '1', qtLoad: new Double(2), qtSale: new Double(1) }, { value: '2', qtLoad: new Double(4), qtSale: null }] });
    await groups().updateOne({ _id: gid() }, { $set: { 'settings.warehouse': false } });
    try {
      assert.deepEqual(counts(await products([{ id: hex(id), barcode: '9' }])).products, { ...ZERO, updated: 1 });
      assert.deepEqual(((await product(id))!['barcode'] as Document[]).map((entry) => [entry['value'], entry['qtLoad'] === null ? null : Number(entry['qtLoad']), entry['qtSale'] === null ? null : Number(entry['qtSale'])]), [['9', null, null], ['2', 4, null]]);
    } finally {
      await groups().updateOne({ _id: gid() }, { $set: { 'settings.warehouse': true } });
    }
  });

  it('needs a name for a new element even when the sheet has no column of the name, and gives a category whose color is not a text the new one', async () => {
    assert.deepEqual(problems(await untouched(() => products([{ code: 'x' }]))), ['Prodotti:2:NOME:required']);
    assert.deepEqual(problems(await untouched(() => categories([{ description: 'x' }]))), ['Categorie:2:NOME:required']);
    const id = await seedCategory({ name: { it: 'Senza colore' }, backgroundColor: null });
    assert.deepEqual(counts(await categories([{ id: hex(id), color: '2' }])).categories, { ...ZERO, updated: 1 });
    assert.equal((await category(id))!['backgroundColor'], '#ffbf77');
  });

  it('counts the places of a category as a change, and each part of a category that is written', async () => {
    const id = await seedCategory({ name: { it: 'Cambia' }, placesAvailability: [placeEntry(own())] });
    assert.deepEqual(counts(await categories([{ id: hex(id), [ALFA]: 'X', [BETA]: 'X' }])).categories, { ...ZERO, updated: 1 });
    assert.deepEqual(entriesOf(await category(id)), [hex(own()), hex(other())]);
    assert.deepEqual(counts(await categories([{ id: hex(id), [ALFA]: 'X', [BETA]: '' }])).categories, { ...ZERO, updated: 1 });
    assert.deepEqual(entriesOf(await category(id)), [hex(own())]);
    const child = await seedCategory({ name: { it: 'Figlia' } });
    assert.deepEqual(counts(await categories([{ id: hex(child), parent: 'Cambia' }])).categories, { ...ZERO, updated: 1 });
    assert.deepEqual(counts(await categories([{ id: hex(child), modifierCategories: 'Cambia' }])).categories, { ...ZERO, updated: 1 });
  });
});

describe('catalog import: the service called without a request', () => {
  const principal = () => principalOf('SA', { groupId: gid(), userId: sa() });
  const client = { requestId: 'req-1', ip: null, userAgent: null } as const;

  it('records the import and the export without an address when the request has none', async () => {
    const access = (await accessFor(principal(), gid()))!;
    const service = serviceWith(undefined);
    const outcome = await service.import(principal(), access, await catalogWorkbook({ categories: [{ name: 'Locale' }] }), false, client);
    assert.deepEqual(outcome.sheets.categories, { ...ZERO, inserted: 1 });
    const file = await service.export(principal(), access, 'ids', client);
    const chunks: Buffer[] = [];
    for await (const chunk of file.chunks) {
      chunks.push(chunk);
    }
    assert.ok(Buffer.concat(chunks).length > 0);
    assert.deepEqual(audit.entries.map((entry) => [entry.action, entry.outcome, 'ip' in entry]), [['productCategory.created', 'success', false], ['catalog.imported', 'success', false], ['catalog.exported', 'success', false]]);
    await assert.rejects(service.import(principal(), access, Buffer.from('not a zip'), false, client));
    assert.deepEqual([audit.entries.at(-1)!.outcome, audit.entries.at(-1)!.metadata], ['failure', { dryRun: false, reason: 'file' }]);
  });
});

describe('catalog import: an engine whose services change nothing', () => {
  it('counts as unchanged what the services answer with the version they were given, and as updated the rest', async () => {
    const principal = principalOf('SA', { groupId: gid(), userId: sa() });
    const access = (await accessFor(principal, gid()))!;
    const product = { _id: new ObjectId(), name: { it: 'Acqua' } };
    const category = { _id: new ObjectId(), name: { it: 'Bevande' } };
    let answer = 'same';
    const graph: ImportGraph = {
      products: { create: () => Promise.reject(new Error('unused')), trash: () => Promise.reject(new Error('unused')), update: () => Promise.resolve({ version: answer }) as never },
      categories: { create: () => Promise.reject(new Error('unused')), remove: () => Promise.reject(new Error('unused')), update: () => Promise.resolve({ version: answer }) as never },
      findProduct: () => Promise.resolve(product),
      findCategory: () => Promise.resolve(category),
      productVersion: () => 'same',
      categoryVersion: () => 'same',
      useCategoryId: () => undefined,
      loadRefs: () => Promise.resolve({ places: [], priceLists: [], taxes: [], categories: [{ id: hex(category._id), name: 'Bevande' }], currency: 'EUR' }),
    };
    const workbook = parseWorkbook(await catalogWorkbook({ products: [{ id: hex(product._id), name: 'Altro' }], categories: [{ id: hex(category._id), name: 'Altra' }] }));
    const run = () => runImport({ graph, principal, access, client: { requestId: 'r', ip: null, userAgent: null }, workbook, now: Date.now, deadline: Date.now() + 60_000 });
    assert.deepEqual([(await run()).sheets.products, (await run()).sheets.categories], [{ ...ZERO, unchanged: 1 }, { ...ZERO, unchanged: 1 }]);
    answer = 'other';
    assert.deepEqual([(await run()).sheets.products, (await run()).sheets.categories], [{ ...ZERO, updated: 1 }, { ...ZERO, updated: 1 }]);
  });
});

/** An archive with one worksheet named `Prodotti` whose XML is given, and whatever else a test adds. */
function archiveOf(sheetXml: string, extra: TestZipFile[] = [], sharedXml?: string, declared?: TestZipFile['declared']): Buffer {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zipOf([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook xmlns="${main}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Prodotti" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml, ...(declared === undefined ? {} : { declared }) },
    ...(sharedXml === undefined ? [] : [{ name: 'xl/sharedStrings.xml', data: sharedXml }]),
    ...extra,
  ]);
}
/** The XML of a worksheet from cells already written (`<c>` elements), one array per row. */
const sheetXmlOf = (rows: string[][]): string =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((cells, index) => `<row r="${String(index + 1)}">${cells.join('')}</row>`).join('')}</sheetData></worksheet>`;
const text = (reference: string, value: string) => `<c r="${reference}" t="inlineStr"><is><t>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;

const incorrectFile = [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'incorrect' }]] as const;

describe('catalog import: hostile files', () => {
  const incorrect = incorrectFile;
  const SECRET = 'SECRET-CONTENT-OF-THE-FILE';

  it('refuses a file that is not a workbook of the reader, with a fixed message that holds nothing of the file, and writes nothing', async () => {
    const sheet = sheetXmlOf([[text('A1', 'NOME')], [text('A2', 'Acqua')]]);
    const cases: Array<[string, Buffer, string]> = [
      ['a DOCTYPE with an entity', archiveOf(`<!DOCTYPE x [<!ENTITY a "${SECRET}">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&a;</t></is></c></row></sheetData></worksheet>`), 'The file contains content that is not accepted'],
      ['a DOCTYPE in the shared strings', archiveOf(sheet, [], `<!DOCTYPE sst [<!ENTITY a "${SECRET}">]><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`), 'The file contains content that is not accepted'],
      ['a name that climbs out of the archive', archiveOf(sheet, [{ name: `../../${SECRET}.xml`, data: 'x' }]), 'The file contains content that is not accepted'],
      ['an absolute name', archiveOf(sheet, [{ name: `/${SECRET}.xml`, data: 'x' }]), 'The file contains content that is not accepted'],
      ['a ZIP bomb', archiveOf(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${' '.repeat(41 * 1024 * 1024)}</worksheet>`), 'The file exceeds the limits of an XLSX workbook'],
      ['a sheet that says it is smaller than it is', archiveOf(sheet, [], undefined, { size: 10 }), 'The file exceeds the limits of an XLSX workbook'],
      ['an encrypted entry', archiveOf(sheet, [{ name: 'xl/x.bin', data: SECRET, declared: { flags: 1 } }]), 'The file uses a feature of the XLSX format that is not supported'],
      ['a damaged sheet', archiveOf(`<worksheet><${SECRET}>`), 'The file is damaged or is not a valid XLSX workbook'],
      ['a ZIP that is not a workbook', zipOf([{ name: 'readme.txt', data: SECRET }]), 'The file does not contain a worksheet'],
    ];
    for (const [label, bytes, message] of cases) {
      const reply = await runBytes(bytes);
      assert.deepEqual([...detailsOf(reply), reply.body.error.message], [...incorrect, message], label);
      assert.doesNotMatch(JSON.stringify(reply.body), new RegExp(SECRET), label);
    }
    assert.equal(await db.products.countDocuments(), 0);
    assert.deepEqual(imported(0).map((entry) => [entry.outcome, entry.metadata]), Array(cases.length).fill(['failure', { dryRun: false, reason: 'file' }]));
    assert.doesNotMatch(JSON.stringify(imported(0)), new RegExp(SECRET));
  });

  it('keeps a text that starts like a formula as data, and gives back a neutralized one as it was exported', async () => {
    const bytes = archiveOf(
      sheetXmlOf([
        [text('A1', 'NOME'), text('B1', 'CODICE'), text('C1', 'DESCRIZIONE')],
        [text('A2', "=cmd|' /C calc'!A0"), text('B2', '+1'), text('C2', '@SUM(1)')],
        [text('A3', "'=1+1"), text('B3', "'-1"), text('C3', "''@x")],
        [`<c r="A4" t="str"><f>HYPERLINK("http://example.invalid")</f><v>Risultato</v></c>`, text('B4', '\t'), text('C4', '=')],
      ]),
    );
    assert.deepEqual(counts(await runBytes(bytes)).products, { ...ZERO, inserted: 3 });
    const stored = await db.products.find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(stored.map((document) => [document['name'].it, document['code'], document['description'].it]), [
      ["=cmd|' /C calc'!A0", '+1', '@SUM(1)'],
      ['=1+1', '-1', "'@x"],
      ['Risultato', '', '='],
    ]);
  });

  it('takes the other kinds of cell as the text they are: a number, a boolean is not a value', async () => {
    const bytes = archiveOf(
      sheetXmlOf([
        [text('A1', 'NOME'), text('B1', 'POSIZIONE'), text('C1', 'DISPONIBILE CASSA (X)'), text('D1', 'CODICE')],
        [text('A2', 'Numerico'), '<c r="B2"><v>12</v></c>', '', '<c r="D2"><v>1.5</v></c>'],
        [text('A3', 'Booleano'), '', '<c r="C3" t="b"><v>1</v></c>', ''],
      ]),
    );
    const reply = await untouched(() => runBytes(bytes));
    assert.deepEqual(problems(reply), ['Prodotti:3:DISPONIBILE CASSA (X):invalidValue']);
    const clean = archiveOf(sheetXmlOf([[text('A1', 'NOME'), text('B1', 'POSIZIONE'), text('C1', 'CODICE')], [text('A2', 'Numerico'), '<c r="B2"><v>12</v></c>', '<c r="C2"><v>1.5</v></c>']]));
    assert.deepEqual(counts(await runBytes(clean)).products, { ...ZERO, inserted: 1 });
    const [created] = await byName('products', 'Numerico');
    assert.deepEqual([Number(created!['position']), created!['code']], [12, '1.5']);
  });

  it('refuses a text that is too long and a text with a control character as a problem of the row, never as a crash', async () => {
    const reply = await untouched(() =>
      products([
        { name: 'A', description: 'd'.repeat(4001) },
        { name: 'B', description: 'd'.repeat(1001) },
        { name: 'C', code: 'a\u007fb' },
        { name: 'D', barcode: 'x\u0085y' },
        { name: 'E', shortName: 'a‮b' },
      ]),
    );
    assert.deepEqual(reply.status, 422);
    const lines = problems(reply);
    assert.deepEqual(lines, ['Prodotti:2:DESCRIZIONE:invalidValue', 'Prodotti:3:DESCRIZIONE:invalid', 'Prodotti:4:CODICE:invalid']);
    const control = archiveOf(sheetXmlOf([[text('A1', 'NOME')], ['<c r="A2" t="inlineStr"><is><t>a&#1;b</t></is></c>']]));
    assert.deepEqual(detailsOf(await runBytes(control)), incorrectFile, 'a character the XML cannot hold is a damaged file');
  });

  it('takes the words a database or a language gives a meaning to as plain names and references', async () => {
    const words = ['__proto__', 'constructor', 'toString', '$gt', '$where', '{"$ne":null}', 'a.b', '$'];
    const reply = await run({ categories: words.map((name) => ({ name })), products: words.map((name) => ({ name, categories: name, code: name })) });
    assert.deepEqual(counts(reply), { products: { ...ZERO, inserted: words.length }, variants: ZERO, categories: { ...ZERO, inserted: words.length } });
    for (const word of words) {
      assert.equal(await db.products.countDocuments({ 'name.it': word }), 1, word);
      const [made] = await byName('products', word);
      const [named] = await byName('categories', word);
      assert.deepEqual((made!['categories'] as ObjectId[]).map(hex), [hex(named!['_id'] as ObjectId)], word);
      assert.equal(made!['code'], word);
    }
    assert.equal(Object.getPrototypeOf({}), Object.prototype, 'nothing polluted the prototypes');
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});

describe('catalog import: the activity log', () => {
  it('records the changes of the services as the routes do, after the commit and with the same request, then the summary with the counts and nothing of the file', async () => {
    await seed({ name: { it: 'Acqua' } });
    await world.as.tokenOf(sa());
    const mark = world.office.activity.entries.length;
    const target = (await byName('products', 'Acqua'))[0]!['_id'] as ObjectId;
    const reply = await run({ categories: [{ name: 'SECRET-CATEGORY' }], products: [{ id: hex(target), name: 'SECRET-NAME', list1: listId, price1: '9.99', tax1: taxId }, { name: 'Nuovo', code: 'SECRET-CODE' }] });
    assert.deepEqual(counts(reply).products, { ...ZERO, inserted: 1, updated: 1 });
    const entries = world.office.activity.entries.slice(mark);
    assert.deepEqual(entries.map((entry) => entry.action), ['productCategory.created', 'product.updated', 'product.created', 'catalog.imported']);
    assert.equal(new Set(entries.map((entry) => entry.requestId)).size, 1, 'one request');
    assert.ok(entries.every((entry) => entry.outcome === 'success' && entry.actor.id?.toHexString() === hex(sa()) && entry.groupId?.toHexString() === hex(gid())));
    const updated = entries[1]!;
    assert.equal(updated.resource?.id, hex(target));
    assert.ok(updated.changes !== undefined && JSON.stringify(updated.changes).includes('SECRET-NAME'), 'the entry of the product has its before and after, as the route writes it');
    const summary = entries[3]!;
    assert.deepEqual(
      { category: summary.category, outcome: summary.outcome, resource: summary.resource, metadata: summary.metadata, changes: summary.changes },
      { category: 'data', outcome: 'success', resource: { type: 'catalog' }, metadata: { dryRun: false, inserted: 2, updated: 1, removed: 0, unchanged: 0 }, changes: undefined },
    );
    assert.doesNotMatch(JSON.stringify(summary), /SECRET|Acqua|9\.99|Nuovo/);
    const patched = await world.as.call(sa(), 'PATCH', `/groups/${hex(gid())}/products/${hex(target)}`, { code: 'Z-9' }, { 'if-match': (await world.as.call(sa(), 'GET', `/groups/${hex(gid())}/products/${hex(target)}`)).headers.get('etag')! });
    assert.equal(patched.status, 200);
    const route = world.office.activity.entries.at(-1)!;
    assert.deepEqual([route.action, Object.keys((route.changes ?? [])[0] ?? {}).sort(), route.resource?.type], [updated.action, Object.keys((updated.changes ?? [])[0] ?? {}).sort(), updated.resource?.type], 'the same entry the route writes');
  });

  it('writes the changes of the deletions too (the trash of a product, the deletion of a category)', async () => {
    const id = await seed({ name: { it: 'Cestino' } });
    const gone = await seedCategory({ name: { it: 'Via' } });
    const mark = world.office.activity.entries.length;
    assert.equal((await run({ products: [{ id: hex(id), delete: 'X' }], categories: [{ id: hex(gone), delete: 'X' }] })).status, 200);
    assert.deepEqual(
      world.office.activity.entries.slice(mark).map((entry) => entry.action),
      [...world.office.activity.entries.slice(mark).map((entry) => entry.action).filter((action) => action !== 'catalog.imported' && action.startsWith('product')), 'catalog.imported'].sort((a, b) => (a === 'catalog.imported' ? 1 : b === 'catalog.imported' ? -1 : 0)),
    );
    const actions = world.office.activity.entries.slice(mark).map((entry) => entry.action);
    assert.equal(actions.at(-1), 'catalog.imported');
    assert.ok(actions.some((action) => action.startsWith('product.')) && actions.includes('productCategory.deleted'), actions.join(' '));
  });

  it('leaves the import valid when the entries of a committed import cannot be written, and says so in the log of the server', async () => {
    const logged = memoryLogger();
    const service = serviceWith(undefined, Date.now, ctx.databases, { activityLog: { record: () => Promise.reject(new Error('SECRET log down')) }, logger: logged.logger });
    const principal = principalOf('SA', { groupId: gid(), userId: sa() });
    const access = (await accessFor(principal, gid()))!;
    const outcome = await service.import(principal, access, await catalogWorkbook({ categories: [{ name: 'Scritta' }] }), false, { requestId: 'req-9', ip: '10.0.0.1', userAgent: null });
    assert.deepEqual(outcome.sheets.categories, { ...ZERO, inserted: 1 });
    assert.equal(await db.categories.countDocuments(), 1, 'the import is committed');
    const event = logged.events.find((candidate) => candidate['msg'] === 'the activity entries of a committed catalog import could not be written');
    assert.ok(event !== undefined, JSON.stringify(logged.events));
    assert.equal(event!['level'], 'error');
  });

  it('records a dry run as one, and a refused file with the reason and the number of problems only', async () => {
    await products([{ name: 'Prova' }], { query: '?dryRun=true' });
    await products([{ name: 'SECRET-A', pos: 'SECRET-B' }, { name: 'SECRET-C', favorite: 'SECRET-D' }]);
    await runBytes(Buffer.from('PK\x03\x04 SECRET-E'));
    await products([{ name: 'SECRET-F', pos: 'q' }], { query: '?dryRun=true' });
    assert.deepEqual(
      imported(0).map((entry) => [entry.outcome, entry.metadata]),
      [
        ['success', { dryRun: true, inserted: 1, updated: 0, removed: 0, unchanged: 0 }],
        ['failure', { dryRun: false, reason: 'rows', errors: 2 }],
        ['failure', { dryRun: false, reason: 'file' }],
        ['failure', { dryRun: true, reason: 'rows', errors: 1 }],
      ],
    );
    assert.doesNotMatch(JSON.stringify(world.office.activity.entries), /SECRET/);
    assert.deepEqual([...new Set(world.office.activity.entries.map((entry) => entry.action))], ['catalog.imported'], 'a dry run and a refused file leave no trace of changes that did not happen');
  });

  it('records the failure of an import that takes too long (tooSlow) or breaks (error), with the reason and nothing else', async () => {
    const slow = await run({ categories: [{ name: 'A' }] }, { path: base().replace('catalog-import', 'import-slow') });
    assert.equal(slow.status, 413);
    fault = { collection: 'products_categories', operation: 'insertOne', after: 0, error: new Error('SECRET') };
    const broken = await run({ categories: [{ name: 'B' }] }, { path: base().replace('catalog-import', 'import-faulty') });
    assert.equal(broken.status, 500);
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'tooSlow' }], ['failure', { dryRun: false, reason: 'error' }]]);
    assert.deepEqual(imported(0), []);
    assert.doesNotMatch(JSON.stringify(audit.entries), /SECRET/);
  });
});
