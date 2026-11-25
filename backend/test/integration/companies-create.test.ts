import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { sameDocument, expectedCopy } from '../../src/shared/legacy-write/copy-rule.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { ECOMMERCE_FLAGS } from '../../src/shared/legacy-write/company-paths.ts';
import { IBAN, VAT } from '../helpers/company-fixtures.ts';
import { TRASHED_DEALER, startCompaniesWorld } from '../helpers/companies.ts';
import type { CompaniesWorld } from '../helpers/companies.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: CompaniesWorld;
const call = (...args: Parameters<CompaniesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
const taken = { status: 409, code: 'CONFLICT', details: [{ field: 'vatNumber', issue: 'taken' }] };

/** A valid Italian company in the first group; every call picks a free VAT number. */
const NUMBERS = ['00743110157', '00905811006', '15844561009', '01114601006'];
let counter = 0;
const vat = (): string => NUMBERS[counter++ % NUMBERS.length]!;
const body = (overrides: Document = {}): Document => ({ name: 'Acme Test', vatNumber: '00743110157', address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' }, ...overrides });

before(async () => {
  ctx = await openTestDatabases();
  world = await startCompaniesWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

/** Removes the companies a test created, so the VAT numbers are free again. */
async function clean(): Promise<void> {
  await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('companies').deleteMany({ name: { $in: ['Acme Test', 'Full Co', 'Dealer Co', 'Second', 'Foreign Co', 'Free again'] } });
  await ctx.databases.common().collection('companies').deleteMany({ name: { $in: ['Acme Test', 'Full Co', 'Dealer Co', 'Second', 'Foreign Co', 'Free again'] } });
}

describe('POST /v1/groups/{groupId}/companies', () => {
  it('creates a company with the general data: 201, Location, ETag, the full representation, the legacy document and its identical copy', async () => {
    await clean();
    const mark = world.office.activity.entries.length;
    const reply = await call(world.group(0).sa, 'POST', world.path(0), body({ fiscalCode: null, email: 'Info@Acme.example', phone: '+39 02 1', currency: 'EUR' }));
    assert.equal(reply.status, 201);
    const company = reply.body.data;
    assert.equal(reply.headers.get('location'), `/v1${world.path(0, `/${company.id}`)}`);
    const id = ObjectId.createFromHexString(company.id);
    const document = (await world.stored(0, id))!;
    assert.equal(reply.headers.get('etag'), `"${versionOf('companies', document, TEST_VERSION_KEY)}"`);
    assert.deepEqual(
      [company.name, company.vatNumber, company.fiscalCode, company.status, company.trashed, company.currency, company.email, company.phone, company.expirationDate, company.groupId],
      ['Acme Test', '00743110157', null, 'active', false, 'EUR', 'info@acme.example', '+39 02 1', null, hex(world.group(0).groupId)],
    );
    assert.deepEqual(company.address, { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
    // The legacy document: top-level names and types, complete blocks.
    assert.deepEqual(
      [document['name'], document['code'], document['code2'], document['address'], document['countryCode'], document['countryAreaCode'], document['currencyCode'], document['status'], document['trash'], document['expirationDate']],
      ['Acme Test', '00743110157', '', 'Via Roma 1', 'IT', 'MI', 'EUR', true, false, null],
    );
    assert.deepEqual([document['groupId']], [world.group(0).groupId]);
    const invoicing = document['fattura_elettronica'] as Document;
    assert.equal(Object.keys(invoicing).length, 16);
    assert.deepEqual([invoicing['hub'], invoicing['regime_fiscale'], invoicing['rea_capitale_sociale']], ['', 'RF01', '']);
    const settings = document['settings'] as { global: Document; api: Document; ecommerce: Document };
    assert.equal(Object.keys(settings.ecommerce).length, 27);
    assert.deepEqual([settings.global['lastInvoiceNumber'], settings.api['cerved'], settings.ecommerce['minAmount']], [null, false, {}]);
    assert.deepEqual([document['banks'], document['ticketsSuppliers'], document['invoicesPSValues'], document['invoicesPS']], [[], [], [], null]);
    assert.deepEqual(document['medias'], { images: { internalFileName: '', externalUrl: '', customersAppLogoLight: null, customersAppLogoDark: null } });
    assert.ok(sameDocument(expectedCopy(document, world.group(0).groupId), (await world.copyOf(id))!));
    // The activity log names the company and holds no value but its name and state.
    const [entry] = world.office.activity.entries.slice(mark).filter((item) => item.action === 'company.created');
    assert.equal(entry!.resource!.id, hex(id));
    assert.deepEqual(entry!.changes!.map((change) => [change.field, change.after]), [['name', 'Acme Test'], ['status', 'active']]);
    // The read back is the same.
    assert.deepEqual((await call(world.group(0).sa, 'GET', world.path(0, `/${hex(id)}`))).body.data, company);
  });

  it('creates a company with every block, giving the BSON types of the legacy and an id to every account and issuer', async () => {
    await clean();
    const reply = await call(
      world.office.cluster.dealerA,
      'POST',
      world.path(0),
      body({
        name: 'Full Co',
        fiscalCode: vat() && VAT,
        status: 'disabled',
        expirationDate: '2030-06-01',
        address: { street: 'Via Roma 1', postcode: '20100', city: 'Milano', country: 'IT' },
        eInvoicing: { hub: `aruba__${hex(world.office.cluster.dealerA)}`, transmitter: { country: 'IT', code: '01879020517' }, recipientCode: 'abc1234', rea: { office: 'MI', number: '99', shareCapital: '1000.5', shareholders: 'SM', liquidation: 'LN' }, taxRegime: 'RF02' },
        invoiceNumbering: { position: 'suffix', values: [{ name: 'A', cash: true }], lastInvoiceNumber: 41, discountLines: true, cervedLookup: true },
        bankAccounts: [{ name: 'Main', iban: ' it60 x054 2811 1010 0000 0123 456', abi: '05428', cab: '11101', bic: 'deutdeff', default: true }, { iban: IBAN }],
        mealVoucherIssuers: [{ name: 'Pasti', cuts: [5, 7.5, null] }],
        customerApp: { enableLoginSignup: true, ecommerce: { status: true, priceListId: hex(fixtureId('group', 901)), minimumOrder: { EUR: 10, USD: 12.5 }, showProductRemainingQuantity: 2.5, catalogMode: true } },
        media: { internalFileName: 'logo.png', externalUrl: 'https://example.test/logo.png', customersAppLogoDark: null },
      }),
    );
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const company = reply.body.data;
    const document = (await world.stored(0, ObjectId.createFromHexString(company.id)))!;
    assert.deepEqual([document['status'], document['expirationDate'], document['code2']], [false, new Date('2030-06-01T00:00:00.000Z'), VAT]);
    const invoicing = document['fattura_elettronica'] as Document;
    assert.deepEqual([invoicing['hub'], invoicing['codice_destinatario'], invoicing['IdTrasmittente_codice'], invoicing['rea_capitale_sociale'], invoicing['rea_soci'], invoicing['regime_fiscale'], invoicing['email']], [`aruba__${hex(world.office.cluster.dealerA)}`, 'ABC1234', '01879020517', '1000.5', 'SM', 'RF02', '']);
    const settings = document['settings'] as { global: Document; api: Document; ecommerce: Document };
    assert.ok(settings.global['lastInvoiceNumber'] instanceof Int32 && settings.global['lastInvoiceNumber'].value === 41);
    assert.deepEqual([settings.global['discountLines'], settings.global['enableLoginSignup'], settings.global['showTermsPage'], settings.api['cerved']], [true, true, false, true]);
    assert.ok(settings.ecommerce['showProductRemainingQuantity'] instanceof Double && settings.ecommerce['showProductRemainingQuantity'].value === 2.5);
    const minimum = settings.ecommerce['minAmount'] as { EUR: Document; USD: Document };
    assert.ok(minimum.EUR['value'] instanceof Int32 && minimum.USD['value'] instanceof Double);
    assert.deepEqual([settings.ecommerce['status'], settings.ecommerce['catalogMode'], settings.ecommerce['listId'], settings.ecommerce['enableFidelity']], [true, true, hex(fixtureId('group', 901)), false]);
    assert.equal(Object.keys(settings.ecommerce).length, 27);
    assert.equal(ECOMMERCE_FLAGS.length, 24);
    const banks = document['banks'] as Array<Document>;
    assert.deepEqual(banks.map((bank) => [bank['name'], bank['iban'], bank['abi'], bank['cab'], bank['bic'], bank['default']]), [['Main', IBAN, '05428', '11101', 'DEUTDEFF', true], ['', IBAN, '', '', '', false]]);
    assert.ok(banks.every((bank) => /^[0-9a-f]{24}$/.test(bank['id'] as string)) && banks[0]!['id'] !== banks[1]!['id']);
    assert.deepEqual((document['ticketsSuppliers'] as Array<Document>).map((issuer) => [issuer['name'], (issuer['cuts'] as Array<{ value: number } | null>).map((cut) => (cut === null ? null : cut.value))]), [['Pasti', [5, 7.5, null]]]);
    assert.ok(((document['ticketsSuppliers'] as Array<Document>)[0]!['cuts'] as unknown[])[0] instanceof Int32);
    assert.deepEqual([document['invoicesPS'], document['invoicesPSValues']], ['suffix', [{ name: 'A', cash: true }]]);
    assert.equal(((document['medias'] as Document)['images'] as Document)['externalUrl'], 'https://example.test/logo.png');
    assert.equal(company.bankAccounts[0].id, banks[0]!['id']);
    assert.ok(sameDocument(expectedCopy(document, world.group(0).groupId), (await world.copyOf(ObjectId.createFromHexString(company.id)))!));
    // The IBAN is in the response (who reads the company sees it) and nowhere in the log or the activity entries.
    assert.ok(JSON.stringify(reply.body).includes(IBAN));
    assert.ok(!JSON.stringify(world.office.activity.entries).includes(IBAN));
    assert.ok(world.office.logEvents.every((event) => !JSON.stringify(event).includes(IBAN)));
  });

  it('lets the PSA, the dealer and the SA create, and refuses the CA and the PA', async () => {
    await clean();
    const created = await call(psa(), 'POST', world.path(1), body({ vatNumber: '00905811006', name: 'Second' }));
    assert.equal(created.status, 201);
    assert.equal(created.body.data.groupId, hex(world.group(1).groupId));
    await clean();
    await ctx.databases.group(world.group(1).groupId, 'cluster0').collection('companies').deleteMany({ name: 'Second' });
    await ctx.databases.common().collection('companies').deleteMany({ name: 'Second' });
    for (const actor of [world.office.cluster.dealerA, world.group(0).sa]) {
      const reply = await call(actor, 'POST', world.path(0), body());
      assert.equal(reply.status, 201);
      await clean();
    }
    assert.deepEqual(failure(await call(world.group(0).ca, 'POST', world.path(0), body())), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.deepEqual(failure(await call(world.group(0).pa, 'POST', world.path(0), body())), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.equal((await call(world.office.cluster.dealerB, 'POST', world.path(0), body())).status, 404);
    assert.equal((await call(world.group(1).sa, 'POST', world.path(0), body())).status, 404);
  });

  it('refuses a SA that sends a reserved field with a value other than the default, accepts the defaults, and accepts any value from the PSA and a dealer', async () => {
    await clean();
    assert.deepEqual(failure(await call(world.group(0).sa, 'POST', world.path(0), body({ eInvoicing: { hub: 'aruba', transmitter: { country: 'IT', code: 'x' } }, status: 'disabled', expirationDate: '2030-01-01' }))), notAllowed('status', 'expirationDate', 'eInvoicing.hub', 'eInvoicing.transmitter.country', 'eInvoicing.transmitter.code'));
    assert.deepEqual(failure(await call(world.group(0).sa, 'POST', world.path(0), body({ eInvoicing: { hub: 'aruba' } }))), notAllowed('eInvoicing.hub'));
    assert.equal(await ctx.databases.common().collection('companies').countDocuments({ name: 'Acme Test' }), 0);
    assert.deepEqual(failure(await call(world.group(0).sa, 'POST', world.path(0), body({ invoiceNumbering: { cervedLookup: true } }))), notAllowed('invoiceNumbering.cervedLookup'));
    const defaults = await call(world.group(0).sa, 'POST', world.path(0), body({ invoiceNumbering: { cervedLookup: false }, status: 'active', expirationDate: null, eInvoicing: { hub: '', transmitter: { country: null, code: '' } } }));
    assert.equal(defaults.status, 201, JSON.stringify(defaults.body));
    await clean();
    for (const actor of [psa(), world.office.cluster.dealerA]) {
      assert.equal((await call(actor, 'POST', world.path(0), body({ eInvoicing: { hub: 'aruba' }, status: 'disabled' }))).status, 201);
      await clean();
    }
  });

  it('applies the hub rules of the role: the PSA any existing dealer, a dealer only none, aruba or himself', async () => {
    await clean();
    const dealerA = hex(world.office.cluster.dealerA);
    const dealerB = hex(world.office.cluster.dealerB);
    const hubOf = async (actor: ObjectId, hub: unknown) => call(actor, 'POST', world.path(0), body({ eInvoicing: { hub } }));
    assert.equal((await hubOf(psa(), `aruba__${dealerB}`)).status, 201);
    await clean();
    assert.equal((await hubOf(world.office.cluster.dealerA, `aruba__${dealerA}`)).status, 201);
    await clean();
    for (const hub of [null, '', 'aruba']) {
      assert.equal((await hubOf(world.office.cluster.dealerA, hub)).status, 201, String(hub));
      await clean();
    }
    assert.deepEqual(failure(await hubOf(world.office.cluster.dealerA, `aruba__${dealerB}`)), notAllowed('eInvoicing.hub'));
    // Unknown values are 422 incorrect: bad shape, a user that is not a dealer, a dealer in the trash, a made-up id.
    for (const hub of ['unknown-hub', 'aruba__', 'aruba__xyz', `aruba__${hex(world.group(0).sa)}`, `aruba__${hex(TRASHED_DEALER)}`, `aruba__${hex(new ObjectId())}`, `ARUBA`, `Aruba__${dealerA}`]) {
      assert.deepEqual(failure(await hubOf(psa(), hub)), issues(['eInvoicing.hub', 'incorrect']), hub);
    }
    assert.deepEqual(failure(await hubOf(world.office.cluster.dealerA, 'unknown-hub')), issues(['eInvoicing.hub', 'incorrect']));
    assert.equal(await ctx.databases.common().collection('companies').countDocuments({ name: 'Acme Test' }), 0);
  });

  it('validates the general data: required fields, formats, the country and its provinces', async () => {
    const sa = world.group(0).sa;
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), {})), issues(['name', 'required'], ['vatNumber', 'required'], ['address', 'required']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ name: ' ', address: { street: '', postcode: '', city: '', country: 'it' } }))), issues(['name', 'minLength'], ['address.street', 'minLength'], ['address.postcode', 'minLength'], ['address.city', 'minLength'], ['address.country', 'pattern']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ id: 'x', groupId: 'x', trashed: true, settings: {}, code: 'x', $set: 1 }))), issues(['id', 'unknown'], ['groupId', 'unknown'], ['trashed', 'unknown'], ['settings', 'unknown'], ['code', 'unknown'], ['(key)', 'forbiddenKey']));
    // A country that does not exist, a province outside the country, a province of a country without areas.
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ address: { street: 'x', postcode: '1', city: 'c', country: 'ZZ' } }))), issues(['address.country', 'incorrect']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ address: { street: 'x', postcode: '1', city: 'c', country: 'IT', province: 'TO' } }))), issues(['address.province', 'incorrect']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ vatNumber: 'DE123456789', address: { street: 'x', postcode: '1', city: 'c', country: 'DE', province: 'BE' } }))).status, 201);
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('companies').deleteMany({ code: 'DE123456789' });
    await ctx.databases.common().collection('companies').deleteMany({ code: 'DE123456789' });
  });

  it('applies the Italian VAT and fiscal code rules to an Italian company and the generic ones to the others', async () => {
    const sa = world.group(0).sa;
    for (const vatNumber of ['12345678901', 'IT12345678901', '0111460100', 'abc', '01114601006x']) {
      assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ vatNumber }))), issues(['vatNumber', 'format']), vatNumber);
    }
    for (const fiscalCode of ['01114601007', 'RSSMRA85T10A562T', 'abc', '12345']) {
      assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ fiscalCode }))), issues(['fiscalCode', 'format']), fiscalCode);
    }
    // Upper case is applied to the person's code; an Italian number keeps its IT prefix as given.
    await clean();
    const reply = await call(sa, 'POST', world.path(0), body({ vatNumber: 'IT00743110157', fiscalCode: 'rssmra85t10a562s' }));
    assert.equal(reply.status, 201);
    assert.deepEqual([reply.body.data.vatNumber, reply.body.data.fiscalCode], ['IT00743110157', 'RSSMRA85T10A562S']);
    await clean();
    // Another country: 2 to 30 printable characters, the fiscal code up to 30.
    const german = { street: 'x', postcode: '1', city: 'c', country: 'DE' };
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ vatNumber: 'D', address: german }))), issues(['vatNumber', 'format']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ vatNumber: 'DE1\u0007', address: german }))), issues(['vatNumber', 'format']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ vatNumber: 'x'.repeat(31), address: german }))), issues(['vatNumber', 'maxLength']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ vatNumber: 'DE123', fiscalCode: 'a\u0007b', address: german }))), issues(['fiscalCode', 'format']));
    const foreign = await call(sa, 'POST', world.path(0), body({ name: 'Foreign Co', vatNumber: 'DE 123 456 789', fiscalCode: 'any-code', address: german }));
    assert.equal(foreign.status, 201);
    assert.deepEqual([foreign.body.data.vatNumber, foreign.body.data.fiscalCode], ['DE 123 456 789', 'any-code']);
    await clean();
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('companies').deleteMany({ code: 'DE 123 456 789' });
    await ctx.databases.common().collection('companies').deleteMany({ code: 'DE 123 456 789' });
  });

  it('checks the currency, the price list, the minimum orders, the ids and the logos against the data of the group', async () => {
    const sa = world.group(0).sa;
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ currency: 'JPY' }))), issues(['currency', 'incorrect']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ customerApp: { ecommerce: { priceListId: 'nope', minimumOrder: { EUR: 1, JPY: 2 } } } }))), issues(['customerApp.ecommerce.priceListId', 'incorrect'], ['customerApp.ecommerce.minimumOrder.JPY', 'incorrect']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ bankAccounts: [{ id: 'unknown', iban: IBAN }], mealVoucherIssuers: [{ id: 'unknown', name: 'x' }] }))), issues(['bankAccounts.0.id', 'incorrect'], ['mealVoucherIssuers.0.id', 'incorrect']));
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ media: { customersAppLogoLight: { _id: 'x', basename: null, extension: null, filename: null, mimetype: null, title: null, alt: null, dirname: null, type: null, filectime: null } } }))), issues(['media.customersAppLogoLight', 'notAllowed']));
    // A disabled price list is not one the group offers.
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { [`priceLists.${hex(fixtureId('group', 901))}.status`]: false } });
    assert.deepEqual(failure(await call(sa, 'POST', world.path(0), body({ customerApp: { ecommerce: { priceListId: hex(fixtureId('group', 901)) } } }))), issues(['customerApp.ecommerce.priceListId', 'incorrect']));
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(0).groupId }, { $set: { [`priceLists.${hex(fixtureId('group', 901))}.status`]: true } });
    // Without a currency the default is the euro: a group that does not have it must say which one.
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $unset: { 'currencies.EUR': '' }, $set: { 'currencies.USD': { code: 'USD', symbol: '$' } } });
    assert.deepEqual(failure(await call(psa(), 'POST', world.path(1), body())), issues(['currency', 'required']));
    await ctx.databases.common().collection('groups').updateOne({ _id: world.group(1).groupId }, { $set: { 'currencies.EUR': { code: 'EUR', symbol: '&euro;' } } });
  });

  it('refuses a duplicate VAT number of the group in any written form, but not one of a trashed company or of another group', async () => {
    await clean();
    const first = await call(world.group(0).sa, 'POST', world.path(0), body());
    assert.equal(first.status, 201);
    for (const vatNumber of ['00743110157', 'IT00743110157', 'it00743110157']) {
      assert.deepEqual(failure(await call(world.group(0).sa, 'POST', world.path(0), body({ vatNumber }))), taken, vatNumber);
    }
    assert.equal(await ctx.databases.common().collection('companies').countDocuments({ name: 'Acme Test' }), 1);
    // Another group may have the same number.
    assert.equal((await call(psa(), 'POST', world.path(1), body())).status, 201);
    await ctx.databases.group(world.group(1).groupId, 'cluster0').collection('companies').deleteMany({ name: 'Acme Test' });
    await ctx.databases.common().collection('companies').deleteOne({ groupId: world.group(1).groupId, name: 'Acme Test' });
    // The trashed company frees its number.
    const id = ObjectId.createFromHexString(first.body.data.id);
    const trashed = await call(world.group(0).sa, 'POST', world.path(0, `/${hex(id)}/trash`), undefined, { 'if-match': first.headers.get('etag')! });
    assert.equal(trashed.status, 200);
    assert.equal((await call(world.group(0).sa, 'POST', world.path(0), body({ name: 'Free again' }))).status, 201);
  });

  it('answers 413 above 64 KB and 415 for another content type, 422 for a list, 400 for a JSON that is not an object', async () => {
    await clean();
    const big = await world.office.call('POST', world.path(0), await world.as.tokenOf(world.group(0).sa), { ...body(), name: 'x'.repeat(70_000) });
    assert.equal(big.status, 413);
    const text = await fetch(`${world.office.app.baseUrl}/v1${world.path(0)}`, { method: 'POST', headers: { ...world.office.userHeaders('POST', world.path(0), await world.as.tokenOf(world.group(0).sa)), 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 415);
    assert.equal((await call(world.group(0).sa, 'POST', world.path(0), [])).status, 422);
    assert.equal((await call(world.group(0).sa, 'POST', world.path(0), 'x')).status, 400);
    assert.equal((await world.office.call('POST', world.path(0), undefined, body())).status, 401);
  });
});
