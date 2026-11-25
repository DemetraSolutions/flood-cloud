import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCatalogXlsxController } from '../../src/modules/catalog-xlsx/catalog-xlsx.controller.ts';
import { CATALOG_IMPORT_LIMITS } from '../../src/modules/catalog-xlsx/catalog-xlsx.parse.ts';
import { createCatalogXlsxRoutes } from '../../src/modules/catalog-xlsx/catalog-xlsx.routes.ts';
import { exportQuery } from '../../src/modules/catalog-xlsx/catalog-xlsx.schemas.ts';
import { createCatalogXlsxService } from '../../src/modules/catalog-xlsx/catalog-xlsx.service.ts';
import type { CatalogXlsxDeps, CatalogXlsxService } from '../../src/modules/catalog-xlsx/catalog-xlsx.service.ts';
import { defineRoute } from '../../src/shared/http/routes.ts';
import { validateQuery } from '../../src/shared/validation/middleware.ts';
import { readXlsxSheets } from '../../src/shared/xlsx/reader.ts';
import { restoreFormula } from '../../src/shared/xlsx/formula.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { addUser } from '../helpers/backoffice.ts';
import { downloadWorkbook } from '../helpers/catalog-xlsx.ts';
import { legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { catalogCollections, legacyCategory } from '../helpers/product-catalog.ts';
import type { CatalogCollections } from '../helpers/product-catalog.ts';
import { legacyFullProduct, legacyPrice, placeEntry } from '../helpers/products.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';

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
/** The copies of the places in the common database: what the workbook reads. */
const places = () => ctx.databases.common().collection('places');
const base = (index = 0) => `/groups/${hex(world.group(index).groupId)}/catalog-export`;
const ALL = { cash: true, warehouse: true, customersApp: true, tobaccosGamesMonopoly: true, productsVariants: true, services: true, scales: true, ordering: true, rooms: true, media: true };
const exported = (mark: number) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'catalog.exported');
let listId = '';
let taxId = '';

const PRODUCT_HEADERS = [
  'ID', 'POSIZIONE', 'NOME', 'NOME BREVE', 'CATEGORIE (ID / NOME)', 'LISTINO 1 (ID / NOME )', 'PREZZO 1', 'ALIQUOTA 1 (ID / VALORE)', 'DISPONIBILE CASSA (X)', 'PREFERITO (X)', 'PREFERITO PALMARE (X)', 'MOVIMENTA MAGAZZINO (X)',
  'DISPONIBILE BILANCIA (X)', 'PLU', 'PEZZO/PESO (p / w)', 'DISPONIBILE E-COMMERCE (X)', 'DESCRIZIONE', 'DESCRIZIONE BREVE', 'CODICE', 'BARCODE', 'CANCELLAZIONE (X)',
  ...Array.from({ length: 14 }, (_, index) => index + 2).flatMap((n) => [`LISTINO ${String(n)} (ID / NOME )`, `PREZZO ${String(n)}`, `ALIQUOTA ${String(n)} (ID / VALORE)`]),
];
const VARIANT_HEADERS = [PRODUCT_HEADERS[0]!, 'TIPO (pm / p / m / i)', ...PRODUCT_HEADERS.slice(1)];
const CATEGORY_HEADERS = ['ID', 'POSIZIONE', 'NOME', 'GENITORE', 'DISPONIBILE CASSA (X)', 'CATEGORIE VARIANTI (ID / NOME)', 'DESCRIZIONE', 'COLORE (1-12 / HEX)', 'CANCELLAZIONE (X)'];

/** A sheet read back: its header and its rows keyed by header. */
interface Table {
  readonly header: string[];
  readonly rows: Array<Record<string, string>>;
  readonly raw: Array<Record<string, string>>;
}

/** The three sheets of a workbook; every cell of the file must be a text. */
function tablesOf(bytes: Buffer): Record<'Prodotti' | 'Varianti' | 'Categorie', Table> {
  const sheets = readXlsxSheets(bytes, ['Prodotti', 'Varianti', 'Categorie'], CATALOG_IMPORT_LIMITS);
  assert.deepEqual([...sheets.keys()].sort(), ['Categorie', 'Prodotti', 'Varianti']);
  const table = (name: string): Table => {
    const [head, ...data] = sheets.get(name)!.rows;
    const header = head!.cells.map((cell) => String(cell));
    const raw = data.map((row) =>
      Object.fromEntries(
        header.map((title, index) => {
          const cell = row.cells[index] ?? '';
          assert.equal(typeof cell, 'string', `${name}.${title} is a text`);
          return [title, cell as string];
        }),
      ),
    );
    return { header, raw, rows: raw.map((row) => Object.fromEntries(Object.entries(row).map(([title, cell]) => [title, restoreFormula(cell)]))) };
  };
  return { Prodotti: table('Prodotti'), Varianti: table('Varianti'), Categorie: table('Categorie') };
}
const fetchTables = async (path = base(), actor = sa()) => {
  const reply = await downloadWorkbook(world, path, actor);
  assert.equal(reply.status, 200, reply.bytes.toString('utf8').slice(0, 300));
  return { reply, ...tablesOf(reply.bytes) };
};
const refusal = async (path: string, actor: ObjectId) => {
  const reply = await downloadWorkbook(world, path, actor);
  return { status: reply.status, code: (JSON.parse(reply.bytes.toString('utf8')) as { error: { code: string } }).error.code };
};
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
const named = (table: Table, name: string): Record<string, string> => table.rows.find((row) => row['NOME'] === name) ?? assert.fail(`no row named ${name}`);

