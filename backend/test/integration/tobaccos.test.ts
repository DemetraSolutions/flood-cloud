import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Decimal128, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { startBackoffice } from '../helpers/backoffice.ts';
import type { Backoffice } from '../helpers/backoffice.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { actors } from '../helpers/users.ts';
import type { Reply } from '../helpers/users.ts';
import { columnName, workbookOf, zipOf } from '../helpers/xlsx.ts';
import type { TestCell } from '../helpers/xlsx.ts';

let ctx: TestDatabases;
let office: Backoffice;
let as: ReturnType<typeof actors>;
const limiter = memoryRateLimiter();
const tobaccos = () => ctx.databases.common().collection('tobaccos');
const psa = () => office.cluster.psa;
const HEADER: TestCell[] = ['Categoria', 'Codice', 'Nome', 'Nome breve', 'Prezzo/kg', 'Prezzo', 'Peso', 'Pezzi', 'Descrizione'];

/** A valid row of the official file. */
const product = (n: number, extra: TestCell[] = []): TestCell[] => ['Sigarette', `C${String(n).padStart(4, '0')}`, `Prodotto ${String(n)}`, `P${String(n)}`, 100 + n, 5 + n / 10, 20, 20, `Descrizione ${String(n)}`, `800000000${String(1000 + n)}`, 10, ...extra];
const file = (...rows: TestCell[][]): Buffer => workbookOf([HEADER, ...rows]);

