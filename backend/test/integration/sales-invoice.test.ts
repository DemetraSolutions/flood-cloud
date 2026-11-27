import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { memoryRateLimiter } from '../helpers/activity.ts';
import { legacyCompany } from '../helpers/contacts.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { startStoreWorld } from '../helpers/store-keys.ts';
import type { ActivatedKey, StoreWorld } from '../helpers/store-keys.ts';
import { saleBody, saleLine } from '../helpers/store-sales.ts';

/** The invoice a sale of type `invoice` creates (step VS5): the document of the group, its number, the send queue, the deferred invoice; over a real MongoDB, through the HTTP of the store and of the backoffice. */
let ctx: TestDatabases;
let world: StoreWorld;
let store: ActivatedKey;
const limiter = memoryRateLimiter();
const hex = (id: ObjectId) => id.toHexString();
const gid = () => world.group(0).groupId;
const own = () => world.group(0).ownPlaceId;
const db = (index = 0) => ctx.databases.group(world.group(index).groupId, 'cluster0');
const salesOf = (index = 0) => db(index).collection('sales');
const documentsOf = (index = 0) => db(index).collection('documents');
const queue = () => ctx.client.db(`${ctx.prefix}development_queue`).collection('documents');
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = store.key) => world.asStore(key, method, path, body, headers);
const post = (body: unknown) => send('POST', '/store-context/sales', body);
const backoffice = (actor: ObjectId, body: unknown) => world.as.call(actor, 'POST', `/groups/${hex(gid())}/sales`, body, { 'idempotency-key': randomUUID() });
let companyId: ObjectId;
let cashStorage: ObjectId;
let counter = 0;
let dealerId: ObjectId;

const HUB = 'aruba';
/** What the company of the group keeps in its copy: what an invoice may copy, and what it must never copy (credentials, integrations, the e-commerce settings, the logos). */
const COMPANY = {
  name: 'Acme Spa',
  code: 'IT01234567890',
  code2: '01234567890',
  address: 'Via Roma 1',
  postcode: '20100',
  city: 'Milano',
  countryAreaCode: 'MI',
  countryCode: 'IT',
  currencyCode: 'EUR',
  email: 'acme@example.test',
  telephone: '+39 02 000',
  invoicesPS: 'prefix',
  invoicesPSValues: [{ name: 'A', cash: true }],
  fattura_elettronica: { hub: HUB, IdTrasmittente_paese: 'IT', IdTrasmittente_codice: '01234567890', rea_ufficio: 'MI', rea_numero: '123', rea_capitale_sociale: '10000', rea_soci: 'SM', rea_liquidazione: 'LN', regime_fiscale: 'RF01', codice_eori: 'EORI1', albo_professionale: 'ALBO' },
  settings: { global: { discountLines: true, lastInvoiceNumber: 41, enableLoginSignup: true }, api: { cerved: true }, ecommerce: { listId: 'secret-list' } },
  banks: [{ id: 'b1', name: 'Bank', iban: 'IT60X0542811101000000123456', abi: '05428', cab: '11101', bic: 'BPBAIT3B', default: true }],
  integrations: { server: { password: 'never-copied' } },
  medias: { images: { internalFileName: 'logo.png' } },
};

/** A product of the catalog. */
async function product(): Promise<ObjectId> {
  const _id = new ObjectId();
  await db().collection('products').insertOne({ _id, type: 'product', code: `P-${String((counter += 1))}`, name: { it: 'Prodotto' }, categories: ['cat-1'], availability: { pos: true, warehouse: false }, measureLoad: 'pz', measureDownload: 'pz', measureConversionRatio: 1, bundleProducts: [], barcode: [] });
  return _id;
}
/** A customer company of the group, with everything the legacy keeps of it (including what a copy must never carry). */
async function customer(overrides: Document = {}): Promise<ObjectId> {
  const contact = legacyCompany({ companyAddress: 'Via Verdi 2', companyPostcode: '10100', companyCity: 'Torino', companyCountryCode: 'IT', companyCountryAreaCode: 'TO', note: 'internal note', ...overrides });
  await db().collection('contacts').insertOne(contact);
  return contact['_id'] as ObjectId;
}
const invoiceBody = (lines: Document[], overrides: Document = {}): Document => saleBody(lines, { timestampId: `I-${String((counter += 1))}`, receiptType: 'invoice', ...overrides });
const documentOf = async (saleId: string): Promise<Document> => (await documentsOf().findOne({ saleId: new ObjectId(saleId) }))!;
const saleOf = async (id: string): Promise<Document> => (await salesOf().findOne({ _id: new ObjectId(id) }))!;
const anomalyCodes = (sale: Document): string[] => (sale['floodCloud'].anomalies as Document[]).map((anomaly) => `${anomaly['source']}:${anomaly['code']}`);
const setHub = (hub: unknown) => ctx.databases.common().collection('companies').updateOne({ _id: companyId }, { $set: { 'fattura_elettronica.hub': hub } });

