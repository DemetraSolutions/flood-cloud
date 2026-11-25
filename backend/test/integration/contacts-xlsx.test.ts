import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { createCatalogXlsxController } from '../../src/modules/catalog-xlsx/catalog-xlsx.controller.ts';
import type { WorkbookService } from '../../src/modules/catalog-xlsx/catalog-xlsx.controller.ts';
import { createWorkbookRoutes } from '../../src/modules/catalog-xlsx/catalog-xlsx.routes.ts';
import { CONTACTS_SHEET, CONTACT_COLUMNS } from '../../src/modules/contacts-xlsx/contacts-xlsx.columns.ts';
import { createContactsXlsxService } from '../../src/modules/contacts-xlsx/contacts-xlsx.service.ts';
import type { ContactsXlsxDeps } from '../../src/modules/contacts-xlsx/contacts-xlsx.service.ts';
import { createCompaniesRepository } from '../../src/modules/companies/companies.repository.ts';
import { createCatalogsRepository } from '../../src/modules/groups/catalogs/catalogs.repository.ts';
import { createCatalogsService } from '../../src/modules/groups/catalogs/catalogs.service.ts';
import { createReferencesRepository } from '../../src/modules/groups/catalogs/references.repository.ts';
import { createTaxDepartments } from '../../src/modules/product-departments/product-departments.repository.ts';
import { createGate } from '../../src/modules/media/gate.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { createIdempotencyStore, idempotencyBodyKey } from '../../src/shared/http/idempotency.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';
import { readXlsxSheets } from '../../src/shared/xlsx/reader.ts';
import { restoreFormula } from '../../src/shared/xlsx/formula.ts';
import { memoryActivityLog, memoryRateLimiter } from '../helpers/activity.ts';
import { memoryLogger } from '../helpers/app.ts';
import { addUser } from '../helpers/backoffice.ts';
import { downloadWorkbook, uploadWorkbook } from '../helpers/catalog-xlsx.ts';
import { legacyCompany, legacyContact } from '../helpers/contacts.ts';
import { accessFor } from '../helpers/group-access.ts';
import { legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';
import { recordsWorkbook, writeBook } from '../helpers/records-xlsx.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';
import { readFile } from 'node:fs/promises';

/** The workbook of the contacts (step K3): every behaviour goes through `/v1/groups/{groupId}/contacts-import` and `contacts-export`, over a real MongoDB. */
let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const audit = memoryActivityLog();
const hex = (id: ObjectId) => id.toHexString();
const gid = () => world.group(0).groupId;
const sa = () => world.group(0).sa;
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const groups = () => ctx.databases.common().collection('groups');
const db = (name: string, index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0').collection(name);
const contacts = (index = 0) => db('contacts', index);
const importPath = (index = 0, segment = 'contacts-import') => `/groups/${hex(world.group(index).groupId)}/${segment}`;
const exportPath = (index = 0, segment = 'contacts-export') => `/groups/${hex(world.group(index).groupId)}/${segment}`;
const log = (action: string, mark = 0) => world.office.activity.entries.slice(mark).filter((entry) => entry.action === action);
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

type Reply = Awaited<ReturnType<typeof uploadWorkbook>>;
interface Options {
  readonly actor?: ObjectId;
  readonly query?: string;
  readonly path?: string;
  readonly key?: string;
  readonly headers?: readonly string[];
}
type Row = Record<string, string>;

/** Imports a workbook made of the given rows. */
async function run(rows: readonly Row[], options: Options = {}): Promise<Reply> {
  limiter.reset();
  return uploadWorkbook(world, `${options.path ?? importPath()}${options.query ?? ''}`, await recordsWorkbook(CONTACTS_SHEET, rows, options.headers), options.actor ?? sa(), options.key === undefined ? undefined : { 'idempotency-key': options.key });
}
/** Imports the bytes of a file as they are. */
async function runBytes(bytes: Buffer, options: Options = {}): Promise<Reply> {
  limiter.reset();
  return uploadWorkbook(world, `${options.path ?? importPath()}${options.query ?? ''}`, bytes, options.actor ?? sa(), options.key === undefined ? undefined : { 'idempotency-key': options.key });
}
/** The problems of a refused import as `sheet:row:column:code`. */
const problems = (reply: Reply): string[] => {
  assert.equal(reply.status, 422, JSON.stringify(reply.body));
  assert.equal(reply.body.error.code, 'VALIDATION_ERROR');
  return (reply.body.error.rows as Array<{ sheet: string; row: number | null; column: string | null; code: string }>).map((row) => `${row.sheet}:${row.row ?? '-'}:${row.column ?? '-'}:${row.code}`);
};
const ZERO = { inserted: 0, updated: 0, removed: 0, unchanged: 0 };
/** The counts of a successful import. */
const counts = (reply: Reply, dryRun = false) => {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.data.dryRun, dryRun);
  assert.deepEqual(Object.keys(reply.body.data.sheets), ['contacts']);
  return reply.body.data.sheets.contacts as typeof ZERO;
};
const seed = async (overrides: Document = {}, index = 0): Promise<ObjectId> => {
  const document = legacyContact(overrides);
  await contacts(index).insertOne(document);
  return document['_id'] as ObjectId;
};
const stored = (id: ObjectId, index = 0) => contacts(index).findOne({ _id: id }, { ...EXACT_TYPES });
const dump = async () => contacts().find({}, { ...EXACT_TYPES }).sort({ _id: 1 }).toArray();
const untouched = async (action: () => Promise<Reply>): Promise<Reply> => {
  const before = await dump();
  const reply = await action();
  assert.deepEqual(await dump(), before, 'the database is as it was');
  return reply;
};
const named = async (name: string) => contacts().find({ name }).toArray();
let listId = '';

/** The catalogs of the group, as the server builds them. */
const realCatalogs = () => createCatalogsService({ catalogs: createCatalogsRepository(ctx.databases), references: createReferencesRepository(ctx.databases), activityLog: audit, logger: memoryLogger().logger, newId: () => randomUUID(), now: Date.now, taxDepartments: createTaxDepartments(ctx.databases) });

/** The service of the workbook of the contacts over the test databases, with the limits and the clock a test injects. */
function serviceWith(overrides: Partial<ContactsXlsxDeps> = {}): WorkbookService {
  return createContactsXlsxService({
    databases: ctx.databases,
    catalogs: realCatalogs(),
    findCountry: (code) => createCompaniesRepository(ctx.databases, createCatalogsRepository(ctx.databases)).findCountry(code),
    rateLimiter: limiter,
    deleteRule: { bucket: 'contact-delete:user', limit: 60, windowSeconds: 3600, key: () => null },
    versionKey: Buffer.alloc(32, 1),
    activityLog: audit,
    logger: memoryLogger().logger,
    now: Date.now,
    ...overrides,
  });
}
/** A hold of an import: it stops in the middle (the first read of the catalogs, once the group is locked and the transaction open) until a test lets it go. */
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
/** The routes of a service under other segments (`<name>-export`, `<name>-import`). */
function routesOf(name: string, service: WorkbookService, gate?: ReturnType<typeof createGate>) {
  const idempotency = createIdempotencyStore(ctx.databases, idempotencyBodyKey(TEST_VERSION_KEY), Date.now);
  return createWorkbookRoutes({ exportSegment: `${name}-export`, importSegment: `${name}-import`, bucket: 'contacts', read: 'contacts:read', write: 'contacts:write' }, createCatalogXlsxController(service), idempotency, gate);
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
  await groups().updateOne({ _id: gid() }, { $set: { 'settings.services': true, 'priceLists.LA': { id: 'LA', name: 'Listino A', status: true, default: false }, 'priceLists.LD1': { id: 'LD1', name: 'Doppio', status: true, default: false }, 'priceLists.LD2': { id: 'LD2', name: 'Doppio', status: true, default: false }, 'priceLists.LX': { id: 'LX', name: 'Spento', status: false, default: false } } });
  listId = 'LA';
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
  await Promise.all([contacts().deleteMany({}), contacts(1).deleteMany({}), db('fidelity_cards').deleteMany({})]);
});

