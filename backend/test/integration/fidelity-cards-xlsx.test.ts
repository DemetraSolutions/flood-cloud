import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCatalogXlsxController } from '../../src/modules/catalog-xlsx/catalog-xlsx.controller.ts';
import type { WorkbookService } from '../../src/modules/catalog-xlsx/catalog-xlsx.controller.ts';
import { createWorkbookRoutes } from '../../src/modules/catalog-xlsx/catalog-xlsx.routes.ts';
import { CARDS_SHEET, CARD_COLUMNS } from '../../src/modules/fidelity-cards-xlsx/fidelity-cards-xlsx.columns.ts';
import { createCardsXlsxService } from '../../src/modules/fidelity-cards-xlsx/fidelity-cards-xlsx.service.ts';
import type { CardsXlsxDeps } from '../../src/modules/fidelity-cards-xlsx/fidelity-cards-xlsx.service.ts';
import { createCardIndexGuard } from '../../src/modules/fidelity-cards/fidelity-cards.indexes.ts';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createCatalogsService } from '../../src/modules/groups/catalogs/catalogs.service.ts';
import { createReferencesRepository } from '../../src/modules/groups/catalogs/references.repository.ts';
import { createTaxDepartments } from '../../src/modules/product-departments/product-departments.repository.ts';
import { createGate } from '../../src/modules/media/gate.ts';
import { createIdempotencyStore, idempotencyBodyKey } from '../../src/shared/http/idempotency.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';
import { readXlsxSheets } from '../../src/shared/xlsx/reader.ts';
import { restoreFormula } from '../../src/shared/xlsx/formula.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { addUser } from '../helpers/backoffice.ts';
import { downloadWorkbook, uploadWorkbook } from '../helpers/catalog-xlsx.ts';
import { legacyContact } from '../helpers/contacts.ts';
import { accessFor } from '../helpers/group-access.ts';
import { legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { recordsWorkbook, writeBook } from '../helpers/records-xlsx.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

/** The workbook of the advanced loyalty cards (step K3): every behaviour goes through `/v1/groups/{groupId}/fidelity-cards-import` and `fidelity-cards-export`, over a real MongoDB. */
let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const audit = memoryActivityLog();
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const hex = (id: ObjectId) => id.toHexString();
const gid = () => world.group(0).groupId;
const sa = () => world.group(0).sa;
const psa = () => world.office.cluster.psa;
const groups = () => ctx.databases.common().collection('groups');
const db = (name: string, index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection(name);
const cards = (index = 0) => db('fidelity_cards', index);
const movements = () => db('fidelity_cards_movements');
const importPath = (index = 0, segment = 'fidelity-cards-import') => `/groups/${hex(world.group(index).groupId)}/${segment}`;
const exportPath = (index = 0, segment = 'fidelity-cards-export') => `/groups/${hex(world.group(index).groupId)}/${segment}`;
const log = (action: string, mark = 0) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const ids = { active: '', disabled: '', foreign: '', odd: '', prepaid: '', plain: '', both: '', twinA: '', twinB: '' };

type Reply = Awaited<ReturnType<typeof uploadWorkbook>>;
interface Options {
  readonly actor?: ObjectId;
  readonly query?: string;
  readonly path?: string;
  readonly key?: string;
  readonly headers?: readonly string[];
}
type Row = Record<string, string>;

async function run(rows: readonly Row[], options: Options = {}): Promise<Reply> {
  limiter.reset();
  return uploadWorkbook(world, `${options.path ?? importPath()}${options.query ?? ''}`, await recordsWorkbook(CARDS_SHEET, rows, options.headers), options.actor ?? sa(), options.key === undefined ? undefined : { 'idempotency-key': options.key });
}
async function runBytes(bytes: Buffer, options: Options = {}): Promise<Reply> {
  limiter.reset();
  return uploadWorkbook(world, `${options.path ?? importPath()}${options.query ?? ''}`, bytes, options.actor ?? sa(), options.key === undefined ? undefined : { 'idempotency-key': options.key });
}
const problems = (reply: Reply): string[] => {
  assert.equal(reply.status, 422, JSON.stringify(reply.body));
  assert.equal(reply.body.error.code, 'VALIDATION_ERROR');
  return (reply.body.error.rows as Array<{ sheet: string; row: number | null; column: string | null; code: string }>).map((row) => `${row.sheet}:${row.row ?? '-'}:${row.column ?? '-'}:${row.code}`);
};
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const ZERO = { inserted: 0, updated: 0, removed: 0, unchanged: 0 };
const counts = (reply: Reply, dryRun = false) => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.data.dryRun, dryRun);
  assert.deepEqual(Object.keys(reply.body.data.sheets), ['cards']);
  return reply.body.data.sheets.cards as typeof ZERO;
};
const seed = async (overrides: Document = {}): Promise<ObjectId> => {
  const _id = new ObjectId();
  await cards().insertOne({ _id, code: `SEED-${hex(_id)}`, cardTypeId: ids.prepaid, status: true, balance: new Double(10), pointsCollections: { [ids.active]: 50 }, insertDate: new Date('2024-01-01T00:00:00Z'), updateDate: new Date('2024-01-01T00:00:00Z'), legacyExtra: 1, ...overrides });
  return _id;
};
const stored = (code: string) => cards().findOne({ code }, { ...EXACT_TYPES });
const dump = async () => ({ cards: await cards().find({}, { ...EXACT_TYPES }).sort({ _id: 1 }).toArray(), movements: await movements().find({}, { ...EXACT_TYPES }).sort({ _id: 1 }).toArray(), contacts: await db('contacts').find({}, { ...EXACT_TYPES }).sort({ _id: 1 }).toArray() });
const untouched = async (action: () => Promise<Reply>): Promise<Reply> => {
  const before = await dump();
  const reply = await action();
  assert.deepEqual(await dump(), before, 'the database is as it was');
  return reply;
};