before(async () => {
  ctx = await openTestDatabases();
  world = await startStoreWorld(ctx, { rateLimiter: limiter, env: { RATE_LIMIT_STORE_SALES_WRITE_PER_STORE: '400', RATE_LIMIT_STORE_INVOICES_PER_STORE: '15', STORE_INVOICE_ALERT_PER_DAY: '12' } });
  store = await world.activate(own());
  cashStorage = new ObjectId();
  const common = ctx.databases.common();
  companyId = (await common.collection('places').findOne({ _id: own() }))!['companyId'] as ObjectId;
  await common.collection('places').updateOne({ _id: own() }, { $set: { storages: [{ id: new ObjectId(), cash: false }, { id: cashStorage, cash: true }] } });
  await common.collection('companies').updateOne({ _id: companyId }, { $set: COMPANY });
  dealerId = new ObjectId();
  await common.collection('groups').updateOne({ _id: gid() }, { $set: { dealerId } });
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});
beforeEach(async () => {
  limiter.reset();
  await Promise.all([salesOf().deleteMany({}), salesOf(1).deleteMany({}), documentsOf().deleteMany({}), documentsOf(1).deleteMany({}), db().collection('document_counters').deleteMany({}), db(1).collection('document_counters').deleteMany({}), db().collection('contacts').deleteMany({}), db(1).collection('contacts').deleteMany({}), db().collection('sales_tombstones').deleteMany({}), queue().deleteMany({})]);
  await ctx.databases.common().collection('companies').updateOne({ _id: companyId }, { $set: { 'fattura_elettronica.hub': HUB } });
});