const LEGACY_HEADER =
  'ID;CODICE;LISTINO (ID / NOME);CLIENTE (X);FORNITORE (X);NOME;COGNOME;CF;NASCITA (AAAA/MM/GG);INDIRIZZO;CAP;CITTA;PROVINCIA (RM);NAZIONE (IT);TELEFONO;EMAIL;SCONTO %;NOME AZIENDA;PIVA;CF;INDIRIZZO;CAP;CITTA;PROVINCIA (RM);NAZIONE (IT);TELEFONO;EMAIL;FAX;SCONTO %;FIDELITY;TRASMISSIONE (FPR12 / FPA12);IDENTIFICATIVO (CD / PEC);CODICE DESTINATARIO;PEC;CANCELLAZIONE (X)'.split(';');

/** A sheet read back: its header and its rows (texts, formulas restored). */
function tableOf(bytes: Buffer): { header: string[]; rows: string[][]; raw: string[][] } {
  const sheets = readXlsxSheets(bytes, ['Contatti']);
  assert.deepEqual([...sheets.keys()], ['Contatti']);
  const [head, ...data] = sheets.get('Contatti')!.rows;
  const raw = data.map((row) => LEGACY_HEADER.map((_, index) => {
    const cell = row.cells[index] ?? '';
    assert.equal(typeof cell, 'string', 'every cell is a text');
    return cell as string;
  }));
  return { header: head!.cells.map(String), raw, rows: raw.map((row) => row.map(restoreFormula)) };
}
const col = (name: string, nth = 0): number => LEGACY_HEADER.map((header, index) => [header, index] as const).filter(([header]) => header === name)[nth]![1];

describe('contacts workbook: the model and the columns', () => {
  it('has one sheet with the 35 headers of the legacy CSV model, in the same order, and no row', async () => {
    const reply = await downloadWorkbook(world, `${exportPath()}/template`, sa());
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-disposition')!, /contacts-model\.xlsx/);
    const table = tableOf(reply.bytes);
    assert.deepEqual(table.header, LEGACY_HEADER);
    assert.equal(table.header.length, 35);
    assert.deepEqual(table.rows, []);
    assert.deepEqual(CONTACT_COLUMNS.map((column) => column.header), LEGACY_HEADER);
    const csv = await readFile('/Users/davidebausach/projects/flood/cloud-commerce-backoffice-client/src/src/resources/csv-models/contacts.csv', 'utf8').catch(() => null);
    if (csv !== null) {
      assert.deepEqual(csv.trim().split(';'), LEGACY_HEADER, 'the headers are the ones of the legacy file');
    }
  });
});