const realCatalogs = () => createCatalogsService({ catalogs: createCatalogsRepository(ctx.databases), references: createReferencesRepository(ctx.databases), activityLog: audit, logger: memoryLogger().logger, newId: () => randomUUID(), now: Date.now, taxDepartments: createTaxDepartments(ctx.databases) });
function serviceWith(overrides: Partial<CardsXlsxDeps> = {}): WorkbookService {
  return createCardsXlsxService({ databases: ctx.databases, catalogs: realCatalogs(), indexes: createCardIndexGuard(ctx.databases, memoryLogger().logger), versionKey: Buffer.alloc(32, 1), activityLog: audit, logger: memoryLogger().logger, now: Date.now, ...overrides });
}
let hold: { started: () => void; released: Promise<void> } | null = null;
function holdingService(): WorkbookService {
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
function routesOf(name: string, service: WorkbookService, gate?: ReturnType<typeof createGate>) {
  const idempotency = createIdempotencyStore(ctx.databases, idempotencyBodyKey(TEST_VERSION_KEY), Date.now);
  return createWorkbookRoutes({ exportSegment: `${name}-export`, importSegment: `${name}-import`, bucket: 'fidelity-cards', read: 'fidelity:read', write: 'fidelity:update' }, createCatalogXlsxController(service), idempotency, gate);
}

before(async () => {
  ctx = await openTestDatabases();
  let time = 0;
  world = await startStoreWorld(ctx, {
    rateLimiter: limiter,
    extraRoutes: [
      ...routesOf('x-rows', serviceWith({ limits: { maxRows: 3 } })),
      ...routesOf('x-small', serviceWith({ limits: { maxExport: 2 } })),
      ...routesOf('x-slow', serviceWith({ limits: { maxImportMs: 0 }, now: () => (time += 10) })),
      ...routesOf('x-held', holdingService(), createGate(2, 2)),
    ],
  });
  const create = async (path: string, body: Document) => {
    const reply = await call(psa(), 'POST', `/groups/${hex(gid())}${path}`, body, { 'idempotency-key': randomUUID() });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return reply.body.data.id as string;
  };
  ids.active = await create('/fidelity/points-collections', { name: 'Attiva' });
  ids.disabled = await create('/fidelity/points-collections', { name: 'Spenta', enabled: false });
  ids.foreign = await create('/fidelity/points-collections', { name: 'Fuori tipo' });
  ids.odd = await create('/fidelity/points-collections', { name: 'Con: due punti' });
  ids.prepaid = await create('/fidelity/card-types', { name: 'Prepagata', prepaid: { enabled: true }, pointsCollect: { enabled: true, collectionIds: [ids.active, ids.disabled, ids.odd] } });
  ids.plain = await create('/fidelity/card-types', { name: 'Semplice' });
  ids.both = await create('/fidelity/card-types', { name: 'Solo punti', pointsCollect: { enabled: true, collectionIds: [ids.active] } });
  ids.twinA = await create('/fidelity/card-types', { name: 'Gemella' });
  ids.twinB = await create('/fidelity/card-types', { name: 'Gemella' });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  hold = null;
  world.office.activity.entries.length = 0;
  audit.entries.length = 0;
  await Promise.all([cards().deleteMany({}), cards(1).deleteMany({}), movements().deleteMany({}), db('contacts').deleteMany({})]);
});

const HEADER = ['CODICE', 'TIPO (ID / NOME)', 'SALDO', 'PUNTI (ID / NOME : VALORE | ID / NOME : VALORE)', 'STATO (X = ATTIVA)'];
function tableOf(bytes: Buffer): { header: string[]; rows: string[][]; raw: string[][] } {
  const sheets = readXlsxSheets(bytes, ['Carte']);
  assert.deepEqual([...sheets.keys()], ['Carte']);
  const [head, ...data] = sheets.get('Carte')!.rows;
  const raw = data.map((row) => HEADER.map((_, index) => {
    const cell = row.cells[index] ?? '';
    assert.equal(typeof cell, 'string', 'every cell is a text');
    return cell as string;
  }));
  return { header: head!.cells.map(String), raw, rows: raw.map((row) => row.map(restoreFormula)) };
}

describe('cards workbook: the model and the export', () => {
  it('has one sheet with the columns of the legacy CSV model and the state, and no row', async () => {
    const reply = await downloadWorkbook(world, `${exportPath()}/template`, sa());
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-disposition')!, /fidelity-cards-model\.xlsx/);
    const table = tableOf(reply.bytes);
    assert.deepEqual([table.header, table.rows], [HEADER, []]);
    assert.deepEqual(CARD_COLUMNS.map((column) => column.header), HEADER);
  });

  it('writes every card, active or not, by code, with the credit, the points that are not zero and the state; the references as ids or as names', async () => {
    await seed({ code: 'B-2', status: false, balance: new Double(0), pointsCollections: {} });
    await seed({ code: 'A-1', balance: new Double(12.5), pointsCollections: { [ids.active]: 100, [ids.disabled]: 0, [ids.odd]: 3 } });
    await seed({ code: '=CMD', cardTypeId: ids.plain, balance: undefined, pointsCollections: undefined });
    await seed({ code: 'D-4', cardTypeId: 'type-gone', balance: 'x', pointsCollections: [] });
    await seed({ code: undefined, cardTypeId: ids.plain, balance: undefined, pointsCollections: { [ids.active]: 'many' } });
    await seed({ code: 'E-5', cardTypeId: undefined });
    const reply = await downloadWorkbook(world, exportPath(), sa());
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-disposition')!, /^attachment; filename="fidelity-cards_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const byIds = tableOf(reply.bytes);
    assert.deepEqual(byIds.rows, [
      ['', ids.plain, '', '', 'X'],
      ['=CMD', ids.plain, '', '', 'X'],
      ['A-1', ids.prepaid, '12.5', `${ids.active} : 100 | ${ids.odd} : 3`, 'X'],
      ['B-2', ids.prepaid, '0', '', ''],
      ['D-4', 'type-gone', '', '', 'X'],
      ['E-5', '', '10', `${ids.active} : 50`, 'X'],
    ]);
    assert.equal(byIds.raw[1]![0], "'=CMD", 'a code that is a formula is neutralized in the file');
    const byNames = tableOf((await downloadWorkbook(world, `${exportPath()}?references=names`, sa())).bytes);
    assert.deepEqual(byNames.rows.map((row) => row.slice(1, 4)), [['Semplice', '', ''], ['Semplice', '', ''], ['Prepagata', '12.5', `Attiva : 100 | ${ids.odd} : 3`], ['Prepagata', '0', ''], ['type-gone', '', ''], ['', '10', 'Attiva : 50']], 'a name that has a colon in it stays an id');
    const entry = log('fidelityCards.exported')[0]!;
    assert.deepEqual([entry.outcome, entry.metadata, entry.resource?.type], ['success', { references: 'ids', cards: 6 }, 'fidelityCards']);
    assert.equal((await downloadWorkbook(world, `${exportPath()}?references=x`, sa())).status, 422);
  });

  it('pages through more cards than a batch, refuses more than the limit with 413 and records a failure when the client leaves', async () => {
    await cards().insertMany(Array.from({ length: 230 }, (_, index) => ({ _id: new ObjectId(), code: `C-${String(index).padStart(3, '0')}`, cardTypeId: ids.plain, status: true, balance: new Double(0), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() })));
    const table = tableOf((await downloadWorkbook(world, exportPath(), sa())).bytes);
    assert.deepEqual([table.rows.length, table.rows[0]![0], table.rows[229]![0]], [230, 'C-000', 'C-229']);
    const refused = await downloadWorkbook(world, exportPath(0, 'x-small-export'), sa());
    assert.deepEqual([refused.status, JSON.parse(refused.bytes.toString()).error.code], [413, 'PAYLOAD_TOO_LARGE']);
    const principal = principalOf('SA', { groupId: gid(), userId: sa() });
    const access = (await accessFor(principal, gid()))!;
    const file = await serviceWith().export(principal, access, 'names', { requestId: 'r', ip: null, userAgent: null });
    await file.chunks.next();
    await file.chunks.return(undefined);
    assert.deepEqual([audit.entries.at(-1)!.action, audit.entries.at(-1)!.outcome, 'ip' in audit.entries.at(-1)!], ['fidelityCards.exported', 'failure', false]);
  });
});

describe('cards workbook: a new code', () => {
  it('creates the card with its type by id or by name, and the credit and points it starts with as movements of type import', async () => {
    const mark = world.office.activity.entries.length;
    const reply = await run([
      { code: ' N-1 ', type: ids.prepaid, balance: '12,5', points: `Attiva : 100 | ${ids.disabled}:5 | Con: due punti : 7`, enabled: 'X' },
      { code: 'N-2', type: 'Semplice', balance: '', points: '', enabled: '' },
      { code: 'N-3', type: 'Solo punti', balance: '0', points: 'Attiva : 0' },
    ]);
    assert.deepEqual(counts(reply), { ...ZERO, inserted: 3 });
    const first = (await stored('N-1'))!;
    assert.deepEqual([first['cardTypeId'], first['status'], first['balance'] instanceof Double && first['balance'].valueOf(), plain(first['pointsCollections'])], [ids.prepaid, true, 12.5, { [ids.active]: 100, [ids.disabled]: 5, [ids.odd]: 7 }]);
    assert.deepEqual([(await stored('N-2'))!['status'], (await stored('N-2'))!['cardTypeId']], [false, ids.plain]);
    assert.deepEqual([plain((await stored('N-3'))!['pointsCollections']), (await stored('N-3'))!['balance'] instanceof Double], [{}, true]);
    const history = await movements().find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(history.map((entry) => [entry['type'], entry['cardCode'], entry['balance'], entry['points'], entry['pointsCollectionId']]), [['import', 'N-1', 12.5, 0, null], ['import', 'N-1', 0, 100, ids.active], ['import', 'N-1', 0, 5, ids.disabled], ['import', 'N-1', 0, 7, ids.odd]]);
    assert.ok(history.every((entry) => (entry['userId'] as ObjectId).equals(sa()) && entry['date'] instanceof Date && entry['cardId'] instanceof ObjectId));
    assert.deepEqual(log('fidelityCard.created', mark).length, 3);
    assert.equal(await db('contacts').countDocuments({}), 0, 'no contact is linked');
  });

  it('makes a card active when the sheet has no state column and takes the state of the column when it has one', async () => {
    assert.deepEqual(counts(await run([{ code: 'S-1', type: ids.plain }])), { ...ZERO, inserted: 1 });
    assert.equal((await stored('S-1'))!['status'], true);
  });

  it('refuses what the service refuses, as a problem of the cell: a credit on a type that is not prepaid, points on a collection that is not the type\'s or a type that collects none', async () => {
    const bad = await untouched(() =>
      run([
        { code: 'B-1', type: ids.plain, balance: '5' },
        { code: 'B-2', type: ids.prepaid, points: 'Fuori tipo : 5' },
        { code: 'B-3', type: ids.plain, points: 'Attiva : 5' },
        { code: 'B-4', type: ids.prepaid, balance: '1,234' },
        { code: 'B-5'.repeat(30), type: ids.prepaid },
      ]),
    );
    assert.deepEqual(problems(bad), ['Carte:2:SALDO:invalid', 'Carte:3:PUNTI (ID / NOME : VALORE | ID / NOME : VALORE):invalid', 'Carte:4:PUNTI (ID / NOME : VALORE | ID / NOME : VALORE):invalid', 'Carte:5:SALDO:invalid', 'Carte:6:CODICE:invalid']);
    assert.match(bad.body.error.rows[0].message, /initialBalance: notAllowed/);
  });

  it('refuses a missing or unknown type, a name two types have, a code that is empty or twice, and cells that are not values', async () => {
    const bad = await untouched(() =>
      run([
        { code: 'T-1', type: '' },
        { code: 'T-2', type: 'Nessuna' },
        { code: 'T-3', type: 'Gemella' },
        { code: '', type: ids.plain },
        { code: 'T-4', type: ids.plain },
        { code: 'T-4', type: ids.plain },
        { code: 'T-5', type: ids.prepaid, balance: 'tanto' },
        { code: 'T-6', type: ids.prepaid, balance: '-3' },
        { code: 'T-7', type: ids.prepaid, enabled: 'forse' },
        { code: 'T-8', type: ids.prepaid, points: 'Attiva' },
        { code: 'T-9', type: ids.prepaid, points: ': 5' },
        { code: 'T-10', type: ids.prepaid, points: 'Attiva : cinque' },
        { code: 'T-11', type: ids.prepaid, points: 'Attiva : -5' },
        { code: 'T-12', type: ids.prepaid, points: 'Mai vista : 5' },
        { code: 'T-13', type: ids.prepaid, points: `Attiva : 5 | ${ids.active} : 6` },
      ]),
    );
    assert.deepEqual(problems(bad).map((line) => line.replace('PUNTI (ID / NOME : VALORE | ID / NOME : VALORE)', 'PUNTI')), [
      'Carte:2:TIPO (ID / NOME):required',
      'Carte:3:TIPO (ID / NOME):notFoundReference',
      'Carte:4:TIPO (ID / NOME):ambiguousName',
      'Carte:5:CODICE:required',
      'Carte:7:CODICE:duplicateCode',
      'Carte:8:SALDO:invalidValue',
      'Carte:9:SALDO:invalidValue',
      'Carte:10:STATO (X = ATTIVA):invalidValue',
      'Carte:11:PUNTI:invalidValue',
      'Carte:12:PUNTI:invalidValue',
      'Carte:13:PUNTI:invalidValue',
      'Carte:14:PUNTI:invalidValue',
      'Carte:15:PUNTI:notFoundReference',
      'Carte:16:PUNTI:invalidValue',
    ]);
  });
});

describe('cards workbook: an existing code', () => {
  it('changes only the type and the state, and counts a row that says what is stored as unchanged', async () => {
    await seed({ code: 'E-1', cardTypeId: ids.prepaid, status: true });
    await seed({ code: 'E-2', cardTypeId: ids.plain, status: true, balance: new Double(0), pointsCollections: {} });
    await seed({ code: 'E-3', cardTypeId: ids.plain, status: false, balance: new Double(0), pointsCollections: {} });
    const before = (await stored('E-1'))!;
    const reply = await run([
      { code: 'E-1', type: 'Prepagata', balance: '10', points: `Attiva : 50`, enabled: 'X' },
      { code: 'E-2', type: ids.both, balance: '', points: '', enabled: '' },
      { code: 'E-3', type: '', enabled: 'x' },
    ]);
    assert.deepEqual(counts(reply), { ...ZERO, updated: 2, unchanged: 1 });
    assert.deepEqual(await stored('E-1'), before);
    assert.deepEqual([(await stored('E-2'))!['cardTypeId'], (await stored('E-2'))!['status']], [ids.both, false]);
    assert.deepEqual([(await stored('E-3'))!['cardTypeId'], (await stored('E-3'))!['status']], [ids.plain, true]);
    assert.equal(await movements().countDocuments({}), 0, 'no movement: the credit and the points are not touched');
    assert.deepEqual(log('fidelityCard.updated').length, 2);
  });

  it('works with a sheet that has the code alone: an existing card is unchanged, a new one needs the type column', async () => {
    await seed({ code: 'O-1' });
    assert.deepEqual(counts(await run([{ code: 'O-1' }])), { ...ZERO, unchanged: 1 });
    assert.deepEqual(problems(await untouched(() => run([{ code: 'O-2' }]))), ['Carte:2:TIPO (ID / NOME):required']);
  });

  it('refuses a credit or points that are not the ones the card has, and takes the same values, an empty cell and a zero credit', async () => {
    await seed({ code: 'V-1', balance: new Double(10), pointsCollections: { [ids.active]: 50 } });
    await seed({ code: 'V-2', balance: undefined, pointsCollections: undefined });
    const own = await untouched(() => run([{ code: 'V-1', balance: '11' }, { code: 'V-2', balance: '1' }]));
    assert.deepEqual(problems(own), ['Carte:2:SALDO:balanceChange', 'Carte:3:SALDO:balanceChange']);
    const points = await untouched(() => run([{ code: 'V-1', points: 'Attiva : 51' }, { code: 'V-2', points: `Attiva : 1 | ${ids.disabled} : 0` }]));
    assert.deepEqual(problems(points).map((line) => line.replace('PUNTI (ID / NOME : VALORE | ID / NOME : VALORE)', 'PUNTI')), ['Carte:2:PUNTI:pointsChange', 'Carte:3:PUNTI:pointsChange']);
    assert.deepEqual(counts(await run([{ code: 'V-1', balance: '10,00', points: 'Attiva : 50' }, { code: 'V-2', balance: '0', points: `Attiva : 0` }])), { ...ZERO, unchanged: 2 });
  });

  it('refuses a change to a type that is not prepaid while the card has credit, and takes it when it has none', async () => {
    await seed({ code: 'P-1', balance: new Double(10) });
    await seed({ code: 'P-2', balance: new Double(0), pointsCollections: {} });
    const bad = await untouched(() => run([{ code: 'P-1', type: ids.plain }]));
    assert.deepEqual(problems(bad), ['Carte:2:SALDO:conflict']);
    assert.match(bad.body.error.rows[0].message, /balance: notEmpty/);
    assert.deepEqual(counts(await run([{ code: 'P-2', type: ids.plain }])), { ...ZERO, updated: 1 });
  });

  it('does not touch the contacts, whatever the code', async () => {
    await seed({ code: 'L-1' });
    const contact = legacyContact({ fidelities: [{ code: 'L-1', points: 9 }] });
    await db('contacts').insertOne(contact);
    assert.deepEqual(counts(await run([{ code: 'L-1', enabled: '' }, { code: 'L-2', type: ids.plain }])), { ...ZERO, inserted: 1, updated: 1 });
    assert.deepEqual(plain((await db('contacts').findOne({ _id: contact['_id'] }, { ...EXACT_TYPES }))!['fidelities']), [{ code: 'L-1', points: 9 }]);
  });
});

describe('cards workbook: a code with spaces around it', () => {
  it('finds a card stored as " ABC " by its cleaned code, in the export and the import, and never makes a new one', async () => {
    await seed({ code: ' ABC ', balance: new Double(10), pointsCollections: { [ids.active]: 50 } });
    const exported = tableOf((await downloadWorkbook(world, exportPath(), sa())).bytes);
    assert.deepEqual(exported.rows.map((row) => row[0]), ['ABC']);
    assert.deepEqual(counts(await runBytes(await writeBook([{ name: 'Carte', columns: HEADER, rows: exported.rows }]))), { ...ZERO, unchanged: 1 });
    assert.equal(await cards().countDocuments({}), 1);
    assert.deepEqual(counts(await run([{ code: 'ABC', enabled: '' }])), { ...ZERO, updated: 1 });
    assert.equal(await cards().countDocuments({}), 1);
    const taken = await call(sa(), 'POST', `/groups/${hex(gid())}/fidelity-cards`, { code: 'ABC', cardTypeId: ids.plain }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([taken.status, taken.body.error.details], [409, [{ field: 'code', issue: 'taken' }]]);
  });

  it('refuses a code that more than one card has once the spaces are ignored', async () => {
    await seed({ code: 'DUP' });
    await seed({ code: ' DUP' });
    const bad = await untouched(() => run([{ code: 'DUP', type: ids.plain }]));
    assert.deepEqual(problems(bad), ['Carte:2:CODICE:conflict']);
  });
});

describe('cards workbook: the sheet', () => {
  it('reads the headers of the legacy model, in any order and case, and ignores a column with no header', async () => {
    const bytes = await writeBook([{ name: 'Carte', columns: ['punti (id/nome : valore | id/nome : valore)', 'tipo (id/nome)', '', 'codice', 'saldo'], rows: [['Attiva : 3', 'Prepagata', 'x', 'LEG-1', '4']] }]);
    assert.deepEqual(counts(await runBytes(bytes)), { ...ZERO, inserted: 1 });
    assert.deepEqual([plain((await stored('LEG-1'))!['pointsCollections']), (await stored('LEG-1'))!['status']], [{ [ids.active]: 3 }, true]);
  });

  it('refuses a column that is not of the sheet or that comes twice, and a sheet that has no code column, without reading the rows', async () => {
    const bad = await untouched(async () => runBytes(await writeBook([{ name: 'Carte', columns: ['CODICE', 'Strana', 'CODICE'], rows: [['A', 'b', 'c']] }])));
    assert.deepEqual(problems(bad), ['Carte:-:Strana:unknownColumn', 'Carte:-:CODICE:duplicateColumn']);
    const nocode = await untouched(async () => runBytes(await writeBook([{ name: 'Carte', columns: ['TIPO (ID / NOME)'], rows: [[ids.plain]] }])));
    assert.deepEqual(problems(nocode), ['Carte:-:CODICE:required']);
  });

  it('refuses a workbook without the sheet or without rows, and a boolean or a very long text as a problem of the cell', async () => {
    const wrong = await runBytes(await writeBook([{ name: 'Altro', columns: ['CODICE'], rows: [['x']] }]));
    assert.deepEqual([wrong.status, wrong.body.error.details], [422, [{ field: 'file', issue: 'incorrect' }]]);
    const model = await runBytes((await downloadWorkbook(world, `${exportPath()}/template`, sa())).bytes);
    assert.equal(model.status, 422);
    const long = await runBytes(await writeBook([{ name: 'Carte', columns: ['CODICE', 'TIPO (ID / NOME)'], rows: [['x'.repeat(4001), ids.plain]] }]));
    assert.deepEqual(problems(long), ['Carte:2:CODICE:invalidValue', 'Carte:2:CODICE:required']);
  });

  it('allows 1000 rows and refuses more; blank rows are not rows', async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ code: `R-${String(index)}`, type: ids.plain }));
    assert.deepEqual(counts(await untouched(() => run(rows(1000), { query: '?dryRun=true' })), true), { ...ZERO, inserted: 1000 });
    assert.deepEqual((await run(rows(1001), { query: '?dryRun=true' })).body.error.details, [{ field: 'file', issue: 'tooMany' }]);
    assert.deepEqual(counts(await run([{ code: 'a', type: ids.plain }, { code: '', type: '' }, { code: 'b', type: ids.plain }], { path: importPath(0, 'x-rows-import') })), { ...ZERO, inserted: 2 });
  });
});