describe('the invoice of a sale', () => {
  it('creates the document in the shape of the legacy with the copies built from the database, numbers it, and answers with where to print it', async () => {
    const item = await product();
    const buyer = await customer();
    const created = await post(
      invoiceBody([saleLine(item, { XML: { AltriDatiGestionali: [{ TipoDato: 'T1', RiferimentoTesto: 'rif', RiferimentoData: '2026-01-01', Evil: 1 }], Extra: 1 } })], {
        customer: { contactId: hex(buyer) },
        note: 'Grazie',
        invoice: { type: 'TD02', xml: { FatturaElettronicaBody: { DatiGenerali: { DatiOrdineAcquisto: { IdDocumento: 'ORD-1', CodiceCIG: 'CIG1', Pwn: 1 } }, Pwn: { a: 1 } }, Pwn: 1 } },
      }),
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const data = created.body.data;
    const document = await documentOf(data.id);
    assert.deepEqual(data.invoice, { documentId: hex(document['_id']), number: 1, prefixSuffix: 'A', prefixSuffixPosition: 'prefix', year: 2026, sendStatus: 'queued' });
    const sale = await saleOf(data.id);
    const { queuedAt, ...reference } = sale['floodCloud'].invoice as Document;
    assert.deepEqual(reference, { documentId: document['_id'], number: 1, prefixSuffix: 'A', year: 2026 });
    assert.ok(queuedAt instanceof Date, 'the attempt to queue it is marked in the sale');
    // The shape of the legacy document, and what this backend adds (`insertDate`, `groupId` with a hub).
    assert.deepEqual(Object.keys(document).sort(), ['XML', '_id', 'adjustmentType', 'company', 'companyId', 'counterpart', 'customerType', 'date', 'discountPercentage', 'discountValue', 'fattura_elettronica', 'groupId', 'insertDate', 'note', 'number', 'placeId', 'prefixSuffix', 'records', 'saleId', 'saleTimestampId', 'sendStatus', 'storageId', 'total', 'totalLastPrices', 'totalTax', 'totalTaxable', 'totalTaxableWithoutDiscount', 'totalWithoutDiscount', 'type', 'updateDate', 'userId']);
    assert.deepEqual([document['type'], document['number'], document['prefixSuffix'], document['date'], document['companyId'], document['placeId'], document['storageId'], document['saleId'], document['saleTimestampId'], document['customerType'], document['note'], document['userId'], document['groupId']], ['invoice', 1, 'A', sale['date'], sale['companyId'], sale['placeId'], cashStorage, sale['_id'], sale['timestampId'], 2, 'Grazie', null, gid()]);
    assert.deepEqual(document['fattura_elettronica'], { tipo: 'TD02', progressivo_invio: 1 });
    assert.deepEqual(document['XML'], { FatturaElettronicaBody: { DatiGenerali: { DatiOrdineAcquisto: { IdDocumento: 'ORD-1', CodiceCIG: 'CIG1' } } } });
    assert.deepEqual([document['insertDate'] instanceof Date, document['updateDate'] instanceof Date, document['sendStatus']], [true, true, 'queued']);
    // The lines are the ones of the sale, with the management data of the line by allowlist.
    assert.deepEqual(document['records'], sale['products']);
    assert.deepEqual((document['records'] as Document[])[0]!['XML'], { AltriDatiGestionali: [{ TipoDato: 'T1', RiferimentoTesto: 'rif', RiferimentoData: '2026-01-01' }] });
    // The totals are numbers, with the types the driver gives them (the legacy's: whole numbers are Int32, the others Double).
    const types = (await documentsOf().aggregate([{ $project: { _id: 0, number: { $type: '$number' }, total: { $type: '$total' }, totalTaxable: { $type: '$totalTaxable' }, date: { $type: '$date' }, saleId: { $type: '$saleId' }, companyId: { $type: '$companyId' }, progressive: { $type: '$fattura_elettronica.progressivo_invio' } } }]).toArray())[0]!;
    assert.deepEqual(types, { number: 'int', total: 'double', totalTaxable: 'int', date: 'date', saleId: 'objectId', companyId: 'objectId', progressive: 'int' });
    // The company is a copy built from the database, by allowlist: nothing of the client, nothing secret.
    const company = document['company'] as Document;
    assert.deepEqual(Object.keys(company).sort(), ['_id', 'address', 'banks', 'city', 'code', 'code2', 'countryAreaCode', 'countryCode', 'currencyCode', 'email', 'fattura_elettronica', 'invoicesPS', 'invoicesPSValues', 'name', 'postcode', 'settings', 'telephone']);
    assert.deepEqual(company['settings'], { global: { discountLines: true } });
    assert.deepEqual(Object.keys(company['fattura_elettronica']).sort(), ['IdTrasmittente_codice', 'IdTrasmittente_paese', 'hub', 'rea_capitale_sociale', 'rea_liquidazione', 'rea_numero', 'rea_soci', 'rea_ufficio', 'regime_fiscale']);
    assert.equal(JSON.stringify(company).includes('never-copied') || JSON.stringify(company).includes('secret-list') || JSON.stringify(company).includes('logo.png'), false);
    // The counterpart is the contact of the database, with what the invoice reads and nothing of the account, the services, the notes or the cards.
    const counterpart = document['counterpart'] as Document;
    assert.deepEqual([counterpart['_id'], counterpart['companyName'], counterpart['companyCity'], counterpart['fattura_elettronica'].riferimento_amministrazione, counterpart['fattura_elettronica'].formato_trasmissione], [buyer, 'Acme Srl', 'Torino', '', 'FPR12']);
    for (const forbidden of ['account', 'tokens', 'services', 'note', 'fidelities', 'legacyExtra', 'associatedCompany', 'cGroup', 'companyLists', 'trash', 'birthDate', 'discount']) {
      assert.equal(forbidden in counterpart, false, forbidden);
    }
    assert.equal(JSON.stringify(counterpart).includes('dead-password') || JSON.stringify(counterpart).includes('dead-token') || JSON.stringify(counterpart).includes('internal note'), false);
    // The queue: the record has the id of the document, the dealer, the document and the fields of the sale the consumer reads, and nothing of the consumer's.
    const record = (await queue().findOne({ _id: document['_id'] }))!;
    assert.deepEqual([record['dealerId'], record['groupId'], record['sendStatus'], record['sale'], record['number'], record['total'], 'hubId' in record, 'sent' in record, 'error' in record], [dealerId, gid(), null, { _id: sale['_id'], fullMeal: null }, 1, 24.4, false, false, false]);
    assert.deepEqual(record['company'], company);
    assert.deepEqual(record['counterpart'], counterpart);
    assert.equal(await queue().countDocuments(), 1);
    assert.equal(sale['status'], undefined);
    assert.deepEqual(anomalyCodes(sale), []);
  });

  it('sends nothing to the queue and consumes no progressive when the company has no hub', async () => {
    await setHub('');
    const item = await product();
    const buyer = await customer();
    const first = await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } }));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body.data.invoice, { documentId: first.body.data.invoice.documentId, number: 1, prefixSuffix: 'A', prefixSuffixPosition: 'prefix', year: 2026, sendStatus: null });
    const document = await documentOf(first.body.data.id);
    assert.deepEqual([document['sendStatus'], document['fattura_elettronica'], 'groupId' in document, document['company'].fattura_elettronica.hub], [null, { tipo: 'TD01', progressivo_invio: null }, false, '']);
    assert.equal(await queue().countDocuments(), 0);
    assert.equal(await db().collection('document_counters').countDocuments({ series: '_sendProgressive' }), 0);
    // A hub of another provider is not a hub of the e-invoicing either.
    await setHub('other');
    const second = await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } }));
    assert.equal(second.body.data.invoice.number, 2);
    assert.equal(second.body.data.invoice.sendStatus, null);
    assert.equal(await queue().countDocuments(), 0);
  });

  it('writes the progressive of the sending only for the invoices that go through the hub, one per company and year', async () => {
    const item = await product();
    const buyer = await customer();
    const progressive = async (saleId: string) => (await documentOf(saleId))['fattura_elettronica'].progressivo_invio;
    const a = await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } }));
    await setHub('');
    const b = await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } }));
    await setHub(HUB);
    const c = await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } }));
    assert.deepEqual([await progressive(a.body.data.id), await progressive(b.body.data.id), await progressive(c.body.data.id)], [1, null, 2]);
    assert.deepEqual([a, b, c].map((reply) => reply.body.data.invoice.number), [1, 2, 3]);
  });

  it('answers a repeated invoice with the same document and number, and never makes a second one', async () => {
    const item = await product();
    const buyer = await customer();
    const body = invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } });
    const first = await post(body);
    const again = await post(body);
    assert.deepEqual([first.status, again.status], [201, 200]);
    assert.deepEqual(again.body.data.invoice, first.body.data.invoice);
    assert.equal(await documentsOf().countDocuments(), 1);
    assert.equal(await queue().countDocuments(), 1);
    // A sale of the legacy with the same key and its document (the legacy's number, no reference in the sale): the same document again, never a new number.
    const legacySale = new ObjectId();
    const legacyDocument = new ObjectId();
    const date = new Date('2026-11-20T10:00:00Z');
    await salesOf().insertOne({ _id: legacySale, timestampId: 'L-1', placeId: own(), companyId, date, finalTotalCheckout: 5, products: [], refund: [], sType: false, fiscalState: '', receiptType: 'invoice' });
    await documentsOf().insertOne({ _id: legacyDocument, companyId, date, saleId: legacySale, type: 'invoice', number: 77, prefixSuffix: '', company: { invoicesPS: 'suffix' }, sendStatus: 'sent' });
    const legacy = await post(invoiceBody([saleLine(item)], { timestampId: 'L-1' }));
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.body.data.invoice, { documentId: hex(legacyDocument), number: 77, prefixSuffix: '', prefixSuffixPosition: 'suffix', year: 2026, sendStatus: 'sent' });
    assert.equal(await documentsOf().countDocuments(), 2, 'no document was made for the legacy sale');
    // An invoice sale of the legacy with no document: nothing to show.
    await salesOf().insertOne({ _id: new ObjectId(), timestampId: 'L-2', placeId: own(), companyId, date, finalTotalCheckout: 5, products: [], refund: [], sType: false, fiscalState: '', receiptType: 'invoice' });
    assert.equal((await post(invoiceBody([saleLine(item)], { timestampId: 'L-2' }))).body.data.invoice, null);
    // A receipt repeated has no invoice.
    const receipt = await post(saleBody([saleLine(item)], { timestampId: 'R-1' }));
    assert.equal((await post(saleBody([saleLine(item)], { timestampId: 'R-1' }))).body.data.invoice, null);
    assert.equal(receipt.body.data.invoice, null);
  });

  it('puts a document that did not reach the queue in the queue again when the till sends the sale again, once', async () => {
    const item = await product();
    const buyer = await customer();
    const body = invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } });
    const first = await post(body);
    const id = new ObjectId(first.body.data.invoice.documentId);
    // The first attempt reached the queue: a document that says `notQueued` but whose sale has the mark of the attempt is never queued again.
    await queue().deleteMany({});
    await documentsOf().updateOne({ _id: id }, { $set: { sendStatus: 'notQueued' } });
    assert.deepEqual([(await post(body)).body.data.invoice.sendStatus, await queue().countDocuments()], ['notQueued', 0]);
    // The first attempt did not reach it (the mark was taken back): the document waits as `notQueued`, with no record, and the repetition queues it.
    await salesOf().updateOne({ 'floodCloud.invoice.documentId': id }, { $unset: { 'floodCloud.invoice.queuedAt': '' } });
    const retried = await post(body);
    assert.deepEqual([retried.status, retried.body.data.invoice.sendStatus, retried.body.data.invoice.number], [200, 'queued', 1]);
    assert.deepEqual([(await documentsOf().findOne({ _id: id }))!['sendStatus'], await queue().countDocuments({ _id: id })], ['queued', 1]);
    // The record is there already (the mark did not reach the document): it is not written twice and the document is marked.
    await queue().updateOne({ _id: id }, { $set: { hubId: 'h-1', sent: true } });
    await documentsOf().updateOne({ _id: id }, { $set: { sendStatus: 'notQueued' } });
    await salesOf().updateOne({ 'floodCloud.invoice.documentId': id }, { $unset: { 'floodCloud.invoice.queuedAt': '' } });
    assert.equal((await post(body)).body.data.invoice.sendStatus, 'queued');
    assert.deepEqual([await queue().countDocuments(), (await queue().findOne({ _id: id }))!['hubId']], [1, 'h-1']);
    // A document the worker has already moved on is left alone: no record is made for it.
    await queue().deleteMany({});
    await documentsOf().updateOne({ _id: id }, { $set: { sendStatus: 'sent' } });
    assert.equal((await post(body)).body.data.invoice.sendStatus, 'sent');
    assert.equal(await queue().countDocuments(), 0);
  });

  it('makes no number and no document for an invoice with no customer: the sale is saved with the anomaly and answers invoice null', async () => {
    const item = await product();
    const missing = await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(new ObjectId()) } }));
    assert.equal(missing.status, 201);
    assert.equal(missing.body.data.invoice, null);
    assert.deepEqual([await documentsOf().countDocuments(), await db().collection('document_counters').countDocuments(), await queue().countDocuments()], [0, 0, 0]);
    assert.deepEqual(anomalyCodes(await saleOf(missing.body.data.id)).sort(), ['sale:customerMissing', 'sale:invoiceCounterpartMissing']);
    // Nor does a repeat make one, and no customer named at all is the same.
    const again = await post(invoiceBody([saleLine(item)], { timestampId: (await saleOf(missing.body.data.id))['timestampId'], customer: { contactId: hex(new ObjectId()) } }));
    assert.deepEqual([again.status, again.body.data.invoice], [200, null]);
    const bare = await post(invoiceBody([saleLine(item)]));
    assert.deepEqual([bare.body.data.invoice, anomalyCodes(await saleOf(bare.body.data.id))], [null, ['sale:invoiceCounterpartMissing']]);
    // The next invoice with a customer is the first.
    const buyer = await customer();
    assert.equal((await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } }))).body.data.invoice.number, 1);
    // The backoffice is refused instead.
    const refused = await backoffice(world.group(0).sa, { ...invoiceBody([saleLine(item)]), companyId: hex(companyId), placeId: hex(own()) });
    assert.deepEqual([refused.status, refused.body.error.details], [422, [{ field: 'customer', issue: 'incorrect' }]]);
  });

  it('numbers without ever repeating a number, whoever asks: the till, the backoffice, several tills at once and the legacy in between', async () => {
    const item = await product();
    const buyer = await customer();
    await documentsOf().insertOne({ _id: new ObjectId(), companyId, type: 'invoice', prefixSuffix: 'A', number: 9, date: new Date('2026-06-01T00:00:00Z'), fattura_elettronica: { progressivo_invio: 5 } });
    const forms = Array.from({ length: 6 }, (_, index) => invoiceBody([saleLine(item)], { timestampId: `C-${String(index)}`, customer: { contactId: hex(buyer) } }));
    const fromBackoffice = Array.from({ length: 4 }, (_, index) => ({ ...invoiceBody([saleLine(item)], { timestampId: `B-${String(index)}`, customer: { contactId: hex(buyer) } }), companyId: hex(companyId), placeId: hex(own()) }));
    const replies = await Promise.all([...forms.map((body) => post(body)), ...fromBackoffice.map((body) => backoffice(world.group(0).sa, body))]);
    assert.deepEqual(replies.map((reply) => reply.status), Array(10).fill(201), JSON.stringify(replies.find((reply) => reply.status !== 201)?.body));
    const numbers = replies.map((reply) => reply.body.data.invoice.number as number).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 10 }, (_, index) => 10 + index), 'consecutive, after the highest the legacy wrote');
    const documents = await documentsOf().find({ saleId: { $exists: true } }).toArray();
    assert.equal(new Set(documents.map((document) => document['number'])).size, 10);
    assert.deepEqual(documents.map((document) => document['fattura_elettronica'].progressivo_invio as number).sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => 6 + index));
    assert.equal(await queue().countDocuments(), 10);
  });

  it('keeps the groups apart: another group has its own numbers, documents and queue records', async () => {
    const item = await product();
    const buyer = await customer();
    await post(invoiceBody([saleLine(item)], { customer: { contactId: hex(buyer) } }));
    const second = world.group(1);
    const secondKey = await world.activate(second.ownPlaceId, 1);
    const secondCompany = (await ctx.databases.common().collection('places').findOne({ _id: second.ownPlaceId }))!['companyId'] as ObjectId;
    await ctx.databases.common().collection('companies').updateOne({ _id: secondCompany }, { $set: { ...COMPANY, invoicesPSValues: [], invoicesPS: null, settings: { global: { lastInvoiceNumber: 0 } } } });
    const secondBuyer = legacyCompany();
    await db(1).collection('contacts').insertOne(secondBuyer);
    const reply = await world.asStore(secondKey.key, 'POST', '/store-context/sales', invoiceBody([saleLine(null)], { timestampId: 'G-1', customer: { contactId: hex(secondBuyer['_id']) } }));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.invoice.number, reply.body.data.invoice.prefixSuffix], [1, '']);
    assert.deepEqual([await documentsOf().countDocuments(), await documentsOf(1).countDocuments()], [1, 1]);
    assert.deepEqual((await queue().find({}).toArray()).map((record) => hex(record['groupId'])).sort(), [hex(gid()), hex(second.groupId)].sort());
    assert.equal(hex((await documentsOf(1).findOne({}))!['groupId']), hex(second.groupId));
  });
});