describe('contacts workbook: the export', () => {
  it('writes the contacts that are not in the trash by display name, one phone, e-mail and fax each, the codes of the cards without points, and nothing in the deletion column', async () => {
    await seed({ name: 'Zeta', surname: 'Verdi', birthDate: new Date('1975-03-09T00:00:00Z'), telephone: ['+39 111', '+39 222'], email: ['z@example.test', 'z2@example.test'], listId, fidelities: [{ code: 'C-1', points: 50 }, { code: 'C-2:9', points: 7 }], discount: new Double(12.5) });
    await seed({ name: '', surname: '', companyName: 'Acme Srl', companyCode: 'IT0123', companyCode2: 'ACMCF', companyFax: ['055 1', '055 2'], companyTelephone: ['02 1'], companyEmail: ['a@example.test'], companyDiscount: new Double(3), companyAddress: 'Via Azienda 2', companyPostcode: '50100', companyCity: 'Firenze', companyCountryCode: 'IT', companyCountryAreaCode: 'RM', supplier: true, customer: false, fidelities: [], fattura_elettronica: { formato_trasmissione: 'FPA12', identificativo: 'PEC', codice_destinatario: '', pec: 'acme@pec.test', condizioni_pagamento: '', modalita_pagamento: '', regime_fiscale: '', riferimento_amministrazione: '', split_payment: false, richiedi_dati_ordine_acquisto: false } });
    await seed({ name: 'Anna', surname: 'Bianchi', trash: true });
    await seed({ name: '=1+1', surname: 'Formula', fidelities: [] });
    const reply = await downloadWorkbook(world, exportPath(), sa());
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-disposition')!, /^attachment; filename="contacts_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    const table = tableOf(reply.bytes);
    assert.deepEqual(table.header, LEGACY_HEADER);
    assert.deepEqual(table.rows.map((row) => row[col('NOME')] + '|' + row[col('NOME AZIENDA')]), ['=1+1|', '|Acme Srl', 'Zeta|'], 'by display name; the contact in the trash is not there');
    assert.equal(table.raw[0]![col('NOME')], "'=1+1", 'a name that is a formula is neutralized in the file');
    const [formula, acme, zeta] = table.rows;
    assert.deepEqual([zeta![col('ID')]!.length, zeta![col('CODICE')], zeta![col('LISTINO (ID / NOME)')], zeta![col('CLIENTE (X)')], zeta![col('FORNITORE (X)')]], [24, 'K-1', 'LA', 'X', '']);
    assert.deepEqual([zeta![col('NASCITA (AAAA/MM/GG)')], zeta![col('TELEFONO')], zeta![col('EMAIL')], zeta![col('SCONTO %')], zeta![col('FIDELITY')], zeta![col('CANCELLAZIONE (X)')]], ['1975/03/09', '+39 111', 'z@example.test', '12.5', 'C-1 | C-2:9', '']);
    assert.deepEqual([zeta![col('INDIRIZZO')], zeta![col('CAP')], zeta![col('CITTA')], zeta![col('PROVINCIA (RM)')], zeta![col('NAZIONE (IT)')]], ['Via Roma 1', '20100', 'Milano', 'MI', 'IT']);
    assert.deepEqual([acme![col('PIVA')], acme![col('CF', 1)], acme![col('INDIRIZZO', 1)], acme![col('CAP', 1)], acme![col('CITTA', 1)], acme![col('PROVINCIA (RM)', 1)], acme![col('NAZIONE (IT)', 1)]], ['IT0123', 'ACMCF', 'Via Azienda 2', '50100', 'Firenze', 'RM', 'IT']);
    assert.deepEqual([acme![col('TELEFONO', 1)], acme![col('EMAIL', 1)], acme![col('FAX')], acme![col('SCONTO %', 1)], acme![col('TRASMISSIONE (FPR12 / FPA12)')], acme![col('IDENTIFICATIVO (CD / PEC)')], acme![col('PEC')], acme![col('FIDELITY')], acme![col('FORNITORE (X)')], acme![col('CLIENTE (X)')]], ['02 1', 'a@example.test', '055 1', '3', 'FPA12', 'PEC', 'acme@pec.test', '', 'X', '']);
    assert.equal(formula![col('NOME')], '=1+1');
    assert.ok(table.rows.every((row) => row[col('SCONTO %')] !== undefined));
    const entry = log('contacts.exported')[0]!;
    assert.deepEqual([entry.outcome, entry.metadata, entry.resource?.type], ['success', { references: 'ids', contacts: 3 }, 'contacts']);
    assert.ok(!JSON.stringify(entry).includes('Zeta') && !JSON.stringify(entry).includes('example.test'), 'no personal datum in the log');
  });

  it('writes the price list by its name when the references are names (the id when the list is gone), and the model of the legacy company of a contact that has nothing else', async () => {
    await seed({ listId, name: 'Uno', fidelities: [] });
    await seed({ listId: 'gone', name: 'Due', fidelities: [] });
    await seed({ listId: null, name: 'Tre', fidelities: [] });
    const byIds = tableOf((await downloadWorkbook(world, `${exportPath()}?references=ids`, sa())).bytes);
    assert.deepEqual(byIds.rows.map((row) => row[col('LISTINO (ID / NOME)')]), ['gone', '', 'LA']);
    const byNames = tableOf((await downloadWorkbook(world, `${exportPath()}?references=names`, sa())).bytes);
    assert.deepEqual(byNames.rows.map((row) => row[col('LISTINO (ID / NOME)')]), ['gone', '', 'Listino A']);
    assert.equal((await downloadWorkbook(world, `${exportPath()}?references=x`, sa())).status, 422);
    assert.equal((await downloadWorkbook(world, `${exportPath()}?foo=1`, sa())).status, 422);
  });

  it('pages through more contacts than a batch of 1000 and exports them all, and refuses more than the limit with 413 before the first byte', async () => {
    await contacts().insertMany(Array.from({ length: 1010 }, (_, index) => legacyContact({ name: `N${String(index).padStart(4, '0')}`, surname: 'X', fidelities: [] })));
    const table = tableOf((await downloadWorkbook(world, exportPath(), sa())).bytes);
    assert.equal(table.rows.length, 1010, 'more than a page of 1000');
    assert.deepEqual(table.rows.slice(0, 2).map((row) => row[col('NOME')]), ['N0000', 'N0001']);
    const refused = await downloadWorkbook(world, exportPath(0, 'x-small-export'), sa());
    assert.equal(refused.status, 413);
    assert.equal(JSON.parse(refused.bytes.toString()).error.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(log('contacts.exported').length, 1, 'only the export that was written is recorded');
  });

  it('records a failure when the client leaves before the file is complete, with what was written', async () => {
    await contacts().insertMany(Array.from({ length: 250 }, (_, index) => legacyContact({ name: `N${String(index).padStart(3, '0')}`, fidelities: [] })));
    const access = (await accessFor(principalOf('SA', { groupId: gid(), userId: sa() }), gid()))!;
    const principal = principalOf('SA', { groupId: gid(), userId: sa() });
    const file = await serviceWith().export(principal, access, 'ids', { requestId: 'r', ip: null, userAgent: null });
    await file.chunks.next();
    await file.chunks.return(undefined);
    const entry = audit.entries.at(-1)!;
    assert.deepEqual([entry.action, entry.outcome, entry.metadata?.['references']], ['contacts.exported', 'failure', 'ids']);
    assert.ok(!('ip' in entry));
  });
});

describe('contacts workbook: what a row means', () => {
  it('creates a contact from a row with every column and writes it the way the route does', async () => {
    const reply = await run([
      {
        code: 'K-9', priceList: 'Listino A', customer: 'X', supplier: 'x', firstName: 'Mario', lastName: 'Rossi', taxCode: 'rssmra80a01f205x', birthDate: '1980/01/31', street: 'Via Roma 1', postcode: '20100', city: 'Milano', area: 'mi', country: 'it', phone: '+39 02 1', email: 'mario@example.test', discount: '10,5',
        companyName: 'Acme Srl', vatNumber: 'it01234567890', companyTaxCode: 'acmcf', companyStreet: 'Via B 2', companyPostcode: '00100', companyCity: 'Roma', companyArea: 'RM', companyCountry: 'IT', companyPhone: '06 1', companyEmail: 'info@acme.test', fax: '06 2', companyDiscount: '5',
        fidelity: 'C-1 | C-2:150 | C-1 | C-3:7,5', transmission: 'fpa12', channel: 'pec', recipientCode: 'abcdefg', pec: 'acme@pec.test',
      },
    ]);
    assert.deepEqual(counts(reply), { ...ZERO, inserted: 1 });
    const [document] = await named('Mario');
    assert.deepEqual([document!['contactCode'], document!['listId'], document!['customer'], document!['supplier'], document!['surname'], document!['code'], document!['countryCode'], document!['countryAreaCode']], ['K-9', 'LA', true, true, 'Rossi', 'RSSMRA80A01F205X', 'IT', 'MI']);
    assert.deepEqual([document!['birthDate'], document!['telephone'], document!['email'], document!['discount']], [new Date('1980-01-31T00:00:00Z'), ['+39 02 1'], ['mario@example.test'], 10.5]);
    assert.deepEqual([document!['companyName'], document!['companyCode'], document!['companyCode2'], document!['companyCountryAreaCode'], document!['companyTelephone'], document!['companyEmail'], document!['companyFax'], document!['companyDiscount']], ['Acme Srl', 'IT01234567890', 'ACMCF', 'RM', ['06 1'], ['info@acme.test'], ['06 2'], 5]);
    assert.deepEqual(plain(document!['fidelities']), [{ code: 'C-1', points: 0 }, { code: 'C-2', points: 0 }, { code: 'C-3', points: 0 }], 'the points of the file are never written');
    assert.deepEqual(plain(document!['fattura_elettronica']), { formato_trasmissione: 'FPA12', identificativo: 'PEC', codice_destinatario: 'ABCDEFG', pec: 'acme@pec.test', condizioni_pagamento: '', modalita_pagamento: '', regime_fiscale: '', riferimento_amministrazione: '', split_payment: false, richiedi_dati_ordine_acquisto: false });
    assert.deepEqual([document!['trash'], document!['services']], [false, []]);
  });

  it('creates a contact with only a name, a company with only its name, and refuses a row with neither, naming both columns', async () => {
    assert.deepEqual(counts(await run([{ firstName: 'Solo' }, { companyName: 'Sola Srl' }])), { ...ZERO, inserted: 2 });
    const bad = await untouched(() => run([{ code: 'K-1' }, { firstName: 'Ok' }]));
    assert.deepEqual(problems(bad), ['Contatti:2:NOME:invalid', 'Contatti:2:NOME AZIENDA:invalid']);
    assert.match(bad.body.error.rows[0].message, /person\.firstName: required/);
    assert.equal(await contacts().countDocuments({ name: 'Ok' }), 0);
  });

  it('changes only the columns of the sheet: a column that is absent leaves the data, one that is present writes it, an empty cell too', async () => {
    const id = await seed({ name: 'Mario', surname: 'Rossi', note: 'nota' });
    const before = (await stored(id))!;
    assert.deepEqual(counts(await run([{ id: hex(id), lastName: 'Bianchi' }])), { ...ZERO, updated: 1 });
    const after = (await stored(id))!;
    assert.deepEqual([after['surname'], after['name'], after['code'], after['telephone'], after['email'], after['note'], after['countryCode']], ['Bianchi', 'Mario', 'RSSMRA80A01F205X', ['+39 02 123456'], ['mario@example.test'], 'nota', 'IT']);
    assert.deepEqual(plain(after['fidelities']), plain(before['fidelities']));
    assert.deepEqual(counts(await run([{ id: hex(id), code: '', taxCode: '', birthDate: '', city: '', area: '', country: '', discount: '', customer: '' }])), { ...ZERO, updated: 1 });
    const cleared = (await stored(id))!;
    assert.deepEqual([cleared['contactCode'], cleared['code'], cleared['birthDate'], cleared['city'], cleared['countryAreaCode'], cleared['countryCode'], cleared['discount'], cleared['customer']], ['', '', null, '', '', '', null, false]);
    assert.deepEqual([cleared['name'], cleared['surname']], ['Mario', 'Bianchi']);
  });

  it('counts a row that says what is stored as unchanged, writes nothing and keeps the version', async () => {
    const id = await seed({});
    const before = (await stored(id))!;
    const exported = tableOf((await downloadWorkbook(world, exportPath(), sa())).bytes);
    assert.equal(exported.rows.length, 1);
    const again = await runBytes(await writeBook([{ name: 'Contatti', columns: LEGACY_HEADER, rows: exported.rows }]));
    assert.deepEqual(counts(again), { ...ZERO, unchanged: 1 });
    assert.deepEqual(await stored(id), before, 'the exported file imported back changes nothing');
    assert.deepEqual(counts(await run([{ id: hex(id) }])), { ...ZERO, unchanged: 1 }, 'a row with an id and nothing else');
  });

  it('replaces the first phone, e-mail and fax and keeps the others; an empty cell takes the first away; a value the list has moves to the first place', async () => {
    const id = await seed({ telephone: ['1', '2', '3'], email: ['a@example.test', 'b@example.test'], companyFax: ['f1', 'f2'], companyTelephone: ['c1'], companyEmail: [] });
    assert.deepEqual(counts(await run([{ id: hex(id), phone: '9', email: 'new@example.test', fax: 'f9', companyPhone: '', companyEmail: 'c@example.test' }], { headers: ['companyName'] })), { ...ZERO, updated: 1 });
    let document = (await stored(id))!;
    assert.deepEqual([document['telephone'], document['email'], document['companyFax'], document['companyTelephone'], document['companyEmail']], [['9', '2', '3'], ['new@example.test', 'b@example.test'], ['f9', 'f2'], [], ['c@example.test']]);
    assert.deepEqual(counts(await run([{ id: hex(id), phone: '3', email: '' }])), { ...ZERO, updated: 1 });
    document = (await stored(id))!;
    assert.deepEqual([document['telephone'], document['email']], [['3', '2'], ['b@example.test']]);
    assert.deepEqual(counts(await run([{ id: hex(id), phone: '3' }])), { ...ZERO, unchanged: 1 });
  });

  it('manages the codes of the cards without ever writing points: adds, removes and keeps the balance of the ones that stay, in the legacy form too', async () => {
    const id = await seed({ fidelities: [{ code: 'KEEP', points: 120 }, { code: 'DROP', points: 5 }] });
    assert.deepEqual(counts(await run([{ id: hex(id), fidelity: 'KEEP:999 | NEW:1' }])), { ...ZERO, updated: 1 });
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'KEEP', points: 120 }, { code: 'NEW', points: 0 }]);
    assert.deepEqual(counts(await run([{ id: hex(id), fidelity: 'KEEP | NEW' }])), { ...ZERO, unchanged: 1 });
    assert.deepEqual(counts(await run([{ id: hex(id), fidelity: '' }])), { ...ZERO, updated: 1 });
    assert.deepEqual((await stored(id))!['fidelities'], []);
  });

  it('takes the code of a card that is an advanced one as any other, and leaves the points and the credit of the card alone', async () => {
    await db('fidelity_cards').insertOne({ _id: new ObjectId(), code: 'ADV-1', cardTypeId: 'T', status: true, balance: new Double(10), pointsCollections: { P: 40 }, insertDate: new Date(), updateDate: new Date() });
    const reply = await run([{ firstName: 'Con carta', fidelity: 'ADV-1:30' }]);
    assert.deepEqual(counts(reply), { ...ZERO, inserted: 1 });
    assert.deepEqual(plain((await named('Con carta'))[0]!['fidelities']), [{ code: 'ADV-1', points: 0 }]);
    const card = (await db('fidelity_cards').findOne({ code: 'ADV-1' }))!;
    assert.deepEqual([card['balance'], card['pointsCollections']], [10, { P: 40 }]);
  });

  it('sends a contact to the trash with an X and an id, never deleting it, and ignores the other cells of that row', async () => {
    const id = await seed({});
    const other = await seed({ name: 'Altro' });
    assert.deepEqual(counts(await run([{ id: hex(id), delete: 'X', firstName: 'Ignorato' }, { id: hex(other), firstName: 'Altro', delete: '' }])), { ...ZERO, removed: 1, unchanged: 1 });
    const trashed = (await stored(id))!;
    assert.deepEqual([trashed['trash'], trashed['name'], trashed['trashDate'] instanceof Date], [true, 'Mario', true]);
    assert.equal(await contacts().countDocuments({}), 2);
    assert.deepEqual(log('contact.trashed').length, 1);
  });

  it('takes a price list by id first, then by its exact name, and an empty cell takes it away', async () => {
    const id = await seed({ listId: null });
    assert.deepEqual(counts(await run([{ id: hex(id), priceList: 'LA' }])), { ...ZERO, updated: 1 });
    assert.equal((await stored(id))!['listId'], 'LA');
    assert.deepEqual(counts(await run([{ id: hex(id), priceList: '' }])), { ...ZERO, updated: 1 });
    assert.equal((await stored(id))!['listId'], null);
    assert.deepEqual(counts(await run([{ id: hex(id), priceList: ' Listino A ' }])), { ...ZERO, updated: 1 });
    assert.equal((await stored(id))!['listId'], 'LA');
    const bad = await untouched(() => run([{ firstName: 'a', priceList: 'Nessuno' }, { firstName: 'b', priceList: 'Doppio' }, { firstName: 'c', priceList: 'LX' }, { firstName: 'd', priceList: 'listino a' }]));
    assert.deepEqual(problems(bad), ['Contatti:2:LISTINO (ID / NOME):notFoundReference', 'Contatti:3:LISTINO (ID / NOME):ambiguousName', 'Contatti:4:LISTINO (ID / NOME):invalid', 'Contatti:5:LISTINO (ID / NOME):notFoundReference']);
  });

  it('reads the date of birth as AAAA/MM/GG or AAAA-MM-GG, and as the serial number a spreadsheet makes of the text of a legacy file', async () => {
    const reply = await run([{ firstName: 'A', birthDate: '1980/01/31' }, { firstName: 'B', birthDate: '1981-02-01' }, { firstName: 'C', birthDate: '29221' }]);
    assert.deepEqual(counts(reply), { ...ZERO, inserted: 3 });
    assert.deepEqual((await contacts().find({ name: { $in: ['A', 'B', 'C'] } }).sort({ name: 1 }).toArray()).map((document) => (document['birthDate'] as Date).toISOString().slice(0, 10)), ['1980-01-31', '1981-02-01', '1980-01-01']);
    const bad = await untouched(() => run([{ firstName: 'D', birthDate: '31/01/1980' }, { firstName: 'E', birthDate: '1980/02/30' }, { firstName: 'F', birthDate: '123' }, { firstName: 'G', birthDate: '99999999' }]));
    assert.deepEqual(problems(bad), ['Contatti:2:NASCITA (AAAA/MM/GG):invalidValue', 'Contatti:3:NASCITA (AAAA/MM/GG):invalid', 'Contatti:4:NASCITA (AAAA/MM/GG):invalidValue', 'Contatti:5:NASCITA (AAAA/MM/GG):invalidValue']);
  });

  it('refuses what the routes refuse, as a problem of the cell: flags, percentages, countries, provinces, e-mails, e-invoice, codes of cards', async () => {
    const bad = await untouched(() =>
      run([
        { firstName: 'a', customer: 'si' },
        { firstName: 'b', supplier: '1' },
        { firstName: 'c', discount: 'molto' },
        { firstName: 'd', discount: '101' },
        { firstName: 'e', companyDiscount: '1,234' },
        { firstName: 'f', country: 'ZZ' },
        { firstName: 'g', country: 'IT', area: 'XX' },
        { firstName: 'h', area: 'MI' },
        { firstName: 'i', email: 'non-una-mail' },
        { firstName: 'j', transmission: 'FPX12' },
        { firstName: 'k', channel: 'POSTA' },
        { firstName: 'l', recipientCode: 'TROPPO-LUNGO-PER-UN-CODICE' },
        { firstName: 'm', pec: 'no' },
        { firstName: 'n', fidelity: `${'C'.repeat(65)}` },
        { firstName: 'o', code: 'x'.repeat(65) },
        { firstName: 'p', fidelity: '..' },
        { firstName: 'q', companyEmail: 'no', fax: 'y'.repeat(70) },
      ], { headers: ['companyName'] }),
    );
    assert.deepEqual(problems(bad), [
      'Contatti:2:CLIENTE (X):invalidValue',
      'Contatti:3:FORNITORE (X):invalidValue',
      'Contatti:4:SCONTO %:invalidValue',
      'Contatti:5:SCONTO %:invalid',
      'Contatti:6:SCONTO %:invalid',
      'Contatti:7:NAZIONE (IT):invalid',
      'Contatti:8:PROVINCIA (RM):invalid',
      'Contatti:9:PROVINCIA (RM):invalid',
      'Contatti:10:EMAIL:invalid',
      'Contatti:11:TRASMISSIONE (FPR12 / FPA12):invalidValue',
      'Contatti:12:IDENTIFICATIVO (CD / PEC):invalidValue',
      'Contatti:13:CODICE DESTINATARIO:invalid',
      'Contatti:14:PEC:invalid',
      'Contatti:15:FIDELITY:invalid',
      'Contatti:16:CODICE:invalid',
      'Contatti:17:FIDELITY:invalid',
      'Contatti:18:EMAIL:invalid',
      'Contatti:18:FAX:invalid',
    ]);
  });

  it('leaves the format and the channel of the e-invoice alone when the cell is empty', async () => {
    const id = await seed({ fattura_elettronica: { formato_trasmissione: 'FPA12', identificativo: 'PEC', codice_destinatario: '', pec: 'x@pec.test', condizioni_pagamento: '', modalita_pagamento: '', regime_fiscale: '', riferimento_amministrazione: '', split_payment: false, richiedi_dati_ordine_acquisto: false } });
    assert.deepEqual(counts(await run([{ id: hex(id), transmission: '', channel: '', pec: '' }])), { ...ZERO, updated: 1 });
    const document = (await stored(id))!;
    assert.deepEqual([document['fattura_elettronica'].formato_trasmissione, document['fattura_elettronica'].identificativo, document['fattura_elettronica'].pec], ['FPA12', 'PEC', '']);
  });
});