/** A download that the test holds after its first chunk, to be released (or abandoned) later. */
interface Hold {
  readonly started: Promise<void>;
  readonly closed: Promise<void>;
  readonly finished: Promise<void>;
  markClosed(): void;
  markStarted(): void;
  markFinished(): void;
  release(proceed: boolean): void;
  readonly released: Promise<boolean>;
}
function newHold(): Hold {
  const signal = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };
  const started = signal();
  const closed = signal();
  const finished = signal();
  let release!: (proceed: boolean) => void;
  const released = new Promise<boolean>((done) => (release = done));
  return { started: started.promise, closed: closed.promise, finished: finished.promise, markStarted: started.resolve, markClosed: closed.resolve, markFinished: finished.resolve, release, released };
}
let armed: Hold | null = null;

/** The service of the workbook over the test databases, with nothing of the group but what the export reads. */
function serviceWith(limits: CatalogXlsxDeps['limits']): CatalogXlsxService {
  return createCatalogXlsxService({
    databases: ctx.databases,
    catalogs: { list: () => Promise.resolve([]) } as unknown as CatalogXlsxDeps['catalogs'],
    images: { imageSource: () => Promise.resolve(null) },
    users: { findById: () => Promise.resolve(null) } as unknown as CatalogXlsxDeps['users'],
    activityLog: audit,
    logger: memoryLogger().logger,
    versionKey: Buffer.alloc(32, 1),
    now: Date.now,
    ...(limits === undefined ? {} : { limits }),
  });
}

/** The same service, whose download stops after its first chunk when a test armed a {@link Hold}. */
function holdingService(): CatalogXlsxService {
  const real = serviceWith(undefined);
  return {
    ...real,
    export: async (...args) => {
      const file = await real.export(...args);
      const mine = armed;
      armed = null;
      if (mine === null) {
        return file;
      }
      return {
        fileName: file.fileName,
        chunks: (async function* () {
          try {
            for await (const chunk of file.chunks) {
              yield chunk;
              mine.markStarted();
              if (!(await mine.released)) {
                return;
              }
            }
          } finally {
            mine.markFinished();
          }
        })(),
      };
    },
  };
}

const AUTH = { kind: 'user' as const, permission: 'products:read' as const, group: true as const };
const watchClose = (_req: unknown, res: { on(event: 'close', listener: () => void): unknown }, next: () => void) => {
  const mine = armed;
  res.on('close', () => mine?.markClosed());
  next();
};
const exportRoute = (name: string, service: CatalogXlsxService, timeoutMs?: number) =>
  defineRoute({ method: 'GET', path: `/groups/:groupId/${name}`, auth: AUTH, middleware: [validateQuery(exportQuery), watchClose as never], handler: createCatalogXlsxController(service, timeoutMs).export });

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, {
    rateLimiter: limiter,
    extraRoutes: [
      exportRoute('export-limited', serviceWith({ maxExportProducts: 2 })),
      exportRoute('export-held', holdingService()),
      exportRoute('export-timeout', holdingService(), 20),
    ],
  });
  db = catalogCollections(ctx, world);
  await groups().updateOne({ _id: gid() }, { $set: Object.fromEntries(Object.entries(ALL).map(([key, flag]) => [`settings.${key}`, flag])) });
  const group = (await groups().findOne({ _id: gid() }))!;
  listId = Object.keys(group['priceLists'] as Document)[0]!;
  taxId = (group['taxes'] as Document[])[0]!['id'] as string;
  await places().updateOne({ _id: own() }, { $set: { name: '  Bar Alfa ', printStations: [{ id: 'st-1', name: 'Cucina' }, { id: 'st-2', name: ' Bar ' }, { id: 'st-3' }, { name: 'senza id' }, { id: 'st-4', name: '  ' }, 7] } });
  await places().updateOne({ _id: other() }, { $set: { name: 'Bar Beta', printStations: [{ id: 'st-9', name: 'Forno' }] } });
  store = await world.activate(own());
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  armed = null;
  world.office.activity.entries.length = 0;
  audit.entries.length = 0;
  await Promise.all([db.products.deleteMany({}), db.categories.deleteMany({})]);
});