/** `POST /v1/tobaccos/import` as `actor` with a multipart body; the key and the headers can be replaced. */
async function importAs(actor: ObjectId, parts: Array<{ name: string; bytes: Buffer | string; filename?: string }>, headers: Record<string, string> = { 'idempotency-key': randomUUID() }, keepLimit = false): Promise<Reply<any>> {
  if (!keepLimit) {
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
  const response = await fetch(`${office.app.baseUrl}/v1/tobaccos/import`, { method: 'POST', headers: { ...office.userHeaders('POST', '/tobaccos/import', await as.tokenOf(actor)), ...headers }, body: form });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
}
const upload = (bytes: Buffer, headers?: Record<string, string>, actor = psa(), keepLimit = false) => importAs(actor, [{ name: 'file', bytes, filename: 'listino.xlsx' }], headers, keepLimit);
const stored = (): Promise<Document[]> => tobaccos().find({}).sort({ code: 1 }).toArray();
const codes = async (): Promise<string[]> => (await stored()).map((document) => document['code'] as string);

before(async () => {
  ctx = await openTestDatabases();
  office = await startBackoffice(ctx, { rateLimiter: limiter, env: { RATE_LIMIT_TOBACCOS_IMPORT_PER_USER: '6' } });
  as = actors(office);
});
after(async () => {
  await office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  await tobaccos().deleteMany({});
  office.activity.entries.length = 0;
});

describe('POST /v1/tobaccos/import', () => {
  it('replaces the whole list with the products of the file, in the documents of the legacy, and logs the counts only', async () => {
    await tobaccos().insertMany([{ code: 'OLD1', name: 'Vecchio 1' }, { code: 'OLD2', name: 'Vecchio 2' }]);
    const reply = await upload(file(product(1), product(2, ['8000000009999', 3]), ['Trinciati', 'T1', 'Trinciato', null, null, 12.5]));
    assert.equal(reply.status, 200);
    assert.deepEqual({ ...reply.body.data, elapsedMs: typeof reply.body.data.elapsedMs }, { inserted: 3, previous: 2, elapsedMs: 'number' });
    assert.deepEqual((await stored()).map(({ _id, ...rest }) => rest), [
      { category: 'Sigarette', code: 'C0001', name: 'Prodotto 1', shortName: 'P1', priceKg: 101, price: 5.1, unitWeight: 20, numPieces: 20, description: 'Descrizione 1', barcodes: [{ barcode: '8000000001001', quantity: 10 }] },
      {
        category: 'Sigarette',
        code: 'C0002',
        name: 'Prodotto 2',
        shortName: 'P2',
        priceKg: 102,
        price: 5.2,
        unitWeight: 20,
        numPieces: 20,
        description: 'Descrizione 2',
        barcodes: [
          { barcode: '8000000001002', quantity: 10 },
          { barcode: '8000000009999', quantity: 3 },
        ],
      },
      { category: 'Trinciati', code: 'T1', name: 'Trinciato', shortName: '', priceKg: null, price: 12.5, unitWeight: null, numPieces: null, description: '', barcodes: [] },
    ]);
    const entry = office.activity.entries.find((candidate) => candidate.action === 'tobaccos.imported')!;
    assert.deepEqual({ category: entry.category, outcome: entry.outcome, resource: entry.resource, metadata: entry.metadata, actorId: entry.actor.id?.toHexString() }, {
      category: 'data',
      outcome: 'success',
      resource: { type: 'tobaccos' },
      metadata: { inserted: 3, previous: 2 },
      actorId: psa().toHexString(),
    });
    assert.equal(entry.changes, undefined);
    assert.doesNotMatch(JSON.stringify(entry), /Prodotto|8000000/);
  });

  it('writes a list larger than one batch', async () => {
    const rows = Array.from({ length: 2500 }, (_row, index) => product(index + 1));
    const reply = await upload(workbookOf([HEADER, ...rows]));
    assert.deepEqual([reply.status, reply.body.data.inserted, await tobaccos().countDocuments()], [200, 2500, 2500]);
  });

  it('replays the answer for the same key and the same file, and refuses the same key with another file', async () => {
    const key = { 'idempotency-key': randomUUID() };
    const first = await upload(file(product(1)), key);
    const replay = await upload(file(product(1)), key);
    assert.deepEqual([replay.status, replay.body], [200, first.body]);
    assert.equal(office.activity.entries.filter((entry) => entry.action === 'tobaccos.imported').length, 1);
    const other = await upload(file(product(2)), key);
    assert.deepEqual([other.status, other.body.error.code, other.body.error.details], [409, 'CONFLICT', [{ field: 'Idempotency-Key', issue: 'reused' }]]);
    assert.deepEqual(await codes(), ['C0001']);
  });

  it('writes nothing when a single row is not valid: the old list stays, and every problem is reported with its row and field', async () => {
    await tobaccos().insertOne({ code: 'OLD', name: 'Vecchio' });
    const reply = await upload(file(product(1), product(2, [], ), ['Sigarette', 'C0001', 'Doppio', null, -5, 'abc'], product(4, ['12345'])));
    assert.equal(reply.status, 422);
    assert.equal(reply.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(reply.body.error.details, [
      { field: 'rows[4].code', issue: 'taken' },
      { field: 'rows[4].priceKg', issue: 'minimum' },
      { field: 'rows[4].price', issue: 'type' },
      { field: 'rows[5].barcodes[1].barcode', issue: 'format' },
    ]);
    assert.deepEqual(await codes(), ['OLD']);
    assert.equal(office.activity.entries.some((entry) => entry.action === 'tobaccos.imported' && entry.outcome === 'success'), false);
  });

  it('refuses a file with no product and leaves the list as it was', async () => {
    await tobaccos().insertOne({ code: 'OLD', name: 'Vecchio' });
    const reply = await upload(workbookOf([HEADER]));
    assert.deepEqual([reply.status, reply.body.error.details], [422, [{ field: 'file', issue: 'required' }]]);
    assert.deepEqual(await codes(), ['OLD']);
  });

  it('leaves the old list in place when the replacement fails half way (one transaction)', async () => {
    await tobaccos().insertMany([{ code: 'OLD1', name: 'Vecchio' }, { code: 'OLD2', name: 'Vecchio' }]);
    // The database refuses the second product after it deleted the old list and inserted the first (a validator on the collection): everything is rolled back.
    await ctx.databases.common().command({ collMod: 'tobaccos', validator: { name: { $ne: 'Rifiutato' } }, validationLevel: 'strict', validationAction: 'error' });
    try {
      const reply = await upload(file(product(1), ['Sigarette', 'C0002', 'Rifiutato']));
      assert.equal(reply.status, 500);
      assert.deepEqual(await codes(), ['OLD1', 'OLD2']);
    } finally {
      await ctx.databases.common().command({ collMod: 'tobaccos', validator: {}, validationLevel: 'off' });
    }
  });

  it('refuses a file that is not a workbook, with a fixed message that holds nothing of the file', async () => {
    const secret = 'SECRET-CONTENT-OF-THE-FILE';
    const cases: Array<[string, Buffer, string]> = [
      ['a ZIP with no workbook', zipOf([{ name: 'readme.txt', data: secret }]), 'The file does not contain a worksheet'],
      ['a damaged workbook', workbookOf([], { sheetXml: `<worksheet><${secret}>` }), 'The file is damaged or is not a valid XLSX workbook'],
      ['a DOCTYPE', workbookOf([], { sheetXml: `<!DOCTYPE x [<!ENTITY a "${secret}">]><worksheet/>` }), 'The file contains content that is not accepted'],
      ['a ZIP bomb', workbookOf([], { sheetXml: `<worksheet>${' '.repeat(4_000_000)}</worksheet>` }), 'The file exceeds the limits of an XLSX workbook'],
      ['a name that climbs out of the archive', zipOf([{ name: `../${secret}`, data: 'x' }]), 'The file contains content that is not accepted'],
      ['an encrypted archive', zipOf([{ name: 'a', data: secret, declared: { flags: 1 } }]), 'The file uses a feature of the XLSX format that is not supported'],
      ['a ZIP that ends nowhere', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)]), 'The file is not an XLSX workbook'],
    ];
    for (const [label, bytes, message] of cases) {
      const reply = await upload(bytes);
      assert.equal(reply.status, 422, label);
      assert.deepEqual([reply.body.error.code, reply.body.error.message, reply.body.error.details], ['VALIDATION_ERROR', message, [{ field: 'file', issue: 'incorrect' }]], label);
      assert.doesNotMatch(JSON.stringify(reply.body), new RegExp(secret), label);
    }
    assert.equal(await tobaccos().countDocuments(), 0);
  });

  it('refuses a request that is not a clean upload of one file, before anything is read or written', async () => {
    const good = file(product(1));
    const key = (): Record<string, string> => ({ 'idempotency-key': randomUUID() });
    // 422: no idempotency key, a key that is not a UUID, no file, a file in another field, two files, a text field.
    assert.deepEqual((await upload(good, {})).body.error.details, [{ field: 'Idempotency-Key', issue: 'required' }]);
    assert.deepEqual((await upload(good, { 'idempotency-key': 'abc' })).body.error.details, [{ field: 'Idempotency-Key', issue: 'format' }]);
    assert.deepEqual((await importAs(psa(), [], key())).body.error.details, [{ field: 'file', issue: 'required' }]);
    assert.deepEqual((await importAs(psa(), [{ name: 'other', bytes: good, filename: 'a.xlsx' }], key())).body.error.details, [{ field: 'file', issue: 'unknown' }]);
    assert.equal((await importAs(psa(), [{ name: 'file', bytes: good, filename: 'a.xlsx' }, { name: 'file', bytes: good, filename: 'b.xlsx' }], key())).status, 422);
    assert.equal((await importAs(psa(), [{ name: 'file', bytes: good, filename: 'a.xlsx' }, { name: 'note', bytes: 'x' }], key())).status, 422);
    // 415: not multipart, and a file that does not start like a ZIP archive whatever it is called.
    const json = await office.call('POST', '/tobaccos/import', await as.tokenOf(psa()), {}, key());
    assert.equal(json.status, 415);
    for (const bytes of [Buffer.from('%PDF-1.7 not a workbook'), Buffer.from('PK'), Buffer.alloc(0)]) {
      assert.equal((await upload(bytes)).status, 415);
    }
    // 413: more than 10 MB.
    assert.equal((await upload(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(10 * 1024 * 1024)]))).status, 413);
    // 400: a multipart header with a body that is not multipart.
    const broken = await fetch(`${office.app.baseUrl}/v1/tobaccos/import`, { method: 'POST', headers: { ...office.userHeaders('POST', '/tobaccos/import', await as.tokenOf(psa())), 'content-type': 'multipart/form-data; boundary=xyz', ...key() }, body: 'not a multipart body' });
    assert.equal(broken.status, 400);
    assert.equal(await tobaccos().countDocuments(), 0);
  });

  it('is for the PSA alone, and for an authenticated one', async () => {
    const good = file(product(1));
    const anonymous = await fetch(`${office.app.baseUrl}/v1/tobaccos/import`, { method: 'POST', headers: { 'idempotency-key': randomUUID() }, body: new FormData() });
    assert.equal(anonymous.status, 401);
    const { dealerA, groups } = office.cluster;
    for (const actor of [dealerA, groups[0]!.sa, groups[0]!.ca, groups[0]!.pa]) {
      const reply = await upload(good, undefined, actor);
      assert.deepEqual([reply.status, reply.body.error.code], [403, 'FORBIDDEN']);
    }
    assert.equal(await tobaccos().countDocuments(), 0);
    assert.equal(office.activity.entries.some((entry) => entry.action === 'tobaccos.imported'), false);
  });

  it('is limited per hour for the user', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const reply = await upload(file(product(1)), undefined, psa(), true);
      statuses.push(reply.status);
      if (reply.status === 429) {
        assert.equal(reply.body.error.code, 'RATE_LIMITED');
      }
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429, 429]);
    const call = limiter.calls.find((entry) => entry.bucket === 'tobaccos-import:user')!;
    assert.deepEqual([call.limit, call.key], [6, psa().toHexString()]);
  });
});