describe('cards workbook: the references of a group with a type or a collection that has no name', () => {
  it('writes such an id as it is, and does not match an empty name', async () => {
    await groups().updateOne({ _id: gid() }, { $push: { 'fidelity.cardsTypes': { id: 'TNONAME', status: true }, 'fidelity.pointsCollections': { id: 'PNONAME', status: true } } as Document });
    try {
      await seed({ code: 'NN-1', cardTypeId: 'TNONAME', balance: new Double(0), pointsCollections: { PNONAME: 2 } });
      const table = tableOf((await downloadWorkbook(world, `${exportPath()}?references=names`, sa())).bytes);
      assert.deepEqual(table.rows.map((row) => [row[1], row[3]]), [['TNONAME', 'PNONAME : 2']]);
      assert.deepEqual(problems(await run([{ code: 'NN-2', type: '' , points: ': 3' }])), ['Carte:2:TIPO (ID / NOME):required', 'Carte:2:PUNTI (ID / NOME : VALORE | ID / NOME : VALORE):invalidValue']);
    } finally {
      await groups().updateOne({ _id: gid() }, { $pull: { 'fidelity.cardsTypes': { id: 'TNONAME' }, 'fidelity.pointsCollections': { id: 'PNONAME' } } as Document });
    }
  });
});