describe('catalog template', () => {
  it('has the three sheets with the fixed headers of the legacy workbook and a column of each kind for every point of sale, and no data row', async () => {
    const mark = world.office.activity.entries.length;
    const { reply, Prodotti, Varianti, Categorie } = await fetchTables(`${base()}/template`);
    assert.equal(reply.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(reply.headers.get('content-disposition'), 'attachment; filename="products-variants-categories-model.xlsx"');
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Prodotti.header, [...PRODUCT_HEADERS, 'DISPO | Bar Alfa', 'DISPO | Bar Beta']);
    assert.deepEqual(Varianti.header, [...VARIANT_HEADERS, 'DISPO | Bar Alfa', 'DISPO | Bar Beta']);
    assert.equal(PRODUCT_HEADERS.length, 63);
    assert.equal(VARIANT_HEADERS.length, 64);
    assert.equal(CATEGORY_HEADERS.length, 9);
    assert.deepEqual(Categorie.header, [...CATEGORY_HEADERS, 'POSTAZIONI SALA | Bar Alfa', 'POSTAZIONI SALA | Bar Beta', 'POSTAZIONI BANCO | Bar Alfa', 'POSTAZIONI BANCO | Bar Beta', 'DISPO | Bar Alfa', 'DISPO | Bar Beta']);
    for (const table of [Prodotti, Varianti, Categorie]) {
      assert.equal(table.rows.length, 0);
    }
    assert.deepEqual(exported(mark), [], 'the model is not recorded');
  });

  it('leaves out a point of sale in the trash and one without a name, and shows a company or place administrator his own places only', async () => {
    const trashed = new ObjectId();
    const unnamed = new ObjectId();
    const blank = new ObjectId();
    await places().insertMany([{ _id: trashed, groupId: gid(), name: 'Bar Cestinato', trash: true }, { _id: unnamed, groupId: gid() }, { _id: blank, groupId: gid(), name: '   ' }]);
    try {
      const all = (await fetchTables(`${base()}/template`)).Prodotti.header.filter((title) => title.startsWith('DISPO | '));
      assert.deepEqual(all, ['DISPO | Bar Alfa', 'DISPO | Bar Beta']);
      for (const actor of [ca(), pa()]) {
        const mine = await fetchTables(`${base()}/template`, actor);
        assert.deepEqual(
          mine.Categorie.header.slice(9),
          ['POSTAZIONI SALA | Bar Alfa', 'POSTAZIONI BANCO | Bar Alfa', 'DISPO | Bar Alfa'],
        );
        assert.deepEqual(mine.Varianti.header.slice(64), ['DISPO | Bar Alfa']);
      }
    } finally {
      await places().deleteMany({ _id: { $in: [trashed, unnamed, blank] } });
    }
  });

  it('is refused with 413 when the group has more points of sale than the workbook has columns for, for the export too', async () => {
    const extra = Array.from({ length: 59 }, (_, index) => ({ _id: new ObjectId(), groupId: gid(), name: `Extra ${String(index).padStart(2, '0')}` }));
    await places().insertMany(extra);
    try {
      assert.deepEqual(await refusal(`${base()}/template`, sa()), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
      assert.deepEqual(await refusal(base(), sa()), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
      assert.equal((await downloadWorkbook(world, `${base()}/template`, pa())).status, 200, 'a place administrator has one place');
      await places().deleteOne({ _id: extra[0]!._id });
      assert.equal((await downloadWorkbook(world, `${base()}/template`, sa())).status, 200, '60 places fit');
    } finally {
      await places().deleteMany({ _id: { $in: extra.map((place) => place._id) } });
    }
  });
});

describe('catalog export: what is in the file', () => {
  it('writes the enabled products by type, the enabled variants and the enabled categories, by name, and counts them in the activity log', async () => {
    const root = await seedCategory({ name: { it: 'Bevande' } });
    await seedCategory({ name: { it: 'Spenta' }, status: false });
    await seedCategory({ name: { it: 'Birre' }, parentId: root });
    await seed({ name: { it: 'Zucchero' } });
    await seed({ name: { it: 'Acqua' }, type: 'exempt' });
    await seed({ name: { it: 'Massaggio' }, type: 'service' });
    await seed({ name: { it: 'Senza tipo' }, type: undefined });
    await seed({ name: { it: 'Sigarette' }, type: 'tobaccos' });
    await seed({ name: { it: 'Gratta' }, type: 'games' });
    await seed({ name: { it: 'Monopoli' }, type: 'monopoly' });
    await seed({ name: { it: 'Spento' }, status: false });
    await seed({ name: { it: 'Cestinato' }, trash: true });
    await seed({ name: { it: 'Extra' }, variant: { status: true, type: 'p' } });
    await seed({ name: { it: 'Altra' }, variant: { status: true, type: 'm' } });
    await seed({ name: { it: 'Variante spenta' }, status: false, variant: { status: true, type: 'p' } });
    await seed({ name: { it: 'Variante cestinata' }, trash: true, variant: { status: true, type: 'p' } });
    const mark = world.office.activity.entries.length;
    const { reply, Prodotti, Varianti, Categorie } = await fetchTables();
    assert.equal(reply.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.equal(reply.headers.get('content-disposition'), `attachment; filename="products-variants-categories_${new Date(world.office.clock.now()).toISOString().slice(0, 10)}.xlsx"`);
    assert.deepEqual(Prodotti.header.slice(0, 63), PRODUCT_HEADERS);
    assert.deepEqual(Varianti.header.slice(0, 64), VARIANT_HEADERS);
    assert.deepEqual(Categorie.header.slice(0, 9), CATEGORY_HEADERS);
    assert.deepEqual(Prodotti.rows.map((row) => row['NOME']), ['Acqua', 'Massaggio', 'Senza tipo', 'Zucchero']);
    assert.deepEqual(Varianti.rows.map((row) => row['NOME']), ['Altra', 'Extra']);
    assert.deepEqual(Categorie.rows.map((row) => row['NOME']), ['Bevande', 'Birre']);
    const entries = exported(mark);
    assert.equal(entries.length, 1);
    const [entry] = entries as [(typeof entries)[number]];
    assert.deepEqual({ category: entry.category, outcome: entry.outcome, action: entry.action, resource: entry.resource, groupId: entry.groupId?.toHexString(), actor: entry.actor.id?.toHexString(), metadata: entry.metadata }, {
      category: 'data',
      outcome: 'success',
      action: 'catalog.exported',
      resource: { type: 'catalog' },
      groupId: hex(gid()),
      actor: hex(sa()),
      metadata: { references: 'ids', products: 4, variants: 2, categories: 2 },
    });
    const text = JSON.stringify(entry);
    for (const forbidden of ['Zucchero', 'Acqua', 'Bevande', 'Extra', hex(root)]) {
      assert.ok(!text.includes(forbidden), `${forbidden} is not in the entry`);
    }
  });

  it('writes every cell as a text and keeps what a spreadsheet would read as a number or a formula', async () => {
    await seed({
      name: { it: '=1+1' },
      shortName: { it: '+x' },
      description: { it: '-x' },
      shortDescription: { it: '@x' },
      code: '000123',
      plu: '\tx',
      barcode: [{ value: '0012', qtLoad: null, qtSale: 1 }],
      position: new Int32(7),
    });
    await seed({ name: { it: "'=quoted" }, code: '0099', plu: '007', barcode: [{ value: '00000012', qtLoad: null, qtSale: 1 }] });
    const { Prodotti } = await fetchTables();
    const formula = Prodotti.raw.find((row) => row['NOME']?.endsWith('=1+1')) ?? assert.fail('no formula row');
    assert.deepEqual(
      [formula['NOME'], formula['NOME BREVE'], formula['DESCRIZIONE'], formula['DESCRIZIONE BREVE'], formula['PLU']],
      ["'=1+1", "'+x", "'-x", "'@x", "'\tx"],
      'the text is not a formula on the way out',
    );
    const restored = named(Prodotti, '=1+1');
    assert.deepEqual([restored['NOME BREVE'], restored['DESCRIZIONE'], restored['DESCRIZIONE BREVE'], restored['PLU'], restored['CODICE'], restored['BARCODE'], restored['POSIZIONE']], ['+x', '-x', '@x', '\tx', '000123', '0012', '7']);
    assert.match(restored['ID']!, /^[0-9a-f]{24}$/);
    const quoted = named(Prodotti, "'=quoted");
    assert.deepEqual([quoted['CODICE'], quoted['PLU'], quoted['BARCODE']], ['0099', '007', '00000012']);
    assert.equal(Prodotti.raw.find((row) => row['CODICE'] === '0099')!['NOME'], "''=quoted");
    for (const row of Prodotti.raw) {
      for (const [title, cell] of Object.entries(row)) {
        assert.ok(!/^[=+\-@\t\r]/.test(cell), `${title} starts as a formula: ${cell}`);
      }
    }
  });

  it('writes the flags, the scale type, the first barcode only, the position and the availability by point of sale of a product', async () => {
    await seed({
      name: { it: 'Pieno' },
      availability: { pos: true, warehouse: true, scales: true, ecommerce: true },
      favorite: true,
      favoriteHandheld: true,
      scaleType: new Int32(1),
      barcode: [{ value: '111', qtLoad: null, qtSale: 1 }, { value: '222', qtLoad: null, qtSale: 1 }],
      position: new Double(3),
      placesAvailability: [placeEntry(own())],
    });
    await seed({ name: { it: 'Vuoto' }, availability: { pos: false, warehouse: false, scales: false, ecommerce: false }, scaleType: new Int32(0), barcode: [], position: new Double(2.5), placesAvailability: [other()] });
    await seed({ name: { it: 'Tutti' }, scaleType: 'x', position: null, placesAvailability: [] });
    await seed({ name: { it: 'Misto' }, scaleType: undefined, position: 'x', placesAvailability: [placeEntry(own()), placeEntry(other())] });
    const { Prodotti } = await fetchTables();
    const full = named(Prodotti, 'Pieno');
    assert.deepEqual(
      [full['DISPONIBILE CASSA (X)'], full['PREFERITO (X)'], full['PREFERITO PALMARE (X)'], full['MOVIMENTA MAGAZZINO (X)'], full['DISPONIBILE BILANCIA (X)'], full['DISPONIBILE E-COMMERCE (X)'], full['PEZZO/PESO (p / w)'], full['BARCODE'], full['POSIZIONE'], full['CANCELLAZIONE (X)']],
      ['X', 'X', 'X', 'X', 'X', 'X', 'p', '111', '3', ''],
    );
    assert.deepEqual([full['DISPO | Bar Alfa'], full['DISPO | Bar Beta']], ['X', '']);
    const empty = named(Prodotti, 'Vuoto');
    assert.deepEqual(
      [empty['DISPONIBILE CASSA (X)'], empty['PREFERITO (X)'], empty['MOVIMENTA MAGAZZINO (X)'], empty['DISPONIBILE BILANCIA (X)'], empty['DISPONIBILE E-COMMERCE (X)'], empty['PEZZO/PESO (p / w)'], empty['BARCODE'], empty['POSIZIONE']],
      ['', '', '', '', '', 'w', '', ''],
    );
    assert.deepEqual([empty['DISPO | Bar Alfa'], empty['DISPO | Bar Beta']], ['', 'X'], 'the historical element of a place is an availability');
    const everywhere = named(Prodotti, 'Tutti');
    assert.deepEqual([everywhere['DISPO | Bar Alfa'], everywhere['DISPO | Bar Beta'], everywhere['PEZZO/PESO (p / w)'], everywhere['POSIZIONE']], ['', '', '', ''], 'a product for every place has no mark');
    const both = named(Prodotti, 'Misto');
    assert.deepEqual([both['DISPO | Bar Alfa'], both['DISPO | Bar Beta'], both['PEZZO/PESO (p / w)'], both['POSIZIONE']], ['X', 'X', '', '']);
  });

  it('writes the type of a variant and the categories and the prices as ids, or as names with the tax rate as a percentage, and falls back to the id of what has no name', async () => {
    const root = await seedCategory({ name: { it: 'Bevande' } });
    const child = await seedCategory({ name: { it: 'Birre' }, parentId: root, variantsCategories: [root] });
    const ghost = new ObjectId();
    await seed({
      name: { it: 'Acqua' },
      categories: [child, ghost, root],
      prices: [legacyPrice({ id: 'a', listId, taxed: new Double(1.5), taxData: { id: taxId, value: 22, department: 1, description: null, natura: null } }), legacyPrice({ id: 'b', listId: 'listino-fantasma', taxed: new Double(0.3), taxData: { id: 'tax-xx', value: 'x', department: 1 } })],
    });
    await seed({ name: { it: 'Extra' }, variant: { status: true, type: 'pm' }, categories: [root] });
    await seed({ name: { it: 'Altra' }, variant: { status: true, type: 'p' } });
    await seed({ name: { it: 'Meno' }, variant: { status: true, type: 'm' } });
    await seed({ name: { it: 'Nota' }, variant: { status: true, type: 'i' } });
    await seed({ name: { it: 'Strana' }, variant: { status: true, type: 'zz' } });
    const byIds = await fetchTables();
    const ids = named(byIds.Prodotti, 'Acqua');
    assert.equal(ids['CATEGORIE (ID / NOME)'], `${hex(child)} | ${hex(ghost)} | ${hex(root)}`);
    assert.deepEqual([ids['LISTINO 1 (ID / NOME )'], ids['PREZZO 1'], ids['ALIQUOTA 1 (ID / VALORE)']], [listId, '1.5', taxId]);
    assert.deepEqual([ids['LISTINO 2 (ID / NOME )'], ids['PREZZO 2'], ids['ALIQUOTA 2 (ID / VALORE)']], ['listino-fantasma', '0.3', 'tax-xx']);
    assert.deepEqual(byIds.Varianti.rows.map((row) => [row['NOME'], row['TIPO (pm / p / m / i)']]), [['Altra', 'p'], ['Extra', 'pm'], ['Meno', 'm'], ['Nota', 'i'], ['Strana', '']]);
    assert.equal(named(byIds.Varianti, 'Extra')['CATEGORIE (ID / NOME)'], hex(root));
    const defaulted = await fetchTables(`${base()}?references=ids`);
    assert.deepEqual(defaulted.Prodotti.rows, byIds.Prodotti.rows);
    const byNames = await fetchTables(`${base()}?references=names`);
    const names = named(byNames.Prodotti, 'Acqua');
    assert.equal(names['CATEGORIE (ID / NOME)'], `Birre | ${hex(ghost)} | Bevande`);
    assert.deepEqual([names['LISTINO 1 (ID / NOME )'], names['PREZZO 1'], names['ALIQUOTA 1 (ID / VALORE)']], ['Listino 1', '1.5', '22']);
    assert.deepEqual([names['LISTINO 2 (ID / NOME )'], names['PREZZO 2'], names['ALIQUOTA 2 (ID / VALORE)']], ['listino-fantasma', '0.3', 'tax-xx'], 'what has no name or no rate keeps its id');
    assert.equal(named(byNames.Varianti, 'Extra')['CATEGORIE (ID / NOME)'], 'Bevande');
    const children = Object.fromEntries(byNames.Categorie.rows.map((row) => [row['NOME'], row]));
    assert.deepEqual([children['Birre']!['GENITORE'], children['Birre']!['CATEGORIE VARIANTI (ID / NOME)'], children['Bevande']!['GENITORE']], ['Bevande', 'Bevande', '']);
    const idChildren = Object.fromEntries(byIds.Categorie.rows.map((row) => [row['NOME'], row]));
    assert.deepEqual([idChildren['Birre']!['GENITORE'], idChildren['Birre']!['CATEGORIE VARIANTI (ID / NOME)']], [hex(root), hex(root)]);
    const mark = world.office.activity.entries.length;
    await fetchTables(`${base()}?references=names`);
    assert.deepEqual(exported(mark).map((entry) => entry.metadata), [{ references: 'names', products: 1, variants: 5, categories: 2 }]);
  });

  it('writes one price triple per price list, with the rule that always applies, at most fifteen, and leaves the empty ones blank', async () => {
    const lists = Array.from({ length: 16 }, (_, index) => `L${String(index + 1)}`);
    await seed({
      name: { it: 'Molti' },
      prices: [
        legacyPrice({ id: 'late', listId: lists[0], taxed: new Double(9), fromQt: 5 }),
        legacyPrice({ id: 'timed', listId: lists[0], taxed: new Double(8), startDate: '2026-01-01T00:00:00.000Z' }),
        legacyPrice({ id: 'base', listId: lists[0], taxed: new Double(1) }),
        ...lists.slice(1).map((list, index) => legacyPrice({ id: list, listId: list, taxed: new Double(index + 2) })),
      ],
    });
    await seed({
      name: { it: 'Giorni' },
      prices: [legacyPrice({ id: 'week', listId: 'L1', taxed: new Double(4), weekDays: [1, 2] }), legacyPrice({ id: 'daily', listId: 'L1', taxed: new Double(5), startTimeDaily: '08:00', endTimeDaily: '10:00' }), legacyPrice({ id: 'x', listId: 'L2', taxed: 'x' })],
    });
    await seed({ name: { it: 'Senza prezzi' }, prices: [] });
    await seed({ name: { it: 'Senza aliquota' }, prices: [legacyPrice({ id: 'n', listId: 'L1', taxed: new Double(2), taxData: 'x' }), { id: 'o', taxed: new Double(3) }] });
    const { Prodotti } = await fetchTables();
    const many = named(Prodotti, 'Molti');
    assert.deepEqual([many['LISTINO 1 (ID / NOME )'], many['PREZZO 1']], ['L1', '1'], 'the rule with no quantity, dates or days wins');
    for (let slot = 2; slot <= 15; slot += 1) {
      assert.deepEqual([many[`LISTINO ${String(slot)} (ID / NOME )`], many[`PREZZO ${String(slot)}`], many[`ALIQUOTA ${String(slot)} (ID / VALORE)`]], [`L${String(slot)}`, String(slot), taxId], `triple ${String(slot)}`);
    }
    assert.ok(!Object.values(many).includes('L16'), 'the sixteenth list is not written');
    const first = named(Prodotti, 'Giorni');
    assert.deepEqual([first['LISTINO 1 (ID / NOME )'], first['PREZZO 1']], ['L1', '4'], 'with no rule that always applies, the first one is written');
    assert.deepEqual([first['LISTINO 2 (ID / NOME )'], first['PREZZO 2'], first['ALIQUOTA 2 (ID / VALORE)']], ['L2', '', taxId], 'a price that is not a number is blank');
    const none = named(Prodotti, 'Senza prezzi');
    assert.deepEqual([none['LISTINO 1 (ID / NOME )'], none['PREZZO 1'], none['ALIQUOTA 1 (ID / VALORE)'], none['LISTINO 15 (ID / VALORE)' as never] ?? ''], ['', '', '', '']);
    const bare = named(Prodotti, 'Senza aliquota');
    assert.deepEqual([bare['LISTINO 1 (ID / NOME )'], bare['PREZZO 1'], bare['ALIQUOTA 1 (ID / VALORE)'], bare['LISTINO 2 (ID / NOME )']], ['L1', '2', '', '']);
  });

  it('writes the categories with the parent, the colour, the print stations of each place by the order of the stations, and the availability', async () => {
    const root = await seedCategory({ name: { it: 'Bevande' }, position: new Int32(4), backgroundColor: '#FF0000', description: { it: 'Tutte' }, availability: { pos: true, ecommerce: false } });
    await seedCategory({
      name: { it: 'Birre' },
      parentId: root,
      position: null,
      backgroundColor: 'rosso',
      availability: { pos: false, ecommerce: false },
      variantsCategories: [root, 'nope'],
      printStations: { [`__${hex(own())}`]: ['st-2', 'st-1', 'st-ghost', 3], [`__${hex(other())}`]: ['st-9'], nonsense: ['st-1'], [`__${'z'.repeat(24)}`]: ['st-1'] },
      printStationsNoRooms: { [`__${hex(own())}`]: ['st-2'], [`__${hex(other())}`]: 'x' },
      placesAvailability: [placeEntry(own())],
    });
    await seedCategory({ name: { it: 'Altrove' }, placesAvailability: [other()], printStations: { [`__${hex(other())}`]: ['st-9'] } });
    const { Categorie } = await fetchTables();
    assert.deepEqual(Categorie.rows.map((row) => row['NOME']), ['Altrove', 'Bevande', 'Birre']);
    const top = named(Categorie, 'Bevande');
    assert.deepEqual([top['POSIZIONE'], top['DISPONIBILE CASSA (X)'], top['DESCRIZIONE'], top['COLORE (1-12 / HEX)'], top['GENITORE'], top['CANCELLAZIONE (X)']], ['4', 'X', 'Tutte', '#FF0000', '', '']);
    assert.deepEqual([top['POSTAZIONI SALA | Bar Alfa'], top['POSTAZIONI BANCO | Bar Beta'], top['DISPO | Bar Alfa'], top['DISPO | Bar Beta']], ['', '', '', ''], 'a category for every place has no mark');
    const child = named(Categorie, 'Birre');
    assert.deepEqual([child['GENITORE'], child['POSIZIONE'], child['DISPONIBILE CASSA (X)'], child['COLORE (1-12 / HEX)'], child['CATEGORIE VARIANTI (ID / NOME)']], [hex(root), '', '', '', hex(root)]);
    assert.deepEqual(
      [child['POSTAZIONI SALA | Bar Alfa'], child['POSTAZIONI SALA | Bar Beta'], child['POSTAZIONI BANCO | Bar Alfa'], child['POSTAZIONI BANCO | Bar Beta'], child['DISPO | Bar Alfa'], child['DISPO | Bar Beta']],
      ['Cucina|Bar', 'Forno', 'Bar', '', 'X', ''],
    );
    assert.equal(named(Categorie, 'Altrove')['DISPO | Bar Beta'], 'X');
  });

  it('writes a long catalog in several batches, in the order of the names', async () => {
    const names = Array.from({ length: 205 }, (_, index) => `P${String(index).padStart(3, '0')}`);
    await db.products.insertMany([...names].reverse().map((name) => legacyFullProduct({ name: { it: name } })));
    await db.categories.insertMany(Array.from({ length: 103 }, (_, index) => legacyCategory({ name: { it: `C${String(index).padStart(3, '0')}` } })));
    const { Prodotti, Categorie } = await fetchTables();
    assert.deepEqual(Prodotti.rows.map((row) => row['NOME']), names);
    assert.equal(Categorie.rows.length, 103);
    assert.equal(Categorie.rows[102]!['NOME'], 'C102');
  });
});

describe('catalog export: the perimeter of the caller', () => {
  it('shows a company or place administrator only the products and categories of his places, and only the columns of his places', async () => {
    const everywhere = await seedCategory({ name: { it: 'Ovunque' }, printStations: { [`__${hex(own())}`]: ['st-1'], [`__${hex(other())}`]: ['st-9'] } });
    await seedCategory({ name: { it: 'Mia' }, placesAvailability: [placeEntry(own())] });
    await seedCategory({ name: { it: 'Altrui' }, placesAvailability: [placeEntry(other())] });
    await seed({ name: { it: 'Ovunque' }, categories: [everywhere] });
    await seed({ name: { it: 'Mio' }, placesAvailability: [placeEntry(own())] });
    await seed({ name: { it: 'Altrui' }, placesAvailability: [placeEntry(other())] });
    await seed({ name: { it: 'Condiviso' }, placesAvailability: [placeEntry(own()), placeEntry(other())] });
    await seed({ name: { it: 'Variante mia' }, variant: { status: true, type: 'p' }, placesAvailability: [placeEntry(own())] });
    await seed({ name: { it: 'Variante altrui' }, variant: { status: true, type: 'p' }, placesAvailability: [placeEntry(other())] });
    const all = await fetchTables();
    assert.deepEqual(all.Prodotti.rows.map((row) => row['NOME']), ['Altrui', 'Condiviso', 'Mio', 'Ovunque']);
    assert.deepEqual(named(all.Prodotti, 'Condiviso')['DISPO | Bar Beta'], 'X');
    for (const actor of [ca(), pa()]) {
      const mine = await fetchTables(base(), actor);
      assert.deepEqual(mine.Prodotti.rows.map((row) => row['NOME']), ['Condiviso', 'Mio', 'Ovunque']);
      assert.deepEqual(mine.Varianti.rows.map((row) => row['NOME']), ['Variante mia']);
      assert.deepEqual(mine.Categorie.rows.map((row) => row['NOME']), ['Mia', 'Ovunque']);
      assert.deepEqual(mine.Prodotti.header.slice(63), ['DISPO | Bar Alfa']);
      assert.equal(named(mine.Prodotti, 'Condiviso')['DISPO | Bar Alfa'], 'X');
      assert.ok(!Object.keys(named(mine.Prodotti, 'Condiviso')).some((title) => title.includes('Bar Beta')));
      const everyone = named(mine.Categorie, 'Ovunque');
      assert.deepEqual([everyone['POSTAZIONI SALA | Bar Alfa'], everyone['POSTAZIONI SALA | Bar Beta']], ['Cucina', undefined], 'the stations of another place are not shown');
      assert.equal(JSON.stringify(mine).includes('Forno'), false);
    }
  });
});

describe('catalog export: refusals', () => {
  it('refuses an invalid references value and an unknown parameter with 422, before the first byte', async () => {
    for (const query of ['?references=nomi', '?references=', '?references=ids&references=names', '?x=1', '?references=ids&x=1', '?references[$ne]=x']) {
      const reply = await refusal(`${base()}${query}`, sa());
      assert.deepEqual(reply, { status: 422, code: 'VALIDATION_ERROR' }, query);
    }
  });

  it('refuses more products or variants than the limit with 413 and accepts exactly the limit', async () => {
    const limited = `/groups/${hex(gid())}/export-limited`;
    await seed({ name: { it: 'Uno' } });
    await seed({ name: { it: 'Due' } });
    assert.equal((await downloadWorkbook(world, limited, sa())).status, 200, 'two products fit a limit of two');
    await seed({ name: { it: 'Tre' } });
    assert.deepEqual(await refusal(limited, sa()), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    await db.products.deleteMany({});
    await db.products.insertMany(['A', 'B', 'C'].map((name) => legacyFullProduct({ name: { it: name }, variant: { status: true, type: 'p' } })));
    assert.deepEqual(await refusal(limited, sa()), { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    assert.deepEqual(audit.entries, [{ ...audit.entries[0]! }], 'only the successful export of two products is recorded');
    assert.equal(audit.entries[0]!.outcome, 'success');
  });

  it('answers 401 without a token or with a bad one, 403 without the permission to read the products, and 404 for another group', async () => {
    for (const path of [base(), `${base()}/template`]) {
      assert.equal((await world.office.call('GET', path, undefined)).status, 401);
      assert.equal((await world.office.call('GET', path, 'not-a-token')).status, 401);
      const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: false, w: false } } }) });
      assert.deepEqual(await refusal(path, blind.id), { status: 403, code: 'FORBIDDEN' });
      const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { products: { r: true, w: false } } }) });
      assert.equal((await downloadWorkbook(world, path, reader.id)).status, 200, 'who may read the products may download the file');
      assert.deepEqual(await refusal(path.replace(hex(gid()), hex(world.group(1).groupId)), sa()), { status: 404, code: 'NOT_FOUND' });
      assert.deepEqual(await refusal(path, world.office.cluster.dealerB), { status: 404, code: 'NOT_FOUND' });
      assert.equal((await downloadWorkbook(world, path.replace(hex(gid()), 'not-an-id'), sa())).status, 404);
    }
    assert.equal((await downloadWorkbook(world, base(), world.office.cluster.psa)).status, 200);
    assert.equal((await downloadWorkbook(world, base(), world.office.cluster.dealerA)).status, 200);
    assert.equal((await downloadWorkbook(world, `${base()}/template`, world.office.cluster.dealerA)).status, 200);
  });

  it('is not open to the key of a point of sale', async () => {
    for (const path of [base(), `${base()}/template`]) {
      const reply = await world.asStore(store.key, 'GET', path);
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
      assert.equal(reply.headers.get('content-type')?.startsWith('application/json'), true);
    }
    assert.deepEqual(exported(0), []);
  });

  it('limits the export per hour for the user, and not the model', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      statuses.push((await downloadWorkbook(world, base(), sa())).status);
    }
    assert.deepEqual(statuses, [...Array.from({ length: 30 }, () => 200), 429]);
    const refused = await downloadWorkbook(world, base(), sa());
    assert.equal(refused.status, 429);
    assert.equal((JSON.parse(refused.bytes.toString('utf8')) as { error: { code: string } }).error.code, 'RATE_LIMITED');
    const call = limiter.calls.find((entry) => entry.bucket === 'catalog-export:user')!;
    assert.deepEqual([call.limit, call.key], [30, hex(sa())]);
    assert.equal((await downloadWorkbook(world, base(), ca())).status, 200, 'the limit is per user');
    assert.equal((await downloadWorkbook(world, `${base()}/template`, sa())).status, 200, 'the model has no hourly limit of its own');
    assert.equal(limiter.calls.filter((entry) => entry.bucket === 'catalog-export:user').every((entry) => entry.limit === 30), true);
  });
});