describe('POST /v1/tobaccos/import: hostile files and what is left of them', () => {
  it('refuses fast a file whose shared string of spaces is cited by thousands of cells (a regression of the amplification)', async () => {
    const cells = Array.from({ length: 29 }, (_cell, index) => `<c r="${columnName(index + 1)}ROW" t="s"><v>0</v></c>`).join('');
    const rows = Array.from({ length: 300 }, (_row, index) => `<row r="${index + 1}">${cells.replaceAll('ROW', String(index + 1))}</row>`).join('');
    const bytes = workbookOf([], {
      sharedXml: `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${' '.repeat(30_000)}</t></si></sst>`,
      sheetXml: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    });
    const started = Date.now();
    const reply = await upload(bytes);
    assert.deepEqual([reply.status, reply.body.error.code, reply.body.error.details], [422, 'VALIDATION_ERROR', [{ field: 'file', issue: 'incorrect' }]]);
    assert.ok(Date.now() - started < 2000, 'refused fast');
    assert.equal(await tobaccos().countDocuments(), 0);
  });

  it('leaves a trace of a refused file with its reason only', async () => {
    await upload(zipOf([{ name: 'a.txt', data: 'SECRET' }]));
    await upload(file(['Sigarette', 'C1', 'Uno', null, -1]));
    const failed = office.activity.entries.filter((entry) => entry.action === 'tobaccos.imported');
    assert.deepEqual(failed.map((entry) => [entry.outcome, entry.metadata]), [['failure', { reason: 'file' }], ['failure', { reason: 'rows' }]]);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET|Sigarette/);
  });

  it('is held by the whole ceiling of the PSA: with groups.w off in his own matrix he still imports (D-28)', async () => {
    await ctx.databases.common().collection('users').updateOne({ _id: psa() }, { $set: { 'permissions.groups.w': false, 'permissions.groups.r': false } });
    const fresh = await office.tokens((await import('../helpers/backoffice.ts')).userName(psa()));
    const call = (method: string, path: string) => office.call(method, path, fresh.accessToken);
    assert.equal((await call('GET', '/tobaccos')).status, 200);
    assert.equal((await upload(file(product(1)))).status, 200);
  });
});