describe('contacts workbook: the separators of the column of the cards', () => {
  it('takes a code that has a colon and digits as it is when the contact or an advanced card has it, so it goes round the export and the import with its points kept', async () => {
    const id = await seed({ fidelities: [{ code: 'AB:12', points: 7 }, { code: 'PLAIN', points: 3 }] });
    await db('fidelity_cards').insertOne({ _id: new ObjectId(), code: 'ADV:3', cardTypeId: 'T', status: true, balance: new Double(1), pointsCollections: {}, insertDate: new Date(), updateDate: new Date() });
    const table = tableOf((await downloadWorkbook(world, exportPath(), sa())).bytes);
    assert.equal(table.rows[0]![col('FIDELITY')], 'AB:12 | PLAIN');
    assert.deepEqual(counts(await runBytes(await writeBook([{ name: 'Contatti', columns: LEGACY_HEADER, rows: table.rows }]))), { ...ZERO, unchanged: 1 });
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'AB:12', points: 7 }, { code: 'PLAIN', points: 3 }]);
    assert.deepEqual(counts(await run([{ id: hex(id), firstName: 'Mario', fidelity: 'AB:12 | PLAIN:99 | ADV:3 | NEW:5' }])), { ...ZERO, updated: 1 });
    assert.deepEqual(plain((await stored(id))!['fidelities']), [{ code: 'AB:12', points: 7 }, { code: 'PLAIN', points: 3 }, { code: 'ADV:3', points: 0 }, { code: 'NEW', points: 0 }]);
  });

  it('refuses a new card code with a bar in it, in a contact and in a card, and still reaches a legacy code that has one by its path', async () => {
    const contact = await call(sa(), 'POST', `/groups/${hex(gid())}/contacts`, { person: { firstName: 'x' }, fidelityCards: [{ code: 'A|B' }] }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([contact.status, contact.body.error.details], [422, [{ field: 'fidelityCards.0.code', issue: 'format' }]]);
    const card = await call(sa(), 'POST', `/groups/${hex(gid())}/fidelity-cards`, { code: 'A|B', cardTypeId: 'x' }, { 'idempotency-key': randomUUID() });
    assert.deepEqual([card.status, card.body.error.details], [422, [{ field: 'code', issue: 'format' }]]);
    const id = await seed({ fidelities: [{ code: 'OLD|1', points: 4 }] });
    const adjusted = await call(sa(), 'POST', `/groups/${hex(gid())}/contacts/${hex(id)}/fidelity-cards/${encodeURIComponent('OLD|1')}/points-adjustments`, { delta: 1 }, { 'idempotency-key': randomUUID() });
    assert.equal(adjusted.status, 200);
  });
});

