import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { MongoServerError, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { Response } from 'express';
import type { Databases } from '../../src/db/databases.ts';
import { AppError } from '../../src/shared/http/errors.ts';
import { csvFileName, createErrorDocumentsController } from '../../src/modules/error-documents/error-documents.controller.ts';
import { CSV_BOM, CSV_COLUMNS, csvHeader, csvLines } from '../../src/modules/error-documents/error-documents.csv.ts';
import { decodeErrorDocumentCursor, encodeErrorDocumentCursor } from '../../src/modules/error-documents/error-documents.cursor.ts';
import { MAX_DESCRIPTION, displayNumber, toErrorDocument } from '../../src/modules/error-documents/error-documents.mapper.ts';
import type { ErrorDocumentView } from '../../src/modules/error-documents/error-documents.mapper.ts';
import { ERROR_SEND_STATUSES, QUEUE_PROJECTION, createErrorDocumentsRepository } from '../../src/modules/error-documents/error-documents.repository.ts';
import type { ErrorDocumentsFilter, ErrorDocumentsRepository } from '../../src/modules/error-documents/error-documents.repository.ts';
import { createErrorDocumentsService } from '../../src/modules/error-documents/error-documents.service.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { principalOf } from '../helpers/principal.ts';

const g1 = fixtureId('group', 1);
const g2 = fixtureId('group', 2);
const id = (n: number): ObjectId => ObjectId.createFromHexString(`07${n.toString(16).padStart(22, '0')}`);

const view = (overrides: Partial<ErrorDocumentView> = {}): ErrorDocumentView => ({
  id: 'i',
  groupId: 'g',
  groupName: null,
  companyName: null,
  number: null,
  date: null,
  documentType: null,
  eInvoiceType: null,
  customer: null,
  total: null,
  sendStatus: null,
  error: null,
  ...overrides,
});

describe('the display number (the rule of the legacy page: prefix or suffix as stored, no separator of its own)', () => {
  it('puts the stored prefix or suffix before or after the stored number, verbatim', () => {
    assert.equal(displayNumber(105, ' M', 'suffix'), '105 M');
    assert.equal(displayNumber('399', '/B', 'suffix'), '399/B');
    assert.equal(displayNumber(1362, '/A', 'suffix'), '1362/A');
    assert.equal(displayNumber(647, 'A', 'prefix'), 'A647');
    assert.equal(displayNumber('424', '/B', 'suffix'), '424/B');
  });

  it('shows the number alone for any other position, for a missing affix, and nothing for a document without a number', () => {
    assert.equal(displayNumber(7, '/B', undefined), '7');
    assert.equal(displayNumber(7, '/B', 'middle'), '7');
    assert.equal(displayNumber(7, '/B', 'SUFFIX'), '7');
    assert.equal(displayNumber(7, undefined, 'suffix'), '7');
    assert.equal(displayNumber(7, { a: 1 }, 'prefix'), '7');
    assert.equal(displayNumber(7, Number.NaN, 'prefix'), '7');
    assert.equal(displayNumber(undefined, '/B', 'suffix'), null);
    assert.equal(displayNumber('', '/B', 'suffix'), null);
    assert.equal(displayNumber({}, '/B', 'suffix'), null);
    assert.equal(displayNumber(Number.POSITIVE_INFINITY, '/B', 'suffix'), null);
  });

  it('cuts the parts to 50 characters each', () => {
    assert.equal(displayNumber('1'.repeat(80), 'x'.repeat(80), 'prefix'), `${'x'.repeat(50)}${'1'.repeat(50)}`);
  });
});

describe('the mapper', () => {
  const full = {
    _id: id(1),
    groupId: g1,
    type: 'invoice',
    number: 105,
    prefixSuffix: ' M',
    date: new Date('2026-09-25T10:00:00.000Z'),
    total: 33.8,
    customerType: 1,
    counterpart: { name: 'FABIOLA', surname: 'FREZZA', vatCode: 'IT01234567890', address: 'Via Roma 1' },
    fattura_elettronica: { tipo: 'TD01' },
    company: { name: 'SUSHINISI SRL', invoicesPS: 'suffix' },
    sendStatus: 'processingError',
    error: { errorCode: '0034', errorDescription: '  File gia inviato  ', hubSecret: 'x' },
    XML: '<xml>SECRET</xml>',
    hubId: 'HUB',
  };

  it('maps a complete document field by field and carries nothing else', () => {
    const row = toErrorDocument(full, new Map([[g1.toHexString(), 'Gruppo Uno']]));
    assert.deepEqual(row, {
      id: id(1).toHexString(),
      groupId: g1.toHexString(),
      groupName: 'Gruppo Uno',
      companyName: 'SUSHINISI SRL',
      number: '105 M',
      date: '2026-09-25T10:00:00.000Z',
      documentType: 'invoice',
      eInvoiceType: 'TD01',
      customer: 'FABIOLA FREZZA',
      total: 33.8,
      sendStatus: 'processingError',
      error: { code: '0034', description: 'File gia inviato' },
    });
  });

  it('maps a credit note, a company customer and a number code', () => {
    const row = toErrorDocument({ ...full, type: 'credit-note', customerType: 2, counterpart: { companyName: 'ACME SRL', name: 'X' }, error: { errorCode: 99 } }, new Map());
    assert.deepEqual([row.documentType, row.customer, row.groupName, row.error], ['creditNote', 'ACME SRL', null, { code: '99', description: null }]);
  });

  it('shows only the name or only the surname of a person, and nothing for another customer type', () => {
    assert.equal(toErrorDocument({ ...full, counterpart: { name: 'Carlo' } }, new Map()).customer, 'Carlo');
    assert.equal(toErrorDocument({ ...full, counterpart: { surname: 'Spada' } }, new Map()).customer, 'Spada');
    assert.equal(toErrorDocument({ ...full, counterpart: {} }, new Map()).customer, null);
    assert.equal(toErrorDocument({ ...full, customerType: 3 }, new Map()).customer, null);
    assert.equal(toErrorDocument({ ...full, customerType: '1' }, new Map()).customer, null);
  });

  it('reads junk legacy values as missing and never throws', () => {
    const row = toErrorDocument(
      { _id: id(2), groupId: 'not an id', type: 5, number: {}, prefixSuffix: 7, date: 'not a date', total: '33', customerType: 3, counterpart: 'str', fattura_elettronica: null, company: [], sendStatus: { a: 1 }, error: 42 },
      new Map(),
    );
    assert.deepEqual(row, { id: id(2).toHexString(), groupId: null, groupName: null, companyName: null, number: null, date: null, documentType: null, eInvoiceType: null, customer: null, total: null, sendStatus: null, error: { code: null, description: null } });
    assert.deepEqual(toErrorDocument({ _id: id(3), groupId: g1, company: new Date(0), counterpart: g1, fattura_elettronica: new ObjectId(), total: Number.NaN, date: Number.NaN }, new Map()).total, null);
    assert.equal(toErrorDocument({ _id: id(3), date: 1_700_000_000_000 }, new Map()).date, '2023-11-14T22:13:20.000Z');
  });

  it('keeps an error that is a text as its description, and no error when there is none', () => {
    assert.deepEqual(toErrorDocument({ ...full, error: 'Plain failure' }, new Map()).error, { code: null, description: 'Plain failure' });
    assert.equal(toErrorDocument({ ...full, error: null }, new Map()).error, null);
    assert.equal(toErrorDocument({ ...full, error: undefined }, new Map()).error, null);
    assert.deepEqual(toErrorDocument({ ...full, error: { errorDescription: '   ' } }, new Map()).error, { code: null, description: null });
    assert.deepEqual(toErrorDocument({ ...full, error: { errorDescription: 5 } }, new Map()).error, { code: null, description: null });
    assert.deepEqual(toErrorDocument({ ...full, error: [1] }, new Map()).error, { code: null, description: null });
  });

  it('cuts a description to 2000 characters without half of a surrogate pair, and returns markup as plain text', () => {
    const long = toErrorDocument({ ...full, error: { errorDescription: 'a'.repeat(5000) } }, new Map()).error!.description!;
    assert.equal(long.length, MAX_DESCRIPTION);
    const emoji = toErrorDocument({ ...full, error: { errorDescription: `${'a'.repeat(1999)}😀tail` } }, new Map()).error!.description!;
    assert.equal(emoji, 'a'.repeat(1999));
    const html = '<img src=x onerror=alert(1)><script>boom()</script>';
    assert.equal(toErrorDocument({ ...full, error: { errorDescription: html } }, new Map()).error!.description, html);
  });

  it('cuts every other text to 200 characters', () => {
    assert.equal(toErrorDocument({ ...full, company: { name: 'n'.repeat(500) } }, new Map()).companyName!.length, 200);
  });
});

describe('the cursor', () => {
  it('round trips the id and refuses anything this server did not issue', () => {
    assert.equal(decodeErrorDocumentCursor(encodeErrorDocumentCursor(id(9))).toHexString(), id(9).toHexString());
    const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
    for (const bad of ['', 'a b', '!!', b64('not json'), b64([1]), b64(null), b64({ ver: 2, i: id(1).toHexString() }), b64({ ver: 1 }), b64({ ver: 1, i: 5 }), b64({ ver: 1, i: id(10).toHexString().toUpperCase() }), b64({ ver: 1, i: 'abc' }), b64({ ver: 1, i: id(1).toHexString(), extra: true })]) {
      assert.throws(() => decodeErrorDocumentCursor(bad), (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR' && error.details?.[0]?.field === 'cursor', JSON.stringify(bad));
    }
  });
});

describe('the CSV', () => {
  it('has the columns of the table and the status and description of the error', () => {
    assert.deepEqual([...CSV_COLUMNS], ['NUMERO', 'DATA', 'TIPO DOCUMENTO', 'TIPO FE', 'CLIENTE', 'IMPORTO', 'AZIENDA', 'GRUPPO', 'STATO INVIO', 'CODICE ERRORE', 'DESCRIZIONE ERRORE']);
    assert.equal(csvHeader(), `${CSV_COLUMNS.join(';')}\r\n`);
    assert.equal(CSV_BOM, '﻿');
  });

  it('writes a row with the Italian date, amount and document type', () => {
    const line = csvLines([view({ number: '105 M', date: '2026-09-24T22:30:00.000Z', documentType: 'invoice', eInvoiceType: 'TD01', customer: 'FABIOLA FREZZA', total: 33.8, companyName: 'SUSHINISI SRL', groupName: 'Gruppo', sendStatus: 'rejected', error: { code: '0034', description: 'Rifiutata' } })]);
    assert.equal(line, '105 M;25-09-2026;Fattura;TD01;FABIOLA FREZZA;33,80;SUSHINISI SRL;Gruppo;rejected;0034;Rifiutata\r\n');
    assert.equal(csvLines([view({ documentType: 'creditNote', total: -1234.5 })]), ';;Nota di credito;;;-1234,50;;;;;\r\n');
    assert.equal(csvLines([view(), view()]), ';;;;;;;;;;\r\n;;;;;;;;;;\r\n');
    assert.equal(csvLines([]), '');
  });

  it('neutralises what a spreadsheet would run in every text cell, and quotes separators, quotation marks and line breaks', () => {
    const line = csvLines([view({ number: '=1+1', customer: '@SUM(A1)', companyName: '+x', groupName: '-y', sendStatus: '\tz', error: { code: '=c', description: 'a;b "q"\r\nline' } })]);
    assert.equal(line, `'=1+1;;;;'@SUM(A1);;'+x;'-y;'\tz;'=c;"a;b ""q""\r\nline"\r\n`);
  });
});

describe('the service', () => {
  const calls: Array<{ filter: ErrorDocumentsFilter; after: ObjectId | null; limit: number }> = [];
  const doc = (n: number, extra: Document = {}): Document => ({ _id: id(n), groupId: g1, type: 'invoice', number: n, ...extra });
  const repo = (documents: Document[], overrides: Partial<ErrorDocumentsRepository> = {}): ErrorDocumentsRepository => ({
    find: async (filter, after, limit) => {
      calls.push({ filter, after, limit });
      return documents.filter((document) => after === null || (document['_id'] as ObjectId).toHexString() < after.toHexString()).slice(0, limit);
    },
    count: async (_filter, cap) => Math.min(documents.length, cap + 1),
    groupNames: async (ids) => new Map(ids.map((groupId) => [groupId.toHexString(), 'G'])),
    ...overrides,
  });
  const noDealer = { listDealerGroupIds: async () => [] as ObjectId[] };
  const psa = principalOf('PSA');
  const dealer = principalOf('D', { dealerGroupIds: [g1] });

  it('lets the platform administrator read every group, or the groups of a dealer', async () => {
    calls.length = 0;
    const service = createErrorDocumentsService({ repository: repo([doc(2), doc(1)]), dealerGroups: { listDealerGroupIds: async (dealerId) => (dealerId.equals(id(50)) ? [g1, g2] : []) } });
    assert.equal((await service.list(psa, {})).items.length, 2);
    assert.equal(calls[0]!.filter.groupIds, null);
    await service.list(psa, { dealerId: id(50) });
    assert.deepEqual(calls[1]!.filter.groupIds?.map((groupId) => groupId.toHexString()), [g1.toHexString(), g2.toHexString()]);
    await service.list(psa, { dealerId: id(50), groupId: g2 });
    assert.deepEqual(calls[2]!.filter.groupIds?.map((groupId) => groupId.toHexString()), [g2.toHexString()]);
    await service.list(psa, { groupId: g1 });
    assert.deepEqual(calls[3]!.filter.groupIds?.map((groupId) => groupId.toHexString()), [g1.toHexString()]);
    const before = calls.length;
    assert.deepEqual(await service.list(psa, { dealerId: id(51) }), { items: [], page: { limit: 50, next: null } });
    assert.deepEqual(await service.list(psa, { dealerId: id(50), groupId: id(77) }), { items: [], page: { limit: 50, next: null } });
    assert.equal(calls.length, before, 'an empty perimeter does not read the queue');
  });

  it('lets a dealer read only the groups of his scope, refuses his dealerId filter and answers an empty page for a group outside it', async () => {
    calls.length = 0;
    const service = createErrorDocumentsService({ repository: repo([doc(1)]), dealerGroups: noDealer });
    await service.list(dealer, {});
    assert.deepEqual(calls[0]!.filter.groupIds?.map((groupId) => groupId.toHexString()), [g1.toHexString()]);
    await assert.rejects(service.list(dealer, { dealerId: id(1) }), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
    await assert.rejects(service.export(dealer, { dealerId: id(1) }), (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN');
    assert.deepEqual((await service.list(dealer, { groupId: g2 })).items, []);
    assert.deepEqual((await service.list(principalOf('D'), {})).items, []);
    assert.equal(calls.length, 1);
  });

  it('reads nothing for any other scope (fail closed)', async () => {
    const service = createErrorDocumentsService({ repository: repo([doc(1)]), dealerGroups: noDealer });
    for (const role of ['SA', 'CA', 'PA', 'E'] as const) {
      assert.deepEqual(await service.list(principalOf(role, { groupId: g1 }), {}), { items: [], page: { limit: 50, next: null } }, role);
      assert.equal((await service.export(principalOf(role, { groupId: g1 }), {})).total, 0, role);
    }
  });

  it('translates the document type and passes the error code', async () => {
    calls.length = 0;
    const service = createErrorDocumentsService({ repository: repo([]), dealerGroups: noDealer });
    await service.list(psa, { documentType: 'creditNote', errorCode: '0034' });
    await service.list(psa, { documentType: 'invoice' });
    assert.deepEqual([calls[0]!.filter.type, calls[0]!.filter.errorCode, calls[1]!.filter.type, calls[1]!.filter.errorCode], ['credit-note', '0034', 'invoice', undefined]);
  });

  it('pages with an id cursor, reading one more than asked, and looks the names up only for the groups of the page', async () => {
    const lookups: ObjectId[][] = [];
    const service = createErrorDocumentsService({
      repository: repo([doc(5), doc(4, { groupId: g2 }), doc(3, { groupId: 'junk' }), doc(2), doc(1)], { groupNames: async (ids) => (lookups.push([...ids]), new Map([[g1.toHexString(), 'Uno']])) }),
      dealerGroups: noDealer,
    });
    const first = await service.list(psa, { limit: 2 });
    assert.deepEqual(first.items.map((row) => [row.number, row.groupName]), [['5', 'Uno'], ['4', null]]);
    assert.deepEqual(lookups[0]!.map((groupId) => groupId.toHexString()), [g1.toHexString(), g2.toHexString()]);
    const second = await service.list(psa, { limit: 2, cursor: first.page.next! });
    assert.deepEqual(second.items.map((row) => row.number), ['3', '2']);
    assert.equal(lookups.length, 2);
    assert.deepEqual(lookups[1]!.map((groupId) => groupId.toHexString()), [g1.toHexString()]);
    const last = await service.list(psa, { limit: 2, cursor: second.page.next! });
    assert.deepEqual([last.items.map((row) => row.number), last.page], [['1'], { limit: 2, next: null }]);
    const onlyJunk = createErrorDocumentsService({ repository: repo([doc(1, { groupId: 'junk' })], { groupNames: async () => assert.fail('no group to look up') }), dealerGroups: noDealer });
    assert.equal((await onlyJunk.list(psa, {})).items[0]!.groupName, null);
    assert.deepEqual((await createErrorDocumentsService({ repository: repo([]), dealerGroups: noDealer }).list(psa, {})).page, { limit: 50, next: null });
    await assert.rejects(service.list(psa, { cursor: 'bad cursor' }), (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR');
  });

  it('exports in batches in the order of the table, never more than the limit, and refuses a larger result with 413 before the first row', async () => {
    const documents = [5, 4, 3, 2, 1].map((n) => doc(n));
    const service = createErrorDocumentsService({ repository: repo(documents), dealerGroups: noDealer, limits: { maxExportRows: 5, batchRows: 2 } });
    const exported = await service.export(psa, {});
    assert.equal(exported.total, 5);
    const batches = await Array.fromAsync(exported.batches());
    assert.deepEqual(batches.map((batch) => batch.map((row) => row.number)), [['5', '4'], ['3', '2'], ['1']]);
    const small = createErrorDocumentsService({ repository: repo(documents), dealerGroups: noDealer, limits: { maxExportRows: 4, batchRows: 3 } });
    await assert.rejects(small.export(psa, {}), (error: unknown) => error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE');
    // Rows added since the count must not make the file larger than the limit.
    const grown = createErrorDocumentsService({ repository: repo(documents, { count: async () => 3 }), dealerGroups: noDealer, limits: { maxExportRows: 3, batchRows: 2 } });
    const grownBatches = await Array.fromAsync((await grown.export(psa, {})).batches());
    assert.deepEqual(grownBatches.map((batch) => batch.length), [2, 1]);
    const empty = createErrorDocumentsService({ repository: repo([]), dealerGroups: noDealer });
    assert.deepEqual((await Array.fromAsync((await empty.export(psa, {})).batches())), [[]]);
    const defaults = createErrorDocumentsService({ repository: repo([doc(1)]), dealerGroups: noDealer });
    assert.equal((await defaults.export(psa, {})).total, 1);
  });
});

describe('the repository', () => {
  const expired = new MongoServerError({ message: 'operation exceeded time limit', code: 50, codeName: 'MaxTimeMSExpired' });
  const failing = (error: Error): Databases => ({ common: () => ({ collection: () => ({ find: () => ({ toArray: () => Promise.reject(error) }) }) }), queue: () => ({ collection: () => ({ find: () => ({ toArray: () => Promise.reject(error) }), countDocuments: () => Promise.reject(error) }) }) }) as unknown as Databases;

  it('answers 503 SERVICE_UNAVAILABLE when a read exceeds its time limit, and lets any other failure through', async () => {
    const repository = createErrorDocumentsRepository(failing(expired));
    for (const read of [() => repository.find({ groupIds: null }, null, 10), () => repository.count({ groupIds: null }, 10), () => repository.groupNames([g1])]) {
      await assert.rejects(read(), (error: unknown) => error instanceof AppError && error.code === 'SERVICE_UNAVAILABLE');
    }
    const other = createErrorDocumentsRepository(failing(new Error('network')));
    await assert.rejects(other.find({ groupIds: null }, null, 10), /network/);
    const otherCode = createErrorDocumentsRepository(failing(new MongoServerError({ message: 'other', code: 13 })));
    await assert.rejects(otherCode.count({ groupIds: null }, 10), MongoServerError);
  });

  it('asks the queue for the legacy statuses or a real error, bounded and with a time limit, projecting nothing but what the table needs', async () => {
    const seen: Array<{ filter: Document; options: Document }> = [];
    const databases = { queue: () => ({ collection: (name: string) => ({ find: (filter: Document, options: Document) => (seen.push({ filter, options: { name, ...options } }), { toArray: async () => [] }), countDocuments: async (filter: Document, options: Document) => (seen.push({ filter, options }), 0) }) }) } as unknown as Databases;
    const repository = createErrorDocumentsRepository(databases);
    await repository.find({ groupIds: [g1], type: 'credit-note', errorCode: '0034' }, id(9), 11);
    await repository.count({ groupIds: null }, 100);
    assert.deepEqual(seen[0]!.filter, {
      $and: [
        { $or: [{ sendStatus: { $in: [...ERROR_SEND_STATUSES] } }, { error: { $exists: true, $ne: null } }] },
        { $and: [{ _id: { $type: 'objectId' } }, { _id: { $lt: id(9) } }] },
        { groupId: { $in: [g1] } },
        { type: 'credit-note' },
        { 'error.errorCode': '0034' },
      ],
    });
    assert.deepEqual(seen[0]!.options, { name: 'documents', projection: { ...QUEUE_PROJECTION }, sort: { _id: -1 }, limit: 11, maxTimeMS: 5000 });
    assert.deepEqual(seen[1]!.filter, { $and: [{ $or: [{ sendStatus: { $in: [...ERROR_SEND_STATUSES] } }, { error: { $exists: true, $ne: null } }] }, { _id: { $type: 'objectId' } }] });
    assert.deepEqual(seen[1]!.options, { limit: 101, maxTimeMS: 5000 });
    assert.deepEqual(ERROR_SEND_STATUSES, ['processingError', 'rejected', 'notDelivered', 'deliveryImpossible', 'refused', 'effectiveDate']);
    for (const forbidden of ['XML', 'hubId', 'counterpart', 'counterpart.vatCode', 'dealerId', 'sent']) {
      assert.ok(!(forbidden in QUEUE_PROJECTION), forbidden);
    }
  });
});

describe('the repository on a real database', () => {
  let ctx: TestDatabases;
  before(async () => {
    ctx = await openTestDatabases();
  });
  after(async () => ctx.cleanup());

  it('reads the group names of a page from the common database, ignoring a name that is not a text', async () => {
    await ctx.databases.common().collection('groups').insertMany([{ _id: g1, name: 'Uno' }, { _id: g2, name: 5 }]);
    const names = await createErrorDocumentsRepository(ctx.databases).groupNames([g1, g2, id(1)]);
    assert.deepEqual([...names], [[g1.toHexString(), 'Uno'], [g2.toHexString(), '']]);
  });

  it('reads an absent queue database as empty', async () => {
    const repository = createErrorDocumentsRepository(ctx.databases);
    assert.deepEqual(await repository.find({ groupIds: null }, null, 10), []);
    assert.equal(await repository.count({ groupIds: null }, 10), 0);
  });
});

describe('the controller', () => {
  const body = { locals: { auth: principalOf('PSA'), input: { query: {} } } };
  /** A response that goes away after its first chunk, as a client that closes the connection. */
  function leavingResponse(): Response {
    const out = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
        this.destroy();
      },
    });
    return Object.assign(out, { ...body, status: () => out, setHeader: () => out }) as unknown as Response;
  }
  const sinkResponse = (): Response => {
    const sink = new PassThrough();
    sink.resume();
    return Object.assign(sink, { ...body, status: () => sink, setHeader: () => sink }) as unknown as Response;
  };
  const noRows = { list: async () => ({ items: [], page: { limit: 1, next: null } }), export: async () => ({ total: 0, batches: async function* () {} }) };

  it('stops quietly when the client goes away, and lets any other failure through', async () => {
    const controller = createErrorDocumentsController({ ...noRows, export: async () => ({ total: 2, batches: async function* () { yield [view()]; yield [view()]; } }) }, () => Date.UTC(2026, 10, 17));
    await controller.csv({} as never, leavingResponse(), () => undefined);
    const failing = createErrorDocumentsController({ ...noRows, export: async () => ({ total: 1, batches: async function* () { throw new Error('database down'); } }) }, () => 0);
    await assert.rejects(failing.csv({} as never, sinkResponse(), () => undefined) as Promise<void>, /database down/);
    assert.equal(csvFileName(new Date(Date.UTC(2026, 10, 17, 23, 0, 0))), 'error-documents_2026-11-17.csv');
  });

  it('allows one export at a time to a user, and frees the place when it ends or fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = createErrorDocumentsController({ ...noRows, export: async () => ({ total: 1, batches: async function* () { await gate; yield []; } }) }, () => 0);
    const first = slow.csv({} as never, sinkResponse(), () => undefined) as Promise<void>;
    await assert.rejects(slow.csv({} as never, sinkResponse(), () => undefined) as Promise<void>, (error: unknown) => error instanceof AppError && error.code === 'RATE_LIMITED');
    release();
    await first;
    await (slow.csv({} as never, sinkResponse(), () => undefined) as Promise<void>);
  });

  it('stops an export that takes longer than its limit', async () => {
    const stuck = createErrorDocumentsController({ ...noRows, export: async () => ({ total: 1, batches: async function* () { await new Promise((resolve) => setTimeout(resolve, 200)); } }) }, () => 0, 20);
    await assert.rejects(stuck.csv({} as never, sinkResponse(), () => undefined) as Promise<void>, (error: unknown) => (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError');
  });
});