describe('catalog export: sparse documents', () => {
  it('writes blank cells for what a document of the legacy does not have', async () => {
    await seed({ name: {}, shortName: undefined, description: {}, shortDescription: undefined, code: undefined, plu: undefined, barcode: undefined, categories: undefined, placesAvailability: undefined, prices: undefined, availability: {}, scaleType: undefined });
    const orphan = await seedCategory({ name: {}, description: undefined, parentId: 'not-an-id', backgroundColor: undefined, variantsCategories: undefined, placesAvailability: undefined, printStations: undefined, printStationsNoRooms: undefined, position: undefined, availability: {} });
    await seedCategory({ name: { it: 'Con genitore strano' }, parentId: { not: 'an id' } });
    const { Prodotti, Categorie } = await fetchTables();
    assert.deepEqual(Prodotti.rows.length, 1);
    const [row] = Prodotti.rows as [Record<string, string>];
    assert.deepEqual(Object.entries(row).filter(([title]) => title !== 'ID').filter(([, cell]) => cell !== ''), [], 'only the id is written');
    assert.equal(Categorie.rows.length, 2);
    const blank = Categorie.rows.find((candidate) => candidate['ID'] === hex(orphan))!;
    assert.deepEqual(Object.entries(blank).filter(([title]) => title !== 'ID').filter(([, cell]) => cell !== ''), []);
    assert.equal(named(Categorie, 'Con genitore strano')['GENITORE'], '');
  });

  it('knows the user of a request only when it is authenticated, for the limit of the exports', () => {
    const rules = createCatalogXlsxRoutes({ template: () => undefined, export: () => undefined, import: () => undefined }, {} as never);
    const rule = rules.find((route) => route.path.endsWith('/catalog-export') && route.method === 'GET')!.rateLimit![0]!;
    assert.equal(rule.key({} as never, { locals: {} } as never), null);
    assert.equal(rule.key({} as never, { locals: { auth: { userId: sa() } } } as never), hex(sa()));
  });
});

