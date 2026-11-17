import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { addUser } from '../helpers/backoffice.ts';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { LEGACY_MODULE_NAMES, legacyPermissions } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { StoreWorld } from '../helpers/store-keys.ts';

let ctx: TestDatabases;
let world: StoreWorld;
const limiter = memoryRateLimiter();
const call = (...args: Parameters<StoreWorld['as']['call']>) => world.as.call(...args);
const hex = (value: ObjectId) => value.toHexString();
const g = (index: number) => world.group(index);
const psa = () => world.office.cluster.psa;
const queueId = (n: number): ObjectId => ObjectId.createFromHexString(`07${n.toString(16).padStart(22, '0')}`);
const queue = () => ctx.client.db(`${ctx.prefix}development_queue`).collection('documents');
const numbers = (reply: { body: { data: Array<{ number: string | null }> } }) => reply.body.data.map((row) => row.number);

/** The CSV of a request as a user: status, headers and text. */
async function csv(actor: ObjectId, query = ''): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await world.office.call('GET', `/error-documents.csv${query}`, await world.as.tokenOf(actor));
  // `Response.text()` drops the byte order mark: it is part of what is checked.
  return { status: response.status, headers: response.headers, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer()) };
}

const SECRETS = ['SECRET-XML', 'HUB-SECRET', 'IT01234567890', 'RSSMRA80A01H501U', 'Via Segreta', 'hub-internal', 'secret-counterpart'];

/** A queue document as the legacy writes it: the whole fiscal document plus `groupId` and `dealerId`. */
function queued(n: number, groupId: unknown, extra: Document = {}): Document {
  return {
    _id: queueId(n),
    groupId,
    dealerId: null,
    type: 'invoice',
    number: n,
    prefixSuffix: '',
    date: new Date('2026-09-25T10:00:00.000Z'),
    total: 10,
    customerType: 2,
    counterpart: { companyName: 'ACME SRL', vatCode: 'IT01234567890', fiscalCode: 'RSSMRA80A01H501U', address: 'Via Segreta 1', note: 'secret-counterpart' },
    fattura_elettronica: { tipo: 'TD01' },
    company: { name: 'Azienda', invoicesPS: 'suffix' },
    XML: '<xml>SECRET-XML</xml>',
    hubId: 'HUB-SECRET',
    sent: false,
    sendStatus: 'queued',
    ...extra,
  };
}

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter, env: { RATE_LIMIT_ERROR_DOCUMENTS_EXPORT_PER_USER: '4' } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(() => limiter.reset());

describe('the queue database is absent', () => {
  it('answers an empty page and a file with the header alone, not an error', async () => {
    const list = await call(psa(), 'GET', '/error-documents');
    assert.deepEqual([list.status, list.body], [200, { data: [], page: { limit: 50, next: null } }]);
    const file = await csv(psa());
    assert.deepEqual([file.status, file.text.split('\r\n').length], [200, 2]);
    assert.equal((await call(world.office.cluster.dealerA, 'GET', '/error-documents')).status, 200);
  });
});