describe('contacts workbook: which contact a row is', () => {
  it('inserts a row with no id and updates one with an id in any case, and refuses an id that is not one, that comes twice, that matches nothing or is in the trash', async () => {
    const id = await seed({});
    const gone = await seed({ name: 'Cestino', trash: true });
    assert.deepEqual(counts(await run([{ id: hex(id).toUpperCase(), firstName: 'Maiuscolo' }, { firstName: 'Nuovo' }])), { ...ZERO, inserted: 1, updated: 1 });
    const bad = await untouched(() => run([{ id: 'abc', firstName: 'x' }, { id: hex(id), firstName: 'y' }, { id: hex(id), firstName: 'z' }, { id: hex(new ObjectId()), firstName: 'w' }, { id: hex(gone), firstName: 'v' }]));
    assert.deepEqual(problems(bad), ['Contatti:2:ID:invalidId', 'Contatti:4:ID:duplicateId', 'Contatti:5:ID:notFound', 'Contatti:6:ID:trashed']);
  });

  it('refuses a deletion with no id and a mark that is not an X, and reads an X in any case', async () => {
    const id = await seed({});
    const bad = await untouched(() => run([{ delete: 'X', firstName: 'x' }, { id: hex(id), delete: 'si' }]));
    assert.deepEqual(problems(bad), ['Contatti:2:CANCELLAZIONE (X):deleteWithoutId', 'Contatti:3:CANCELLAZIONE (X):invalidValue']);
    assert.deepEqual(counts(await run([{ id: hex(id), delete: 'x' }])), { ...ZERO, removed: 1 });
  });

  it('does not reach the contacts of another group: an id of another group is not found, and the import of a group writes only in it', async () => {
    const foreign = await seed({ name: 'Altro gruppo' }, 1);
    const own = await seed({});
    assert.deepEqual(problems(await untouched(() => run([{ id: hex(foreign), firstName: 'Rubato' }]))), ['Contatti:2:ID:notFound']);
    assert.deepEqual(counts(await run([{ id: hex(own), firstName: 'Mio' }, { firstName: 'Nuovo' }])), { ...ZERO, inserted: 1, updated: 1 });
    assert.equal((await stored(foreign, 1))!['name'], 'Altro gruppo');
    assert.equal(await contacts(1).countDocuments({}), 1);
    assert.deepEqual(counts(await run([{ firstName: 'Del secondo' }], { path: importPath(1), actor: world.group(1).sa })), { ...ZERO, inserted: 1 });
    assert.equal(await contacts().countDocuments({ name: 'Del secondo' }), 0);
  });
});