describe('cards workbook: all or nothing', () => {
  it('counts up to a thousand problems, lists the first two hundred and says there are more', async () => {
    const reply = await untouched(() => run(Array.from({ length: 520 }, () => ({ code: randomBytes(2100).toString('hex') })), { query: '?dryRun=true' }));
    assert.equal(reply.status, 422, JSON.stringify(reply.body).slice(0, 300));
    assert.deepEqual([reply.body.error.rows.length, reply.body.error.errorCount, reply.body.error.moreErrors], [200, 1000, true]);
  });

  it('writes nothing, not even the cards and movements of the rows before, when one row is refused', async () => {
    const reply = await untouched(() => run([{ code: 'OK-1', type: ids.prepaid, balance: '5', points: 'Attiva : 5' }, { code: 'KO', type: 'Nessuna' }]));
    assert.deepEqual(problems(reply), ['Carte:3:TIPO (ID / NOME):notFoundReference']);
    assert.deepEqual(reply.body.error.rows[0].message, 'The reference matches nothing (neither an id nor a name)');
    assert.deepEqual(log('fidelityCards.imported').map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'rows', errors: 1 }]]);
    assert.deepEqual(world.office.activity.entries.map((entry) => entry.action), ['fidelityCards.imported']);
  });

  it('answers a dry run with the counts of the real one and writes nothing', async () => {
    await seed({ code: 'D-1', status: true });
    const rows = [{ code: 'D-1', type: ids.prepaid, enabled: '' }, { code: 'D-2', type: ids.prepaid, balance: '3' }];
    assert.deepEqual(counts(await untouched(() => run(rows, { query: '?dryRun=true' })), true), { ...ZERO, inserted: 1, updated: 1 });
    assert.deepEqual(world.office.activity.entries.map((entry) => [entry.action, entry.metadata]), [['fidelityCards.imported', { dryRun: true, inserted: 1, updated: 1, removed: 0, unchanged: 0 }]]);
    assert.deepEqual(counts(await run(rows)), { ...ZERO, inserted: 1, updated: 1 });
    assert.equal((await run(rows, { query: '?dryRun=maybe' })).status, 422);
  });

  it('creates the unique index on the code before the first import writes a card', async () => {
    await run([{ code: 'I-1', type: ids.plain }]);
    assert.ok((await cards().indexes()).some((index) => index.name === 'code_1' && index.unique === true));
  });

  it('refuses with 413 an import that takes longer than the deadline and writes nothing', async () => {
    const reply = await untouched(() => run([{ code: 'A', type: ids.plain }, { code: 'B', type: ids.plain }], { path: importPath(0, 'x-slow-import') }));
    assert.equal(reply.status, 413);
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'tooSlow' }]]);
  });
});