describe('the deferred invoice that gathers unpaid sales', () => {
  /** A sale that left something unpaid for a customer. */
  async function unpaidSale(buyer: ObjectId, overrides: Document = {}, key = `U-${String((counter += 1))}`): Promise<string> {
    const made = await post(saleBody([saleLine(null)], { timestampId: key, receiptType: 'charge', customer: { contactId: hex(buyer) }, payments: { unpaid: 24.4 }, fiscalReceiptInfo: null, ...overrides }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.data.id as string;
  }
  const statusOf = async (id: string) => (await saleOf(id))['status'];

  it('marks the valid sales as invoiced in the same transaction, makes it TD24, and leaves the others alone with an anomaly', async () => {
    const buyer = await customer();
    const other = await customer({ companyName: 'Other Srl' });
    const good = [await unpaidSale(buyer), await unpaidSale(buyer)];
    const paid = await unpaidSale(buyer, { payments: { cash: 24.4 } });
    const wrongCustomer = await unpaidSale(other);
    const canceled = await unpaidSale(buyer);
    await salesOf().updateOne({ _id: new ObjectId(canceled) }, { $set: { fiscalState: 'canceled' } });
    const returned = await unpaidSale(buyer);
    await salesOf().updateOne({ _id: new ObjectId(returned) }, { $set: { fiscalState: 'refunded' } });
    const already = await unpaidSale(buyer);
    await salesOf().updateOne({ _id: new ObjectId(already) }, { $set: { status: 'invoiced' } });
    const invoice = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, payments: { cash: 24.4 } }));
    const anInvoice = invoice.body.data.id as string;
    const strangeCompany = await unpaidSale(buyer);
    await salesOf().updateOne({ _id: new ObjectId(strangeCompany) }, { $set: { companyId: new ObjectId() } });
    const ghost = new ObjectId();
    const unpaidSaleIds = [...good, paid, wrongCustomer, canceled, returned, already, anInvoice, strangeCompany, hex(ghost), good[0]!];
    const created = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, unpaidSaleIds }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const document = await documentOf(created.body.data.id);
    assert.equal(document['fattura_elettronica'].tipo, 'TD24');
    assert.deepEqual(await Promise.all(good.map(statusOf)), ['invoiced', 'invoiced']);
    for (const untouched of [paid, wrongCustomer, canceled, returned, strangeCompany, anInvoice]) {
      assert.notEqual(await statusOf(untouched), 'invoiced', untouched);
    }
    assert.equal(await statusOf(already), 'invoiced');
    const sale = await saleOf(created.body.data.id);
    const anomaly = (sale['floodCloud'].anomalies as Document[]).find((entry) => entry['code'] === 'unpaidSaleInvalid')!;
    assert.deepEqual([...(anomaly['ids'] as string[])].sort(), [paid, wrongCustomer, canceled, returned, already, anInvoice, strangeCompany, hex(ghost)].sort());
    // The sales gathered are no longer the same version (the `If-Match` of the backoffice).
    assert.ok((await saleOf(good[0]!))['updateDate'] instanceof Date);
  });

  it('keeps the type the till asked for, and gathers nothing for an invoice with no customer', async () => {
    const buyer = await customer();
    const unpaid = await unpaidSale(buyer);
    const typed = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, unpaidSaleIds: [unpaid], invoice: { type: 'TD26' } }));
    assert.equal((await documentOf(typed.body.data.id))['fattura_elettronica'].tipo, 'TD26');
    assert.equal(await statusOf(unpaid), 'invoiced');
    const second = await unpaidSale(buyer);
    const bare = await post(invoiceBody([saleLine(null)], { unpaidSaleIds: [second] }));
    assert.equal(bare.body.data.invoice, null, 'with no customer there is no invoice and nothing is gathered');
    assert.equal(await statusOf(second), undefined);
    assert.ok(anomalyCodes(await saleOf(bare.body.data.id)).includes('sale:invoiceCounterpartMissing'));
  });

  it('refuses from the backoffice a deferred invoice that names a sale it cannot gather, with the positions, and writes nothing', async () => {
    const buyer = await customer();
    const good = await unpaidSale(buyer);
    const paid = await unpaidSale(buyer, { payments: { cash: 24.4 } });
    const payload = { ...invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, unpaidSaleIds: [good, paid, hex(new ObjectId())] }), companyId: hex(companyId), placeId: hex(own()) };
    const refused = await backoffice(world.group(0).sa, payload);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.error.details, [{ field: 'unpaidSaleIds.1', issue: 'invalid' }, { field: 'unpaidSaleIds.2', issue: 'invalid' }]);
    assert.deepEqual([await statusOf(good), await documentsOf().countDocuments(), await queue().countDocuments(), await db().collection('document_counters').countDocuments()], [undefined, 0, 0, 0]);
    const accepted = await backoffice(world.group(0).sa, { ...payload, timestampId: 'BO-OK', unpaidSaleIds: [good] });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.invoice.number, 1, 'the refused attempt consumed no number');
    assert.equal(await statusOf(good), 'invoiced');
  });

  it('never gathers the same sales twice when two deferred invoices ask at the same moment', async () => {
    const buyer = await customer();
    const unpaid = await Promise.all(Array.from({ length: 5 }, () => unpaidSale(buyer)));
    const replies = await Promise.all(Array.from({ length: 4 }, (_, index) => post(invoiceBody([saleLine(null)], { timestampId: `D-${String(index)}`, customer: { contactId: hex(buyer) }, unpaidSaleIds: unpaid }))));
    assert.deepEqual(replies.map((reply) => reply.status), [201, 201, 201, 201]);
    const gathered = await Promise.all(replies.map(async (reply) => ((await saleOf(reply.body.data.id))['floodCloud'].anomalies as Document[]).filter((entry) => entry['code'] === 'unpaidSaleInvalid').length));
    assert.equal(gathered.filter((count) => count === 0).length, 1, 'exactly one invoice gathered them');
    assert.deepEqual(await Promise.all(unpaid.map(statusOf)), Array(5).fill('invoiced'));
  });

  it('refuses at the door what the body may not say: unpaid sales on a receipt, the delivery notes, more than 500, unknown fields', async () => {
    const buyer = await customer();
    const unpaid = await unpaidSale(buyer);
    const status = async (extra: Document) => (await post(saleBody([saleLine(null)], { timestampId: `V-${String((counter += 1))}`, ...extra }))).status;
    assert.deepEqual(
      [
        await status({ unpaidSaleIds: [unpaid] }),
        await status({ invoice: { type: 'TD01' } }),
        await status({ receiptType: 'invoice', deliveryIds: [hex(new ObjectId())] }),
        await status({ receiptType: 'invoice', unpaidSaleIds: Array.from({ length: 501 }, () => hex(new ObjectId())) }),
        await status({ receiptType: 'invoice', invoice: { type: 'TD99' } }),
        await status({ receiptType: 'invoice', invoice: { other: 1 } }),
        await status({ receiptType: 'invoice', deliveryIds: [] }),
      ],
      [422, 422, 422, 422, 422, 422, 201],
    );
    assert.equal(await statusOf(unpaid), undefined);
  });
});