describe('contacts workbook: a legacy file converted to XLSX', () => {
  const legacyRow = (values: Record<number, string>): string[] => LEGACY_HEADER.map((_, index) => values[index] ?? '');

  it('reads the headers that repeat the company block after NOME AZIENDA, as the model has them', async () => {
    const row = legacyRow({ 1: 'K-L', 5: 'Luigi', 6: 'Verdi', 7: 'vrdlgu70a01h501x', 9: 'Via P', 10: '10100', 11: 'Torino', 12: 'MI', 13: 'IT', 14: '011 1', 15: 'l@example.test', 16: '2', 17: 'Verdi Srl', 18: 'IT999', 19: 'VRDCF', 20: 'Via C', 21: '20200', 22: 'Milano', 23: 'RM', 24: 'IT', 25: '02 9', 26: 'v@example.test', 27: '02 8', 28: '7', 29: 'LEG-1:10 | LEG-2:20' });
    assert.deepEqual(counts(await runBytes(await writeBook([{ name: 'Contatti', columns: LEGACY_HEADER, rows: [row] }]))), { ...ZERO, inserted: 1 });
    const [document] = await named('Luigi');
    assert.deepEqual([document!['code'], document!['companyCode2'], document!['address'], document!['companyAddress'], document!['countryAreaCode'], document!['companyCountryAreaCode'], document!['telephone'], document!['companyTelephone'], document!['email'], document!['companyEmail'], document!['companyFax'], document!['discount'], document!['companyDiscount']], ['VRDLGU70A01H501X', 'VRDCF', 'Via P', 'Via C', 'MI', 'RM', ['011 1'], ['02 9'], ['l@example.test'], ['v@example.test'], ['02 8'], 2, 7]);
    assert.deepEqual(plain(document!['fidelities']), [{ code: 'LEG-1', points: 0 }, { code: 'LEG-2', points: 0 }]);
  });

  it('reads a header that repeats before NOME AZIENDA as the person and, without a NOME AZIENDA column, takes the second one for a problem', async () => {
    const personOnly = LEGACY_HEADER.slice(0, 17);
    assert.deepEqual(counts(await runBytes(await writeBook([{ name: 'Contatti', columns: personOnly, rows: [personOnly.map((header) => (header === 'NOME' ? 'Solo persona' : ''))] }]))), { ...ZERO, inserted: 1 });
    const twice = [...personOnly, 'CF'];
    assert.deepEqual(problems(await untouched(async () => runBytes(await writeBook([{ name: 'Contatti', columns: twice, rows: [twice.map((header) => (header === 'NOME' ? 'x' : ''))] }])))), ['Contatti:-:CF:duplicateColumn']);
    const companyOnly = ['NOME AZIENDA', 'PIVA', 'CF', 'FAX'];
    assert.deepEqual(counts(await runBytes(await writeBook([{ name: 'Contatti', columns: companyOnly, rows: [['Solo Azienda', 'IT1', 'AZCF', '1']] }]))), { ...ZERO, inserted: 1 });
    const [company] = await contacts().find({ companyName: 'Solo Azienda' }).toArray();
    assert.deepEqual([company!['companyCode2'], company!['code']], ['AZCF', '']);
  });

  it('recognizes the headers in any order, in any case and with extra spaces, ignores a column with no header, and refuses a column that is not of the sheet or that comes twice', async () => {
    assert.deepEqual(counts(await runBytes(await writeBook([{ name: 'Contatti', columns: [' cognome ', 'nome', '', 'Listino (id/nome)'], rows: [['Bruni', 'Carlo', 'ignorato', 'LA']] }]))), { ...ZERO, inserted: 1 });
    const [document] = await named('Carlo');
    assert.deepEqual([document!['surname'], document!['listId']], ['Bruni', 'LA']);
    const bad = await untouched(async () => runBytes(await writeBook([{ name: 'Contatti', columns: ['NOME', 'Colonna ‮ strana', 'NOME', 'ID', 'ID'], rows: [['x', 'y', 'z', '', '']] }])));
    assert.deepEqual(problems(bad), ['Contatti:-:Colonna   strana:unknownColumn', 'Contatti:-:NOME:duplicateColumn', 'Contatti:-:ID:duplicateColumn']);
  });
});