describe('catalog export: a download that goes wrong', () => {
  const heldPath = () => `/groups/${hex(gid())}/export-held`;
  const url = (path: string) => `${world.office.app.baseUrl}/v1${path}`;
  const withToken = async (actor: ObjectId, path: string) => world.office.userHeaders('GET', path, await world.as.tokenOf(actor));

  it('lets one export run at a time for a user and answers the second with 429, then frees the user when the first ends', async () => {
    await seed({ name: { it: 'Acqua' } });
    const hold = newHold();
    armed = hold;
    const first = fetch(url(heldPath()), { headers: await withToken(sa(), heldPath()) });
    await hold.started;
    const second = await fetch(url(heldPath()), { headers: await withToken(sa(), heldPath()) });
    assert.equal(second.status, 429);
    assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
    const otherUser = await fetch(url(heldPath()), { headers: await withToken(ca(), heldPath()) });
    assert.equal(otherUser.status, 200, 'the lock is per user');
    await otherUser.arrayBuffer();
    hold.release(true);
    const done = await first;
    assert.equal(done.status, 200);
    const tables = tablesOf(Buffer.from(await done.arrayBuffer()));
    assert.deepEqual(tables.Prodotti.rows.map((row) => row['NOME']), ['Acqua']);
    await hold.finished;
    const again = await fetch(url(heldPath()), { headers: await withToken(sa(), heldPath()) });
    assert.equal(again.status, 200);
    await again.arrayBuffer();
    assert.deepEqual(audit.entries.map((entry) => entry.outcome), ['success', 'success', 'success']);
  });

  it('frees the user when the export fails before the first byte', async () => {
    const hold = newHold();
    armed = hold;
    const first = fetch(url(heldPath()), { headers: await withToken(sa(), heldPath()) });
    await hold.started;
    const invalid = await fetch(`${url(heldPath())}?references=x`, { headers: await withToken(sa(), heldPath()) });
    assert.equal(invalid.status, 422, 'validation comes before the lock');
    hold.release(true);
    await (await first).arrayBuffer();
    await hold.finished;
    const again = await fetch(url(heldPath()), { headers: await withToken(sa(), heldPath()) });
    assert.equal(again.status, 200);
    await again.arrayBuffer();
  });

  it('records a failure when the client goes away in the middle of the download, and does not report an error', async () => {
    await seed({ name: { it: 'Acqua' } });
    const hold = newHold();
    armed = hold;
    const abort = new AbortController();
    const response = await fetch(url(heldPath()), { headers: await withToken(sa(), heldPath()), signal: abort.signal });
    assert.equal(response.status, 200);
    await hold.started;
    abort.abort();
    await hold.closed;
    hold.release(true);
    await hold.finished;
    assert.deepEqual(audit.entries.map((entry) => [entry.action, entry.outcome, entry.metadata]), [['catalog.exported', 'failure', { references: 'ids', products: 0, variants: 0, categories: 0 }]]);
    const next = await fetch(url(heldPath()), { headers: await withToken(sa(), heldPath()) });
    assert.equal(next.status, 200, 'the user is free again');
    await next.arrayBuffer();
  });

  it('cuts a download that takes too long, records a failure, and frees the user', async () => {
    const timeoutPath = `/groups/${hex(gid())}/export-timeout`;
    const hold = newHold();
    armed = hold;
    const response = await fetch(url(timeoutPath), { headers: await withToken(sa(), timeoutPath) });
    assert.equal(response.status, 200, 'the status was sent with the first byte');
    await assert.rejects(response.arrayBuffer(), 'the connection is closed before the end of the file');
    await hold.closed;
    hold.release(false);
    await hold.finished;
    assert.deepEqual(audit.entries.map((entry) => entry.outcome), ['failure']);
    const next = await fetch(url(timeoutPath), { headers: await withToken(sa(), timeoutPath) });
    assert.equal(next.status, 200, 'the user is free again');
    await next.body?.cancel();
  });
});