describe('cards workbook: the request', () => {
  it('is only for the PSA, the dealers and the group administrators (fidelity.r for the model and the export, fidelity.w for the import); a company or place administrator never, whatever the matrix; a store key is refused', async () => {
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { fidelity: { r: true, w: false } } }) });
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { fidelity: { r: false, w: false } } }) });
    assert.equal((await downloadWorkbook(world, exportPath(), reader.id)).status, 200);
    assert.equal((await downloadWorkbook(world, `${exportPath()}/template`, reader.id)).status, 200);
    assert.equal((await run([{ code: 'x', type: ids.plain }], { actor: reader.id })).status, 403);
    assert.equal((await downloadWorkbook(world, exportPath(), blind.id)).status, 403);
    assert.equal((await run([{ code: 'x', type: ids.plain }], { actor: blind.id })).status, 403);
    assert.equal((await world.office.call('GET', exportPath(), undefined)).status, 401);
    assert.equal((await world.office.call('POST', importPath(), undefined)).status, 401);
    assert.equal((await downloadWorkbook(world, exportPath(), world.office.cluster.dealerB)).status, 404);
    assert.equal((await run([{ code: 'x', type: ids.plain }], { actor: world.office.cluster.dealerB })).status, 404);
    assert.equal((await run([{ code: 'x', type: ids.plain }], { path: importPath(1) })).status, 404);
    const full = { fidelity: { r: true, w: true } };
    const users = ctx.databases.common().collection('users');
    await users.updateMany({ _id: { $in: [world.group(0).ca, world.group(0).pa] } }, { $set: { 'permissions.fidelity': full.fidelity } });
    for (const actor of [world.group(0).ca, world.group(0).pa]) {
      assert.equal((await downloadWorkbook(world, `${exportPath()}/template`, actor)).status, 403);
      assert.equal((await downloadWorkbook(world, exportPath(), actor)).status, 403);
      assert.equal((await run([{ code: 'x', type: ids.plain }], { actor })).status, 403);
    }
    for (const actor of [psa(), world.office.cluster.dealerA]) {
      assert.equal((await downloadWorkbook(world, exportPath(), actor)).status, 200);
      assert.equal((await run([{ code: `di-${hex(actor)}`, type: ids.plain }], { actor })).status, 200);
    }
    const key = await world.activate(world.group(0).ownPlaceId);
    for (const [method, path] of [['GET', exportPath()], ['GET', `${exportPath()}/template`], ['POST', importPath()]] as const) {
      assert.equal((await world.asStore(key.key, method, path, undefined, { 'idempotency-key': randomUUID() })).status, 403, `${method} ${path}`);
    }
  });

  it('keeps the groups apart: the same code in two groups is two cards, and the import of one writes only in it', async () => {
    await cards(1).insertOne({ _id: new ObjectId(), code: 'SHARED', cardTypeId: 'other', status: true, balance: new Double(0), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    assert.deepEqual(counts(await run([{ code: 'SHARED', type: ids.plain }])), { ...ZERO, inserted: 1 });
    assert.deepEqual([await cards().countDocuments({}), await cards(1).countDocuments({}), (await cards(1).findOne({ code: 'SHARED' }))!['cardTypeId']], [1, 1, 'other']);
  });

  it('replays the answer for the same key and the same file, and refuses the same key with another file', async () => {
    const key = randomUUID();
    assert.deepEqual(counts(await run([{ code: 'K-1', type: ids.plain }], { key })), { ...ZERO, inserted: 1 });
    assert.deepEqual(counts(await run([{ code: 'K-1', type: ids.plain }], { key })), { ...ZERO, inserted: 1 });
    assert.equal(await cards().countDocuments({}), 1);
    assert.equal((await run([{ code: 'K-2', type: ids.plain }], { key })).status, 409);
  });

  it('limits the real imports to six an hour for the user and the verifications to twenty, each in its own bucket', async () => {
    const bytes = await recordsWorkbook(CARDS_SHEET, [{ code: 'L-1', type: ids.plain }]);
    limiter.reset();
    const mark = limiter.calls.length;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await uploadWorkbook(world, `${importPath()}?dryRun=false`, bytes, sa())).status);
    }
    assert.deepEqual(statuses.map((status) => status === 429), [false, false, false, false, false, false, true].map((expected) => expected));
    await downloadWorkbook(world, exportPath(), sa());
    const bucket = (name: string) => limiter.calls.slice(mark).filter((entry) => entry.bucket === name);
    assert.deepEqual([bucket('fidelity-cards-import:user')[0]!.limit, bucket('fidelity-cards-export:user')[0]!.limit], [6, 30]);
    assert.equal((await uploadWorkbook(world, `${importPath()}?dryRun=true`, bytes, sa())).status, 200);
    assert.equal(bucket('fidelity-cards-import-dry-run:user')[0]!.limit, 20);
  });

  it('does not run two imports of a group at the same time, records the refusal, and is not blocked by the lock of the contacts', async () => {
    const path = importPath(0, 'x-held-import');
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    hold = { started, released: new Promise<void>((resolve) => (release = resolve)) };
    const first = run([{ code: 'H-1', type: ids.plain }], { path });
    await running;
    const second = await run([{ code: 'H-2', type: ids.plain }], { path });
    assert.deepEqual([second.status, second.body.error.code], [409, 'CONFLICT']);
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'busy' }]]);
    release();
    assert.equal((await first).status, 200);
    await ctx.databases.common().collection('settings').insertOne({ key: `CONTACTS_LOCK:${hex(gid())}`, value: { owner: 'x', expiresAt: new Date(Date.now() + 60_000) }, updatedAt: new Date() });
    try {
      assert.equal((await run([{ code: 'H-3', type: ids.plain }])).status, 200, 'the lock of the contacts is another one');
    } finally {
      await ctx.databases.common().collection('settings').deleteOne({ key: `CONTACTS_LOCK:${hex(gid())}` });
    }
    assert.deepEqual((await cards().find({}).toArray()).map((card) => card['code']).sort(), ['H-1', 'H-3']);
  });
});