/** The documents of the list tests, with the irregular values the legacy could have stored. */
const SEED: Document[] = [
  { code: 'A1', name: 'Alfa Rosso', category: 'Sigarette', priceKg: 90, price: 5.5, barcodes: [{ barcode: '8000000000003', quantity: 1 }, { barcode: '8000000000004', quantity: 2 }], unitWeight: 1, description: 'hidden' },
  { code: 'B2', name: 'Beta (blu) 100%', category: 'Sigarette', priceKg: 120.5, price: 6, barcodes: [{ barcode: '8000000000001', quantity: 1 }] },
  { code: 'C3', name: 'Charlie.Tabacco', category: 'Trinciati', priceKg: 20, price: 10, barcodes: [] },
  { code: 'D4', name: 'Delta', category: 'Trinciati', priceKg: NaN, price: 'text', barcodes: [{ quantity: 1 }] },
  { code: 'E5', name: 'Echo', category: '', priceKg: null },
  { code: 'F6', category: 5, name: 7, price: 6, barcodes: 'odd' },
];

describe('GET /v1/tobaccos', () => {
  beforeEach(async () => {
    await tobaccos().insertMany(SEED.map((document) => ({ ...document })));
  });
  const page = async (query: string, actor = psa()) => {
    const reply = await as.call(actor, 'GET', `/tobaccos${query}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply;
  };
  const codesOf = (reply: Reply<any>): string[] => reply.body.data.map((row: { code: string }) => row.code);

  it('lists the columns of the table, by code by default, and nothing else of a product', async () => {
    const reply = await page('');
    assert.deepEqual(codesOf(reply), ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']);
    assert.deepEqual(reply.body.data[0], { id: reply.body.data[0].id, code: 'A1', name: 'Alfa Rosso', shortName: '', category: 'Sigarette', priceKg: 90, price: 5.5, barcode: '8000000000003' });
    assert.match(reply.body.data[0].id, /^[0-9a-f]{24}$/);
    // The irregular values of the legacy are an empty text or no number.
    assert.deepEqual(reply.body.data.slice(2).map(({ id, ...row }: Document) => row), [
      { code: 'C3', name: 'Charlie.Tabacco', shortName: '', category: 'Trinciati', priceKg: 20, price: 10, barcode: null },
      { code: 'D4', name: 'Delta', shortName: '', category: 'Trinciati', priceKg: null, price: null, barcode: null },
      { code: 'E5', name: 'Echo', shortName: '', category: '', priceKg: null, price: null, barcode: null },
      { code: 'F6', name: '', shortName: '', category: '', priceKg: null, price: 6, barcode: null },
    ]);
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    assert.equal(JSON.stringify(reply.body).includes('hidden'), false);
  });

  it('sorts by every column of the legacy table, both ways', async () => {
    const order = async (sort: string) => codesOf(await page(`?sort=${encodeURIComponent(sort)}`));
    assert.deepEqual(await order('name'), ['F6', 'A1', 'B2', 'C3', 'D4', 'E5']);
    assert.deepEqual(await order('-name'), ['E5', 'D4', 'C3', 'B2', 'A1', 'F6']);
    assert.deepEqual(await order('category'), ['F6', 'E5', 'A1', 'B2', 'C3', 'D4']);
    assert.deepEqual(await order('price'), ['D4', 'E5', 'A1', 'B2', 'F6', 'C3']);
    assert.deepEqual(await order('-price'), ['C3', 'F6', 'B2', 'A1', 'E5', 'D4']);
    assert.deepEqual(await order('priceKg'), ['D4', 'E5', 'F6', 'C3', 'A1', 'B2']);
    assert.deepEqual(await order('barcode'), ['C3', 'D4', 'E5', 'F6', 'B2', 'A1']);
    assert.deepEqual(await order('-code'), ['F6', 'E5', 'D4', 'C3', 'B2', 'A1']);
  });

  it('walks every page of every sort once, with the cursor', async () => {
    for (const sort of ['code', '-code', 'name', '-name', 'category', 'price', '-price', 'priceKg', '-priceKg', 'barcode', '-barcode']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const reply = await page(`?limit=2&sort=${encodeURIComponent(sort)}${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...codesOf(reply));
        cursor = reply.body.page.next;
        if (cursor === null) {
          break;
        }
      }
      assert.deepEqual([...seen].sort(), ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'], sort);
    }
  });

  it('searches the name and the code as literal text, and filters by exact category', async () => {
    assert.deepEqual(codesOf(await page('?q=alfa')), ['A1']);
    assert.deepEqual(codesOf(await page('?q=c3')), ['C3']);
    assert.deepEqual(codesOf(await page(`?q=${encodeURIComponent('(blu)')}`)), ['B2']);
    assert.deepEqual(codesOf(await page(`?q=${encodeURIComponent('.')}`)), ['C3']);
    assert.deepEqual(codesOf(await page(`?q=${encodeURIComponent('.*')}`)), []);
    assert.deepEqual(codesOf(await page(`?q=${encodeURIComponent('100%')}`)), ['B2']);
    assert.deepEqual(codesOf(await page('?category=Trinciati')), ['C3', 'D4']);
    assert.deepEqual(codesOf(await page('?category=Trinciati&q=delta')), ['D4']);
    assert.deepEqual(codesOf(await page(`?category=${encodeURIComponent('Sigarette')}&limit=1`)), ['A1']);
    assert.deepEqual(codesOf(await page(`?category=${encodeURIComponent('{"$ne":""}')}`)), []);
  });

  it('refuses a bad query: unknown parameters, a page over 100, a sort that is not a column, a cursor it did not issue', async () => {
    const rejected = async (query: string) => as.failure(await as.call(psa(), 'GET', `/tobaccos${query}`));
    assert.deepEqual(await rejected('?other=1'), { status: 422, code: 'VALIDATION_ERROR', details: [{ field: 'other', issue: 'unknown' }] });
    assert.deepEqual((await rejected('?limit=101')).details, [{ field: 'limit', issue: 'maximum' }]);
    assert.deepEqual((await rejected('?limit=0')).details, [{ field: 'limit', issue: 'minimum' }]);
    assert.deepEqual((await rejected('?sort=unitWeight')).details, [{ field: 'sort', issue: 'enum' }]);
    assert.deepEqual((await rejected('?cursor=abc')).details, [{ field: 'cursor', issue: 'format' }]);
    assert.deepEqual((await rejected(`?category=${'x'.repeat(101)}`)).details, [{ field: 'category', issue: 'maxLength' }]);
    assert.equal((await page('?limit=100')).body.page.limit, 100);
  });

  it('is revalidated with an ETag, and for the PSA alone', async () => {
    const first = await page('?sort=name');
    const etag = first.headers.get('etag')!;
    assert.match(etag, /^W\//);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const again = await office.call('GET', '/tobaccos?sort=name', await as.tokenOf(psa()), undefined, { 'if-none-match': etag });
    assert.equal(again.status, 304);
    assert.equal((await office.call('GET', '/tobaccos', undefined)).status, 401);
    const { dealerA, groups } = office.cluster;
    for (const actor of [dealerA, groups[0]!.sa, groups[0]!.ca, groups[0]!.pa]) {
      assert.deepEqual(as.failure(await as.call(actor, 'GET', '/tobaccos')).code, 'FORBIDDEN');
    }
  });

  it('lists, and sorts by barcode, even when a document of the legacy holds something else than an array of barcodes', async () => {
    await tobaccos().insertMany([{ code: 'G7', name: 'Golf', barcodes: { barcode: 'x' } }, { code: 'H8', name: 'Hotel', barcodes: [{ barcode: '8000000000099' }, 'odd'] }, { code: 'I9', name: 'India', priceKg: Decimal128.fromString('1.5') }]);
    for (const sort of ['', '?sort=barcode', '?sort=-barcode', '?sort=priceKg', '?limit=2&sort=-priceKg']) {
      const reply = await page(sort);
      assert.ok(codesOf(reply).includes('G7') || sort.includes('limit'), sort);
    }
    assert.equal((await page('?q=Golf')).body.data[0].barcode, null);
  });

  it('has the indexes of the search and the sort, and is empty when there is nothing', async () => {
    const names = (await tobaccos().indexes()).map((index) => index.name).sort();
    assert.deepEqual(names, ['_id_', 'code_1', 'name_1']);
    await tobaccos().deleteMany({});
    const reply = await page('');
    assert.deepEqual(reply.body, { data: [], page: { limit: 50, next: null } });
  });
});