describe('contacts workbook: all or nothing', () => {
  it('writes nothing when one row of a file of good ones is not valid, and lists every problem with its row, column and a fixed message', async () => {
    const id = await seed({});
    const reply = await untouched(() => run([{ firstName: 'Uno' }, { id: hex(id), firstName: 'Mario', lastName: 'Cambiato' }, { firstName: 'Tre', customer: 'no' }, { id: 'x', firstName: 'Quattro' }]));
    assert.deepEqual(problems(reply), ['Contatti:4:CLIENTE (X):invalidValue', 'Contatti:5:ID:invalidId']);
    assert.deepEqual(reply.body.error.rows.map((row: { message: string }) => row.message), ['The value is not valid', 'The id is not valid']);
    assert.deepEqual([reply.body.error.errorCount, reply.body.error.moreErrors], [2, false]);
    assert.deepEqual(reply.body.error.details[0], { field: 'Contatti!4!CLIENTE (X)', issue: 'invalidValue' });
    assert.deepEqual(log('contacts.imported').map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'rows', errors: 2 }]]);
    assert.deepEqual(world.office.activity.entries.map((entry) => entry.action), ['contacts.imported'], 'nothing else: the changes of a refused file never happened');
  });

  it('counts up to a thousand problems, lists the first two hundred and says there are more', async () => {
    await contacts().deleteMany({});
    const rows = Array.from({ length: 600 }, () => ({ code: 'K' }));
    const reply = await untouched(() => run(rows, { query: '?dryRun=true' }));
    assert.equal(reply.status, 422);
    assert.deepEqual([reply.body.error.rows.length, reply.body.error.errorCount, reply.body.error.moreErrors], [200, 1000, true]);
  });

  it('answers a dry run with the counts of the real one and writes nothing; a dry run of a file with problems is refused like the real one', async () => {
    const id = await seed({});
    const rows = [{ firstName: 'Nuovo' }, { id: hex(id), firstName: 'Cambiato' }];
    const mark = world.office.activity.entries.length;
    assert.deepEqual(counts(await untouched(() => run(rows, { query: '?dryRun=true' })), true), { ...ZERO, inserted: 1, updated: 1 });
    assert.deepEqual(world.office.activity.entries.slice(mark).map((entry) => [entry.action, entry.metadata]), [['contacts.imported', { dryRun: true, inserted: 1, updated: 1, removed: 0, unchanged: 0 }]]);
    assert.equal((await untouched(() => run([{ code: 'K' }], { query: '?dryRun=true' }))).status, 422);
    assert.deepEqual(counts(await run(rows)), { ...ZERO, inserted: 1, updated: 1 });
    assert.equal((await run(rows, { query: '?dryRun=maybe' })).status, 422);
  });

  it('writes a trashed contact and the rest of the file in one go, and rolls back both when a later row is refused by the service', async () => {
    const id = await seed({});
    const reply = await untouched(() => run([{ id: hex(id), delete: 'X' }, { firstName: 'Buono' }, { firstName: 'Cattivo', country: 'ZZ' }]));
    assert.deepEqual(problems(reply), ['Contatti:4:NAZIONE (IT):invalid']);
    assert.equal((await stored(id))!['trash'], false);
  });

  it('allows a sheet 1000 rows, refuses more, and leaves out the rows with nothing in them', async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ firstName: `P${String(index)}` }));
    assert.deepEqual(counts(await untouched(() => run(rows(1000), { query: '?dryRun=true' })), true), { ...ZERO, inserted: 1000 });
    const reply = await run(rows(1001), { query: '?dryRun=true' });
    assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'tooMany' }]]);
    const small = await run([{ firstName: 'a' }, { firstName: 'b' }, { firstName: 'c' }, { firstName: 'd' }], { path: importPath(0, 'x-rows-import') });
    assert.deepEqual(small.body.error.details, [{ field: 'file', issue: 'tooMany' }]);
    const blanks = await run([{ firstName: 'a' }, { firstName: '' }, { firstName: ' ' }, { firstName: 'b' }, { firstName: '' }], { path: importPath(0, 'x-rows-import'), headers: ['firstName'] });
    assert.deepEqual(counts(blanks), { ...ZERO, inserted: 2 }, 'three rows of the file are blank: they do not count and are not read');
  });

  it('refuses with 413 an import that takes longer than the deadline and writes nothing', async () => {
    const reply = await untouched(() => run([{ firstName: 'A' }, { firstName: 'B' }], { path: importPath(0, 'x-slow-import') }));
    assert.equal(reply.status, 413);
    assert.deepEqual([reply.body.error.code, reply.body.error.message], ['PAYLOAD_TOO_LARGE', 'The import takes too long: split the file']);
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'tooSlow' }]]);
  });

  it('refuses a file that is not a workbook of the reader, one without the sheet, and one with the sheet and no rows (the model)', async () => {
    const mark = world.office.activity.entries.length;
    assert.equal((await runBytes(Buffer.from('PK\u0003\u0004 not really'))).status, 422);
    const wrongSheet = await runBytes(await writeBook([{ name: 'Altro', columns: ['NOME'], rows: [['x']] }]));
    assert.deepEqual([wrongSheet.status, wrongSheet.body.error.details], [422, [{ field: 'file', issue: 'incorrect' }]]);
    const model = await runBytes((await downloadWorkbook(world, `${exportPath()}/template`, sa())).bytes);
    assert.deepEqual([model.status, model.body.error.details], [422, [{ field: 'file', issue: 'incorrect' }]]);
    assert.deepEqual(world.office.activity.entries.slice(mark).map((entry) => entry.metadata), [{ dryRun: false, reason: 'file' }, { dryRun: false, reason: 'file' }, { dryRun: false, reason: 'file' }]);
  });

  it('takes a number and refuses a boolean or a very long text as a problem of the cell', async () => {
    const reply = await runBytes(await writeBook([{ name: 'Contatti', columns: ['NOME', 'CAP', 'CITTA'], rows: [['Numeri', '10100', 'x'.repeat(4001)]] }]));
    assert.deepEqual(problems(reply), ['Contatti:2:CITTA:invalidValue']);
  });
});