describe('cards workbook: the service called without a request', () => {
  const principal = () => principalOf('SA', { groupId: gid(), userId: sa() });
  const client = { requestId: 'req-1', ip: null, userAgent: null } as const;

  it('answers 503 and records the failure when the lock of the group cannot be taken', async () => {
    const access = (await accessFor(principal(), gid()))!;
    const service = serviceWith({ lock: { acquire: () => Promise.reject(new AppError('SERVICE_UNAVAILABLE')) } });
    await assert.rejects(service.import(principal(), access, await recordsWorkbook(CARDS_SHEET, [{ code: 'x', type: ids.plain }]), false, client), (error: AppError) => error.code === 'SERVICE_UNAVAILABLE');
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'error' }]]);
  });

  it('leaves the import valid when the entries of a committed import cannot be written, and breaks with the error of the database', async () => {
    const access = (await accessFor(principal(), gid()))!;
    const events = memoryLogger();
    const failing = serviceWith({ activityLog: { record: () => Promise.reject(new Error('the log is down')) }, logger: events.logger });
    const survived = await failing.import(principal(), access, await recordsWorkbook(CARDS_SHEET, [{ code: 'Z-1', type: ids.plain }]), false, client);
    assert.deepEqual(survived, { dryRun: false, sheets: { cards: { ...ZERO, inserted: 1 } } });
    assert.equal(events.events.length > 0, true);
    const broken = serviceWith({ databases: { ...ctx.databases, group: () => { throw new Error('database down'); } } });
    await assert.rejects(broken.import(principal(), access, await recordsWorkbook(CARDS_SHEET, [{ code: 'Z-2', type: ids.plain }]), false, client), /database down/);
    assert.deepEqual(audit.entries.at(-1)!.metadata, { dryRun: false, reason: 'error' });
  });
});