describe('the sale that has an invoice', () => {
  it('is never deleted, even as a quote', async () => {
    const created = await post(invoiceBody([saleLine(null)], { nonFiscal: true, fiscalReceiptInfo: null }));
    assert.equal(created.status, 201);
    const refused = await send('DELETE', `/store-context/sales/${created.body.data.id}`);
    assert.deepEqual([refused.status, refused.body.error.details], [409, [{ field: 'receiptType', issue: 'invoice' }]]);
    assert.equal(await salesOf().countDocuments(), 1);
  });

  it('is cancelled as any sale: the document stays, with its number', async () => {
    const buyer = await customer();
    const created = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) } }));
    const canceled = await send('POST', `/store-context/sales/${created.body.data.id}/cancellation`, { date: '2026-11-27T11:00:00.000Z' });
    assert.equal(canceled.status, 201, JSON.stringify(canceled.body));
    assert.equal(await documentsOf().countDocuments({ saleId: new ObjectId(created.body.data.id) }), 1);
  });
});

describe('the corrections of the security review', () => {
  it('queues an invoice only through a hub that may carry the group: aruba always, aruba__<dealer> only for that dealer', async () => {
    const item = await product();
    const buyer = await customer();
    const make = async (key: string) => post(invoiceBody([saleLine(item)], { timestampId: key, customer: { contactId: hex(buyer) } }));
    // The hub of another dealer: the invoice is made and numbered, never queued, no progressive is consumed, and the anomaly says why.
    await setHub(`aruba__${hex(new ObjectId())}`);
    const foreign = await make('H-1');
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
    const document = await documentOf(foreign.body.data.id);
    assert.deepEqual([foreign.body.data.invoice.sendStatus, foreign.body.data.invoice.number, document['sendStatus'], document['fattura_elettronica'].progressivo_invio, 'groupId' in document, await queue().countDocuments()], ['notQueued', 1, 'notQueued', null, false, 0]);
    assert.deepEqual(anomalyCodes(await saleOf(foreign.body.data.id)), ['sale:invoiceHubMismatch']);
    // The same repetition does not queue it either (no progressive: it was never meant for the queue).
    assert.deepEqual([(await make('H-1')).body.data.invoice.sendStatus, await queue().countDocuments()], ['notQueued', 0]);
    // The hub of the dealer of the group works, and the one the foreign invoice did not take is the first progressive.
    await setHub(`aruba__${hex(dealerId)}`);
    const own = await make('H-2');
    assert.deepEqual([own.body.data.invoice.sendStatus, (await documentOf(own.body.data.id))['fattura_elettronica'].progressivo_invio, await queue().countDocuments()], ['queued', 1, 1]);
    // A group with no dealer cannot use a dealer's hub, and the platform's hub is for everybody.
    await ctx.databases.common().collection('groups').updateOne({ _id: gid() }, { $unset: { dealerId: '' } });
    try {
      assert.equal((await make('H-3')).body.data.invoice.sendStatus, 'notQueued');
      await setHub('aruba');
      assert.equal((await make('H-4')).body.data.invoice.sendStatus, 'queued');
    } finally {
      await ctx.databases.common().collection('groups').updateOne({ _id: gid() }, { $set: { dealerId } });
    }
  });

  it('gathers unpaid sales only of the writer’s perimeter, never a quote, a parent bill or a sale of another point of sale', async () => {
    const buyer = await customer();
    const row = { customer: { _id: buyer }, companyId, unpaid: 10, status: '', fiscalState: '', sType: false, receiptType: 'charge', date: new Date('2026-11-01T10:00:00Z'), products: [], refund: [] };
    const fromAnotherPlace = new ObjectId();
    await salesOf().insertOne({ _id: fromAnotherPlace, ...row, timestampId: 'X-1', placeId: new ObjectId() });
    const quote = new ObjectId();
    await salesOf().insertOne({ _id: quote, ...row, timestampId: 'X-2', placeId: own(), sType: true });
    const parent = new ObjectId();
    await salesOf().insertOne({ _id: parent, ...row, timestampId: 'X-3', placeId: own(), receiptType: 'partitioned' });
    const good = new ObjectId();
    await salesOf().insertOne({ _id: good, ...row, timestampId: 'X-4', placeId: own(), sType: null });
    const status = async (id: ObjectId) => (await salesOf().findOne({ _id: id }))!['status'];
    const ids = [fromAnotherPlace, quote, parent, good].map(hex);
    // The store: its own point of sale, fiscal sales only.
    const created = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, unpaidSaleIds: ids }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([await status(fromAnotherPlace), await status(quote), await status(parent), await status(good)], ['', '', '', 'invoiced']);
    const anomaly = ((await saleOf(created.body.data.id))['floodCloud'].anomalies as Document[]).find((entry) => entry['code'] === 'unpaidSaleInvalid')!;
    assert.deepEqual([...(anomaly['ids'] as string[])].sort(), [hex(fromAnotherPlace), hex(quote), hex(parent)].sort());
    // The gathered ones are written in the document as the legacy keeps them.
    assert.deepEqual((await documentOf(created.body.data.id))['metadata'], { unpaidIds: [hex(good)] });
    // A place administrator, who reaches only his point of sale, cannot gather a sale of another one: 409 with its position; a group administrator can.
    const asPlace = (key: string, unpaidSaleIds: string[], actor = world.group(0).pa) => world.as.call(actor, 'POST', `/groups/${hex(gid())}/sales`, { ...invoiceBody([saleLine(null)], { timestampId: key, customer: { contactId: hex(buyer) }, unpaidSaleIds }), companyId: hex(companyId), placeId: hex(own()) }, { 'idempotency-key': randomUUID() });
    const refused = await asPlace('PA-1', [hex(good), hex(fromAnotherPlace), hex(quote)].map((id, index) => (index === 0 ? hex(new ObjectId()) : id)));
    assert.deepEqual([refused.status, refused.body.error.details], [409, [{ field: 'unpaidSaleIds.0', issue: 'invalid' }, { field: 'unpaidSaleIds.1', issue: 'invalid' }, { field: 'unpaidSaleIds.2', issue: 'invalid' }]]);
    assert.equal((await asPlace('PA-2', [hex(fromAnotherPlace)])).status, 409);
    assert.equal((await asPlace('SA-1', [hex(fromAnotherPlace)], world.group(0).sa)).status, 201);
    assert.equal(await status(fromAnotherPlace), 'invoiced');
    assert.equal(await documentsOf().countDocuments(), 2);
  });

  it('flags a TD24 that gathers nothing: an anomaly for the till, 422 for the backoffice', async () => {
    const buyer = await customer();
    const created = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, invoice: { type: 'TD24' } }));
    assert.equal(created.status, 201);
    assert.deepEqual([(await documentOf(created.body.data.id))['fattura_elettronica'].tipo, anomalyCodes(await saleOf(created.body.data.id))], ['TD24', ['sale:invoiceTypeWithoutUnpaid']]);
    const refused = await backoffice(world.group(0).sa, { ...invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, invoice: { type: 'TD24' } }), companyId: hex(companyId), placeId: hex(own()) });
    assert.deepEqual([refused.status, refused.body.error.details], [422, [{ field: 'invoice.type', issue: 'incorrect' }]]);
  });

  it('takes the bank data of a payment only from a bank of the company, the beneficiary from the company, and drops what is out of its domain with an anomaly', async () => {
    const buyer = await customer();
    const bank = COMPANY.banks[0]!;
    const xml = {
      FatturaElettronicaBody: {
        DatiPagamento: {
          CondizioniPagamento: 'TP09',
          DettaglioPagamento: [
            { ModalitaPagamento: 'MP05', ImportoPagamento: 24.4, DataScadenzaPagamento: '2026-12-31', Beneficiario: 'Mallory', IBAN: bank.iban, ABI: '99999', BIC: 'EVIL0000', IstitutoFinanziario: 'Evil Bank' },
            { ModalitaPagamento: 'MP08', IBAN: 'DE89370400440532013000', ABI: bank.abi },
          ],
        },
        DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'S' } },
        DatiGenerali: { DatiOrdineAcquisto: { IdDocumento: 'a<b&c' } },
      },
    };
    const created = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, invoice: { xml } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual((await documentOf(created.body.data.id))['XML'], {
      FatturaElettronicaBody: {
        DatiPagamento: {
          DettaglioPagamento: [
            { Beneficiario: 'Acme Spa', ModalitaPagamento: 'MP05', DataScadenzaPagamento: '2026-12-31', ImportoPagamento: 24.4, IBAN: bank.iban, IstitutoFinanziario: 'Bank', ABI: '05428', CAB: '11101', BIC: 'BPBAIT3B' },
            { Beneficiario: 'Acme Spa', ModalitaPagamento: 'MP08' },
          ],
        },
      },
    });
    const anomalies = ((await saleOf(created.body.data.id))['floodCloud'].anomalies as Document[]).map((entry) => [entry['code'], entry['fields']]);
    assert.deepEqual(anomalies.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
      ['invoiceIbanUnknown', ['FatturaElettronicaBody.DatiPagamento.DettaglioPagamento.1.IBAN']],
      ['invoiceSplitPaymentDenied', ['FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo.EsigibilitaIVA']],
      ['invoiceXmlInvalid', ['FatturaElettronicaBody.DatiGenerali.DatiOrdineAcquisto.IdDocumento', 'FatturaElettronicaBody.DatiPagamento.CondizioniPagamento']],
    ]);
    // A customer with the split payment may have it.
    const split = await customer({ fattura_elettronica: { formato_trasmissione: 'FPR12', split_payment: true } });
    const allowed = await post(invoiceBody([saleLine(null)], { customer: { contactId: hex(split) }, invoice: { xml: { FatturaElettronicaBody: { DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'S' } } } } } }));
    assert.deepEqual([(await documentOf(allowed.body.data.id))['XML'], anomalyCodes(await saleOf(allowed.body.data.id))], [{ FatturaElettronicaBody: { DatiBeniServizi: { DatiRiepilogo: { EsigibilitaIVA: 'S' } } } }, []]);
    // The backoffice is refused instead, with every position, and nothing is written.
    const before = await documentsOf().countDocuments();
    const refused = await backoffice(world.group(0).sa, { ...invoiceBody([saleLine(null)], { customer: { contactId: hex(buyer) }, invoice: { xml } }), companyId: hex(companyId), placeId: hex(own()) });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body.error.details.map((detail: Document) => `${detail['field']}:${detail['issue']}`).sort(), [
      'invoice.xml.FatturaElettronicaBody.DatiBeniServizi.DatiRiepilogo.EsigibilitaIVA:notAllowed',
      'invoice.xml.FatturaElettronicaBody.DatiGenerali.DatiOrdineAcquisto.IdDocumento:incorrect',
      'invoice.xml.FatturaElettronicaBody.DatiPagamento.CondizioniPagamento:incorrect',
      'invoice.xml.FatturaElettronicaBody.DatiPagamento.DettaglioPagamento.1.IBAN:unknownIban',
    ]);
    assert.equal(await documentsOf().countDocuments(), before);
  });

  it('numbers an invoice only inside the window of the dates: the previous year and this one, up to tomorrow', async () => {
    const buyer = await customer();
    const year = new Date().getUTCFullYear();
    const make = (date: string, key: string) => post(invoiceBody([saleLine(null)], { timestampId: key, date, customer: { contactId: hex(buyer) } }));
    const last = await make(`${year - 1}-06-15T10:00:00.000Z`, 'D-1');
    assert.deepEqual([last.body.data.invoice.year, last.body.data.invoice.number], [year - 1, 1]);
    for (const [key, date] of [['D-2', `${year - 2}-12-31T10:00:00.000Z`], ['D-3', new Date(Date.now() + 3 * 86_400_000).toISOString()]] as const) {
      const out = await make(date, key);
      assert.equal(out.status, 201);
      assert.equal(out.body.data.invoice, null, key);
      assert.deepEqual(anomalyCodes(await saleOf(out.body.data.id)).filter((code) => code.includes('invoice')), ['sale:invoiceDateOutOfRange']);
    }
    assert.equal(await documentsOf().countDocuments(), 1);
    assert.equal(await db().collection('document_counters').countDocuments({ series: 'invoice' }), 1, 'the refused ones consumed nothing');
    const refused = await backoffice(world.group(0).sa, { ...invoiceBody([saleLine(null)], { date: new Date(Date.now() + 3 * 86_400_000).toISOString(), customer: { contactId: hex(buyer) } }), companyId: hex(companyId), placeId: hex(own()) });
    assert.deepEqual([refused.status, refused.body.error.details], [422, [{ field: 'date', issue: 'outOfRange' }]]);
  });

  it('stops a key that makes invoices in a flood (429 with Retry-After) and reports once the key that makes too many in a day', async () => {
    const item = await product();
    const buyer = await customer();
    const mark = world.office.activity.entries.length;
    const make = (index: number) => post(invoiceBody([saleLine(item)], { timestampId: `F-${String(index)}`, customer: { contactId: hex(buyer) } }));
    for (let index = 1; index <= 12; index += 1) {
      assert.equal((await make(index)).status, 201, String(index));
    }
    const alerts = () => world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'store.invoiceAlert');
    assert.equal(alerts().length, 0);
    assert.equal((await make(13)).status, 201);
    assert.deepEqual(alerts().map((entry) => [entry.metadata, entry.actor]), [[{ threshold: 12 }, { kind: 'store', id: new ObjectId(store.keyId) }]]);
    for (const index of [14, 15]) {
      assert.equal((await make(index)).status, 201);
    }
    assert.equal(alerts().length, 1, 'once for the day');
    const flooded = await make(16);
    assert.equal(flooded.status, 429);
    assert.ok(Number(flooded.headers.get('retry-after')) >= 1);
    assert.equal(await salesOf().countDocuments(), 15);
    // The other sales of the till are not held back by it.
    assert.equal((await post(saleBody([saleLine(item)], { timestampId: 'R-ok' }))).status, 201);
  });
});