describe('with a queue', () => {
  before(async () => {
    const dealerB = world.office.cluster.dealerB;
    const dealerA = world.office.cluster.dealerA;
    await queue().insertMany([
      // The examples of the production screenshot.
      queued(1, g(0).groupId, { number: 105, prefixSuffix: ' M', customerType: 1, counterpart: { name: 'FABIOLA', surname: 'FREZZA', vatCode: 'IT01234567890', note: 'secret-counterpart' }, total: 33.8, company: { name: 'SUSHINISI SRL', invoicesPS: 'suffix' }, error: { errorCode: '0034', errorDescription: 'File gia inviato <b>da poco</b>', note: 'hub-internal' }, dealerId: dealerB }),
      queued(2, g(0).groupId, { type: 'credit-note', number: '399', prefixSuffix: '/B', sendStatus: 'rejected', fattura_elettronica: { tipo: 'TD04' } }),
      queued(3, g(1).groupId, { number: 647, prefixSuffix: 'A', company: { name: 'Altra', invoicesPS: 'prefix' }, sendStatus: 'refused' }),
      // A group of dealer B whose queue document claims dealer A.
      queued(4, g(2).groupId, { number: 4, error: { errorCode: '0099', errorDescription: 'Errore' }, dealerId: dealerA }),
      // A document of a group of dealer A that claims no dealer, and one that claims dealer B: the groups decide, not the queue.
      queued(5, g(1).groupId, { number: 5, sendStatus: 'notDelivered', dealerId: dealerB }),
      // Not listed: sent, queued with a null error, delivered, accepted, and an id that is not an ObjectId.
      queued(6, g(0).groupId, { sendStatus: 'sent' }),
      queued(7, g(0).groupId, { error: null }),
      queued(8, g(0).groupId, { sendStatus: 'delivered' }),
      queued(9, g(0).groupId, { sendStatus: 'accepted' }),
      { ...queued(10, g(0).groupId, { error: { errorCode: '0034' } }), _id: 'not-an-object-id' },
      // A description longer than the cap, and the status `effectiveDate`.
      queued(11, g(0).groupId, { number: 11, error: { errorCode: '0034', errorDescription: 'x'.repeat(5000) } }),
      queued(12, g(3).groupId, { number: 12, sendStatus: 'deliveryImpossible' }),
      // Junk legacy values.
      queued(13, 'not an id', { type: 5, number: {}, prefixSuffix: 7, date: 'xx', total: '33', customerType: 3, counterpart: 'str', company: [], fattura_elettronica: null, error: 'raw failure', sendStatus: 'processingError' }),
      queued(14, g(0).groupId, { number: 14, sendStatus: 'effectiveDate', error: 42, type: 'receipt' }),
    ]);
  });

  describe('GET /v1/error-documents', () => {
    it('gives the platform administrator every listed document, the newest first, with the legacy columns, the group and the error, and nothing else', async () => {
      const reply = await call(psa(), 'GET', '/error-documents?limit=100');
      assert.equal(reply.status, 200);
      assert.deepEqual(numbers(reply), ['14', null, '12', '11', '5', '4', 'A647', '399/B', '105 M']);
      const first = reply.body.data[8];
      assert.deepEqual(first, {
        id: hex(queueId(1)),
        groupId: hex(g(0).groupId),
        groupName: 'group-001',
        companyName: 'SUSHINISI SRL',
        number: '105 M',
        date: '2026-09-25T10:00:00.000Z',
        documentType: 'invoice',
        eInvoiceType: 'TD01',
        customer: 'FABIOLA FREZZA',
        total: 33.8,
        sendStatus: 'queued',
        error: { code: '0034', description: 'File gia inviato <b>da poco</b>' },
      });
      assert.deepEqual(reply.body.data[7], { ...reply.body.data[7], documentType: 'creditNote', eInvoiceType: 'TD04', customer: 'ACME SRL', sendStatus: 'rejected', error: null });
      assert.equal(reply.body.data[6].number, 'A647');
      assert.deepEqual(reply.body.data[1], { id: hex(queueId(13)), groupId: null, groupName: null, companyName: null, number: null, date: null, documentType: null, eInvoiceType: null, customer: null, total: null, sendStatus: 'processingError', error: { code: null, description: 'raw failure' } });
      assert.deepEqual([reply.body.data[0].error, reply.body.data[0].documentType], [{ code: null, description: null }, null]);
      assert.equal(reply.body.data[3].error.description.length, 2000);
      assert.deepEqual(reply.body.page, { limit: 100, next: null });
      const text = JSON.stringify(reply.body);
      for (const secret of [...SECRETS, 'hubId', 'XML', 'dealerId', 'counterpart', 'errorDescription']) {
        assert.ok(!text.includes(secret), secret);
      }
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      const etag = reply.headers.get('etag')!;
      assert.equal((await world.office.call('GET', '/error-documents?limit=100', await world.as.tokenOf(psa()), undefined, { 'if-none-match': etag })).status, 304);
    });

    it('returns the markup of an error description as it is: text for the client to show as text', async () => {
      const reply = await call(psa(), 'GET', `/error-documents?groupId=${hex(g(0).groupId)}&errorCode=0034`);
      assert.ok(reply.body.data.some((row: { error: { description: string } }) => row.error.description === 'File gia inviato <b>da poco</b>'));
    });

    it('gives a dealer only the documents of the groups whose dealer is he, whatever the queue says', async () => {
      const { dealerA, dealerB } = world.office.cluster;
      // Dealer A: groups 0 and 1. The document 4 claims dealer A but belongs to a group of dealer B; the document 1 claims dealer B but belongs to a group of dealer A.
      assert.deepEqual(numbers(await call(dealerA, 'GET', '/error-documents')), ['14', '11', '5', 'A647', '399/B', '105 M']);
      // Dealer B: groups 2 and 3 (the demo group is read too: the legacy listed everything of the dealer).
      assert.deepEqual(numbers(await call(dealerB, 'GET', '/error-documents')), ['12', '4']);
      const foreign = await call(dealerA, 'GET', `/error-documents?groupId=${hex(g(2).groupId)}`);
      assert.deepEqual([foreign.status, foreign.body], [200, { data: [], page: { limit: 50, next: null } }]);
      assert.deepEqual(numbers(await call(dealerA, 'GET', `/error-documents?groupId=${hex(g(1).groupId)}`)), ['5', 'A647']);
      const forged = await call(dealerA, 'GET', `/error-documents?dealerId=${hex(dealerA)}`);
      assert.deepEqual([forged.status, forged.body.error.code], [403, 'FORBIDDEN']);
      assert.equal((await call(dealerA, 'GET', `/error-documents.csv?dealerId=${hex(dealerB)}`)).status, 403);
    });

    it('lets the platform administrator filter by dealer, group, document type and error code, in any combination', async () => {
      const { dealerA, dealerB } = world.office.cluster;
      assert.deepEqual(numbers(await call(psa(), 'GET', `/error-documents?dealerId=${hex(dealerA)}`)), ['14', '11', '5', 'A647', '399/B', '105 M']);
      assert.deepEqual(numbers(await call(psa(), 'GET', `/error-documents?dealerId=${hex(dealerB)}`)), ['12', '4']);
      assert.deepEqual((await call(psa(), 'GET', `/error-documents?dealerId=${hex(queueId(99))}`)).body.data, []);
      assert.deepEqual((await call(psa(), 'GET', `/error-documents?dealerId=${hex(dealerA)}&groupId=${hex(g(2).groupId)}`)).body.data, []);
      assert.deepEqual(numbers(await call(psa(), 'GET', `/error-documents?dealerId=${hex(dealerA)}&groupId=${hex(g(1).groupId)}`)), ['5', 'A647']);
      assert.deepEqual(numbers(await call(psa(), 'GET', `/error-documents?groupId=${hex(g(0).groupId)}`)), ['14', '11', '399/B', '105 M']);
      assert.deepEqual(numbers(await call(psa(), 'GET', '/error-documents?documentType=creditNote')), ['399/B']);
      assert.deepEqual(numbers(await call(psa(), 'GET', '/error-documents?documentType=invoice&groupId=' + hex(g(1).groupId))), ['5', 'A647']);
      assert.deepEqual(numbers(await call(psa(), 'GET', '/error-documents?errorCode=0099')), ['4']);
      assert.deepEqual(numbers(await call(psa(), 'GET', `/error-documents?errorCode=0034&groupId=${hex(g(0).groupId)}&documentType=invoice`)), ['11', '105 M']);
      assert.deepEqual((await call(psa(), 'GET', '/error-documents?errorCode=ZZ')).body.data, []);
      // A filter value is a string: an operator is a validation error, never a query.
      assert.equal((await call(psa(), 'GET', '/error-documents?errorCode[$ne]=x')).status, 422);
    });

    it('pages with a cursor until the end, the same documents as the whole list', async () => {
      const seen: Array<string | null> = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const reply = await call(psa(), 'GET', `/error-documents?limit=3${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...numbers(reply));
        cursor = reply.body.page.next;
        if (cursor === null) {
          break;
        }
        assert.equal(reply.body.data.length, 3);
      }
      assert.equal(cursor, null);
      assert.deepEqual(seen, numbers(await call(psa(), 'GET', '/error-documents?limit=100')));
    });

    it('refuses what is not valid with 422: a limit out of range, a malformed cursor, an unknown type, an id that is not one, a code that is not one, an unknown parameter', async () => {
      for (const query of ['limit=0', 'limit=101', 'limit=x', 'cursor=!!', 'cursor=eyJ2ZXIiOjF9', 'documentType=receipt', 'groupId=abc', 'dealerId=abc', 'errorCode=', 'errorCode=0034-1', 'errorCode=12345678901', 'sort=date', 'q=x', 'groupId=a&groupId=b']) {
        const reply = await call(psa(), 'GET', `/error-documents?${query}`);
        assert.deepEqual([reply.status, reply.body.error.code], [422, 'VALIDATION_ERROR'], query);
      }
    });

    it('refuses every role but the platform administrator and the dealers (403), a store key (403) and an anonymous caller (401), on both routes', async () => {
      // A group administrator whose own matrix allows everything: the role ceiling is what refuses him.
      const modules = Object.fromEntries(LEGACY_MODULE_NAMES.map((name) => [name, { r: true, w: true }]));
      const greedy = await addUser(ctx, world.office, { permissions: legacyPermissions({ status: true, modules }) });
      for (const path of ['/error-documents', '/error-documents.csv']) {
        for (const actor of [g(0).sa, g(0).ca, g(0).pa, greedy.id]) {
          const reply = await call(actor, 'GET', path);
          assert.deepEqual([reply.status, reply.body?.error?.code], [403, 'FORBIDDEN'], `${path} ${hex(actor)}`);
        }
        assert.equal((await world.office.call('GET', path, undefined)).status, 401, path);
        const key = await world.activate(g(0).ownPlaceId);
        const asStore = await world.asStore(key.key, 'GET', path);
        assert.deepEqual([asStore.status, asStore.body.error.code], [403, 'FORBIDDEN'], path);
      }
      assert.equal((await call(psa(), 'GET', '/me')).body.data.permissions.includes('errorDocuments:read'), true);
      assert.equal((await call(world.office.cluster.dealerA, 'GET', '/me')).body.data.permissions.includes('errorDocuments:read'), true);
      assert.equal((await call(g(0).sa, 'GET', '/me')).body.data.permissions.includes('errorDocuments:read'), false);
    });

    it('is not on the public surface', async () => {
      for (const path of ['/error-documents', '/error-documents.csv']) {
        assert.ok([401, 404].includes((await world.office.publicCall('GET', path, undefined)).status), path);
      }
    });

    it('never writes to the queue: the same documents, and no index but the id one, after the reads', async () => {
      const before = await queue().find({}).sort({ _id: 1 }).toArray();
      await call(psa(), 'GET', '/error-documents?limit=100');
      await csv(psa());
      assert.deepEqual(await queue().find({}).sort({ _id: 1 }).toArray(), before);
      assert.deepEqual((await queue().indexes()).map((index) => index.name), ['_id_']);
    });
  });

  describe('GET /v1/error-documents.csv', () => {
    it('streams the file of the table plus the status and the description, with the headers of a download', async () => {
      const reply = await csv(psa(), `?groupId=${hex(g(0).groupId)}&documentType=invoice&errorCode=0034`);
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.match(reply.headers.get('content-disposition')!, /^attachment; filename="error-documents_\d{4}-\d{2}-\d{2}\.csv"$/);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      const lines = reply.text.split('\r\n');
      assert.equal(lines[0], '﻿NUMERO;DATA;TIPO DOCUMENTO;TIPO FE;CLIENTE;IMPORTO;AZIENDA;GRUPPO;STATO INVIO;CODICE ERRORE;DESCRIZIONE ERRORE');
      assert.equal(lines[1]!.split(';').slice(0, 11).join(';').startsWith('11;25-09-2026;Fattura;TD01;ACME SRL;10,00;Azienda;group-001;queued;0034;'), true);
      assert.equal(lines[1]!.length > 2000, true);
      assert.equal(lines[2], '105 M;25-09-2026;Fattura;TD01;FABIOLA FREZZA;33,80;SUSHINISI SRL;group-001;queued;0034;File gia inviato <b>da poco</b>');
      assert.equal(lines.length, 4);
      assert.equal(lines[3], '');
      for (const secret of SECRETS) {
        assert.ok(!reply.text.includes(secret), secret);
      }
    });

    it('exports the perimeter of the caller only, in the order of the table, and the header alone when there is nothing', async () => {
      const dealer = await csv(world.office.cluster.dealerB);
      assert.deepEqual(dealer.text.split('\r\n').slice(1, -1).map((line) => line.split(';')[0]), ['12', '4']);
      const all = (await csv(psa())).text.split('\r\n').slice(1, -1);
      assert.equal(all.length, (await call(psa(), 'GET', '/error-documents?limit=100')).body.data.length);
      const nothing = await csv(world.office.cluster.dealerA, `?groupId=${hex(g(2).groupId)}`);
      assert.deepEqual([nothing.status, nothing.text.split('\r\n').length], [200, 2]);
    });

    it('neutralises a cell a spreadsheet would run', async () => {
      await queue().insertOne(queued(20, g(1).groupId, { number: '=1+1', prefixSuffix: '', customerType: 2, counterpart: { companyName: '@SUM(A1)' }, company: { name: '+cmd|calc', invoicesPS: 'suffix' }, error: { errorCode: '0034', errorDescription: '-2+3;"x"' } }));
      const reply = await csv(psa(), `?groupId=${hex(g(1).groupId)}&errorCode=0034`);
      assert.equal(reply.text.split('\r\n')[1], `'=1+1;25-09-2026;Fattura;TD01;'@SUM(A1);10,00;'+cmd|calc;group-002;queued;0034;"'-2+3;""x"""`);
      await queue().deleteOne({ _id: queueId(20) });
    });

    it('is rate limited per user and refuses invalid filters', async () => {
      assert.deepEqual([(await call(psa(), 'GET', '/error-documents.csv?limit=5')).status, (await call(psa(), 'GET', '/error-documents.csv?documentType=x')).status], [422, 422]);
      limiter.reset();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await csv(psa())).status);
      }
      assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
      assert.equal((await csv(world.office.cluster.dealerA)).status, 200);
      assert.equal((await call(psa(), 'GET', '/error-documents')).status, 200);
    });
  });
});