describe('contacts workbook: the request', () => {
  it('is only for the PSA, the dealers and the group administrators: contacts.r for the model and the export, contacts.w for the import; a company or place administrator never, whatever the matrix', async () => {
    const reader = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { contacts: { r: true, w: false } } }) });
    const blind = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules: { contacts: { r: false, w: false } } }) });
    assert.equal((await downloadWorkbook(world, exportPath(), reader.id)).status, 200);
    assert.equal((await downloadWorkbook(world, `${exportPath()}/template`, reader.id)).status, 200);
    assert.equal((await run([{ firstName: 'x' }], { actor: reader.id })).status, 403);
    assert.equal((await downloadWorkbook(world, exportPath(), blind.id)).status, 403);
    assert.equal((await downloadWorkbook(world, `${exportPath()}/template`, blind.id)).status, 403);
    assert.equal((await run([{ firstName: 'x' }], { actor: blind.id })).status, 403);
    assert.equal((await world.office.call('GET', exportPath(), undefined)).status, 401);
    assert.equal((await world.office.call('POST', importPath(), undefined)).status, 401);
    assert.equal((await downloadWorkbook(world, exportPath(0), world.office.cluster.dealerB)).status, 404);
    assert.equal((await run([{ firstName: 'x' }], { actor: world.office.cluster.dealerB })).status, 404);
    assert.equal((await run([{ firstName: 'x' }], { path: importPath(1) })).status, 404, 'the SA of a group is not the one of the other');
    const full = { contacts: { r: true, w: true } };
    await ctx.databases.common().collection('users').updateMany({ _id: { $in: [world.group(0).ca, world.group(0).pa] } }, { $set: { 'permissions.contacts': full.contacts } });
    for (const actor of [world.group(0).ca, world.group(0).pa]) {
      assert.equal((await downloadWorkbook(world, `${exportPath()}/template`, actor)).status, 403);
      assert.equal((await downloadWorkbook(world, exportPath(), actor)).status, 403);
      assert.equal((await run([{ firstName: 'x' }], { actor })).status, 403);
    }
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA]) {
      assert.equal((await downloadWorkbook(world, exportPath(), actor)).status, 200);
      assert.equal((await run([{ firstName: `di ${hex(actor)}` }], { actor })).status, 200);
    }
    assert.equal(await contacts().countDocuments({}), 2);
  });

  it('is not open to the key of a point of sale', async () => {
    const key = await world.activate(world.group(0).ownPlaceId);
    for (const [method, path] of [['GET', exportPath()], ['GET', `${exportPath()}/template`], ['POST', importPath()]] as const) {
      assert.equal((await world.asStore(key.key, method, path, undefined, { 'idempotency-key': randomUUID() })).status, 403, `${method} ${path}`);
    }
  });

  it('replays the answer for the same key and the same file, and refuses the same key with another file or another mode', async () => {
    const key = randomUUID();
    const first = await run([{ firstName: 'Una' }], { key });
    assert.deepEqual(counts(first), { ...ZERO, inserted: 1 });
    const again = await run([{ firstName: 'Una' }], { key });
    assert.deepEqual(counts(again), { ...ZERO, inserted: 1 });
    assert.equal(await contacts().countDocuments({}), 1, 'the replay writes nothing');
    assert.equal((await run([{ firstName: 'Altra' }], { key })).status, 409);
    assert.equal((await run([{ firstName: 'Una' }], { key, query: '?dryRun=true' })).status, 409);
  });

  it('limits the real imports to six an hour for the user and the verifications to twenty, the exports to five, each in its own bucket', async () => {
    const bytes = await recordsWorkbook(CONTACTS_SHEET, [{ firstName: 'Limite' }]);
    limiter.reset();
    const mark = limiter.calls.length;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await uploadWorkbook(world, `${importPath()}?dryRun=false`, bytes, sa())).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
    const dry: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      dry.push((await uploadWorkbook(world, `${importPath()}?dryRun=true`, bytes, sa())).status);
    }
    assert.deepEqual(dry, [...Array.from({ length: 20 }, () => 200), 429]);
    await downloadWorkbook(world, exportPath(), sa());
    const bucket = (name: string) => limiter.calls.slice(mark).filter((entry) => entry.bucket === name);
    assert.deepEqual([bucket('contacts-import:user')[0]!.limit, bucket('contacts-import:user')[0]!.key], [6, hex(sa())]);
    assert.deepEqual([bucket('contacts-import-dry-run:user')[0]!.limit, bucket('contacts-export:user')[0]!.limit], [20, 5]);
    const exports: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      exports.push((await downloadWorkbook(world, exportPath(), sa())).status);
    }
    assert.deepEqual(exports, [200, 200, 200, 200, 429], 'five exports an hour: the first one is above');
  });

  it('does not run two imports of a group at the same time, records the refusal, and frees the group when the first one ends', async () => {
    const path = importPath(0, 'x-held-import');
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    hold = { started, released: new Promise<void>((resolve) => (release = resolve)) };
    const first = run([{ firstName: 'Prima' }], { path });
    await running;
    const second = await run([{ firstName: 'Seconda' }], { path });
    assert.deepEqual([second.status, second.body.error.code, second.body.error.message], [409, 'CONFLICT', 'An import of this group is already running']);
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'busy' }]]);
    const otherGroup = await run([{ firstName: 'Altra' }], { path: importPath(1, 'x-held-import'), actor: world.group(1).sa });
    assert.equal(otherGroup.status, 200, 'another group is not held');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await run([{ firstName: 'Terza' }], { path })).status, 200);
  });

  it('is not blocked by the lock of the catalog of the group, which is another one', async () => {
    await ctx.databases.common().collection('settings').insertOne({ key: `CATALOG_LOCK:${hex(gid())}`, value: { owner: 'x', expiresAt: new Date(Date.now() + 60_000) }, updatedAt: new Date() });
    try {
      assert.equal((await run([{ firstName: 'Libero' }])).status, 200);
    } finally {
      await ctx.databases.common().collection('settings').deleteOne({ key: `CATALOG_LOCK:${hex(gid())}` });
    }
  });
});

describe('contacts workbook: the service called without a request', () => {
  const principal = () => principalOf('SA', { groupId: gid(), userId: sa() });
  const client = { requestId: 'req-1', ip: null, userAgent: null } as const;

  it('answers 503 and records the failure when the lock of the group cannot be taken', async () => {
    const access = (await accessFor(principal(), gid()))!;
    const service = serviceWith({ lock: { acquire: () => Promise.reject(new AppError('SERVICE_UNAVAILABLE')) } });
    await assert.rejects(service.import(principal(), access, await recordsWorkbook(CONTACTS_SHEET, [{ firstName: 'x' }]), false, client), (error: AppError) => error.code === 'SERVICE_UNAVAILABLE');
    assert.deepEqual(audit.entries.map((entry) => [entry.outcome, entry.metadata]), [['failure', { dryRun: false, reason: 'error' }]]);
  });

  it('records the import without an address when the request has none, and leaves the import valid when the entries of a committed import cannot be written', async () => {
    const access = (await accessFor(principal(), gid()))!;
    const outcome = await serviceWith().import(principal(), access, await recordsWorkbook(CONTACTS_SHEET, [{ firstName: 'Locale' }]), false, client);
    assert.deepEqual(outcome, { dryRun: false, sheets: { contacts: { ...ZERO, inserted: 1 } } });
    assert.deepEqual(audit.entries.map((entry) => [entry.action, 'ip' in entry]), [['contact.created', false], ['contacts.imported', false]]);
    const events = memoryLogger();
    const failing = serviceWith({ activityLog: { record: () => Promise.reject(new Error('the log is down')) }, logger: events.logger });
    const survived = await failing.import(principal(), access, await recordsWorkbook(CONTACTS_SHEET, [{ firstName: 'Sopravvive' }]), false, client);
    assert.deepEqual(survived, { dryRun: false, sheets: { contacts: { ...ZERO, inserted: 1 } } });
    assert.equal(await contacts().countDocuments({ name: 'Sopravvive' }), 1);
    assert.equal(events.events.length > 0, true, 'said in the log of the server');
  });
});

describe('contacts workbook: the activity log', () => {
  it('records the changes of the service as the routes do, after the commit and with the same request, then the summary with the counts and nothing of the file', async () => {
    const id = await seed({});
    const mark = world.office.activity.entries.length;
    assert.deepEqual(counts(await run([{ firstName: 'Segreto Nuovo', email: 'segreto@example.test' }, { id: hex(id), firstName: 'Mario', lastName: 'Cambiato', email: 'mario@example.test' }])), { ...ZERO, inserted: 1, updated: 1 });
    const entries = world.office.activity.entries.slice(mark);
    assert.deepEqual(entries.map((entry) => entry.action), ['contact.created', 'contact.updated', 'contacts.imported']);
    assert.equal(new Set(entries.map((entry) => entry.requestId)).size, 1, 'one request');
    const summary = entries.at(-1)!;
    assert.deepEqual([summary.outcome, summary.metadata, summary.resource?.type], ['success', { dryRun: false, inserted: 1, updated: 1, removed: 0, unchanged: 0 }, 'contacts']);
    assert.ok(!JSON.stringify(entries).includes('Segreto') && !JSON.stringify(entries).includes('segreto@example.test'), 'no personal datum in the log');
  });
});
