import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Double, Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { expectedCopy, sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { IBAN, VAT } from '../helpers/company-fixtures.ts';
import { startCompaniesWorld } from '../helpers/companies.ts';
import type { CompaniesWorld } from '../helpers/companies.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';
import { differences } from '../helpers/legacy-write.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: CompaniesWorld;
const call = (...args: Parameters<CompaniesWorld['as']['call']>) => world.as.call(...args);
const failure = (reply: Awaited<ReturnType<typeof call>>) => world.as.failure(reply);
const hex = (id: ObjectId) => id.toHexString();
const psa = () => world.office.cluster.psa;
const dealerA = () => world.office.cluster.dealerA;
const dealerB = () => world.office.cluster.dealerB;
const sa = () => world.group(0).sa;
const ca = () => world.group(0).ca;
const issues = (...details: Array<[string, string]>) => ({ status: 422, code: 'VALIDATION_ERROR', details: details.map(([field, issue]) => ({ field, issue })) });
const notAllowed = (...fields: string[]) => ({ status: 403, code: 'FORBIDDEN', details: fields.map((field) => ({ field, issue: 'notAllowed' })) });
const precondition = { status: 412, code: 'PRECONDITION_FAILED', details: undefined };
const etagOf = (reply: Awaited<ReturnType<typeof call>>): string => reply.headers.get('etag')!;
const sub = (id: ObjectId, rest = ''): string => world.path(0, `/${hex(id)}${rest}`);

let sequence = 300;
/** A complete company of the first group; the CA of the group owns company 1, so a test that needs a CA uses {@link C1}. */
const fresh = async (overrides: Document = {}): Promise<{ id: ObjectId; etag: string; body: Document }> => {
  const n = sequence++;
  const id = await world.seed(0, n, { code: `FRESH-${String(n)}`, countryCode: 'DE', countryAreaCode: '', ...overrides });
  const reply = await call(psa(), 'GET', sub(id));
  return { id, etag: etagOf(reply), body: reply.body.data };
};
const patch = (actor: ObjectId, id: ObjectId, etag: string | undefined, bodyOf: unknown) => call(actor, 'PATCH', sub(id), bodyOf, etag === undefined ? {} : { 'if-match': etag });
const put = (actor: ObjectId, id: ObjectId, segment: string, etag: string | undefined, bodyOf: unknown) => call(actor, 'PUT', sub(id, `/${segment}`), bodyOf, etag === undefined ? {} : { 'if-match': etag });
const C1 = fixtureId('company', 1);

before(async () => {
  ctx = await openTestDatabases();
  world = await startCompaniesWorld(ctx);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('If-Match on the writes of a company', () => {
  it('is required, must be a strong tag and must be the current version', async () => {
    const { id, etag } = await fresh();
    for (const [method, path, bodyOf] of [
      ['PATCH', sub(id), { name: 'x' }],
      ['PUT', sub(id, '/media'), { internalFileName: '', externalUrl: '', customersAppLogoLight: null, customersAppLogoDark: null }],
      ['POST', sub(id, '/trash'), undefined],
      ['POST', sub(id, '/restore'), undefined],
      ['DELETE', sub(id), undefined],
    ] as Array<[string, string, unknown]>) {
      assert.deepEqual(failure(await call(psa(), method, path, bodyOf)), issues(['If-Match', 'required']), `${method} ${path}`);
      for (const header of ['*', 'W/' + etag, etag.slice(1, -1), `${etag}, ${etag}`, '""']) {
        assert.deepEqual(failure(await call(psa(), method, path, bodyOf, { 'if-match': header })), issues(['If-Match', 'format']), `${method} ${header}`);
      }
      assert.deepEqual(failure(await call(psa(), method, path, bodyOf, { 'if-match': `"${'A'.repeat(43)}"` })), precondition, `${method} ${path}`);
    }
  });

  it('gives 412 for a version that is no longer current, and the new version works', async () => {
    const { id, etag } = await fresh();
    const first = await patch(psa(), id, etag, { name: 'Second name' });
    assert.equal(first.status, 200);
    assert.notEqual(etagOf(first), etag);
    assert.deepEqual(failure(await patch(psa(), id, etag, { name: 'Third name' })), precondition);
    assert.equal((await patch(psa(), id, etagOf(first), { name: 'Third name' })).status, 200);
  });

  it('gives 412 when the legacy changes the company between the GET and the PATCH', async () => {
    const { id, etag } = await fresh();
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('companies').updateOne({ _id: id }, { $set: { city: 'Written by the legacy' } });
    assert.deepEqual(failure(await patch(psa(), id, etag, { name: 'Late' })), precondition);
    assert.equal((await world.stored(0, id))!['name'], 'Acme S.r.l.');
    // A change of the POS to what the backend does not own does not make the version stale.
    const again = await call(psa(), 'GET', sub(id));
    await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('companies').updateOne({ _id: id }, { $set: { 'settings.unknownSettings.keep': false, 'fattura_elettronica.unknownEInvoicing': 1 } });
    assert.equal((await patch(psa(), id, etagOf(again), { name: 'On time' })).status, 200);
  });
});

describe('PATCH /v1/groups/{groupId}/companies/{companyId}', () => {
  it('changes the given fields, writing only what differs, with the legacy types, the new ETag and an identical copy', async () => {
    const { id, etag } = await fresh();
    const before = (await world.stored(0, id))!;
    const reply = await patch(psa(), id, etag, {
      name: 'Renamed',
      fiscalCode: null,
      email: null,
      phone: '123',
      expirationDate: '2031-02-03T04:05:06Z',
      status: 'disabled',
      address: { city: 'Roma', province: '' },
      invoiceNumbering: { lastInvoiceNumber: 77, discountLines: false },
      customerApp: { ecommerce: { showProductRemainingQuantity: 1.5, catalogMode: true } },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const after = (await world.stored(0, id))!;
    assert.deepEqual(
      differences(before, after, ['name', 'code2', 'email', 'telephone', 'expirationDate', 'status', 'city', 'settings', 'updateDate']).sort(),
      ['city', 'code2', 'email', 'expirationDate', 'name', 'settings', 'status', 'telephone', 'updateDate'],
    );
    assert.deepEqual([after['name'], after['code2'], after['email'], after['telephone'], after['status'], after['city']], ['Renamed', '', null, '123', false, 'Roma']);
    assert.deepEqual(after['expirationDate'], new Date('2031-02-03T04:05:06.000Z'));
    const settings = after['settings'] as { global: Document; ecommerce: Document };
    assert.ok(settings.global['lastInvoiceNumber'] instanceof Int32 && settings.ecommerce['showProductRemainingQuantity'] instanceof Double);
    assert.equal(settings.global['discountLines'], false);
    // The keys the backend does not know are the same bytes.
    for (const [a, b] of [
      [after['futureKey'], before['futureKey']],
      [settings.global['unknownGlobal'], ((before['settings'] as Document)['global'] as Document)['unknownGlobal']],
      [settings.ecommerce['unknownEcommerce'], ((before['settings'] as Document)['ecommerce'] as Document)['unknownEcommerce']],
      [(after['settings'] as Document)['unknownSettings'], (before['settings'] as Document)['unknownSettings']],
      [(after['fattura_elettronica'] as Document)['unknownEInvoicing'], (before['fattura_elettronica'] as Document)['unknownEInvoicing']],
      [(after['medias'] as Document)['unknownMedia'], (before['medias'] as Document)['unknownMedia']],
    ]) {
      assert.ok(sameDocument({ v: a }, { v: b }));
    }
    assert.equal(etagOf(reply), `"${versionOf('companies', after, TEST_VERSION_KEY)}"`);
    assert.ok(sameDocument(expectedCopy(after, world.group(0).groupId), (await world.copyOf(id))!));
    assert.deepEqual([reply.body.data.name, reply.body.data.status, reply.body.data.address.city, reply.body.data.invoiceNumbering.lastInvoiceNumber, reply.body.data.fiscalCode], ['Renamed', 'disabled', 'Roma', 77, null]);
    assert.deepEqual((await call(psa(), 'GET', sub(id))).body.data, reply.body.data);
  });

  it('writes nothing, and keeps the version, for a request that sends the current values back', async () => {
    const { id, etag, body } = await fresh();
    const before = (await world.stored(0, id))!;
    const { id: _id, groupId: _group, trashed: _trashed, createdAt: _created, updatedAt: _updated, ...writable } = body;
    const reply = await patch(psa(), id, etag, writable);
    assert.equal(reply.status, 200);
    assert.equal(etagOf(reply), etag);
    assert.deepEqual(reply.body.data, body);
    assert.ok(sameDocument(before, (await world.stored(0, id))!));
    // A nested block with nothing in it changes nothing either.
    assert.equal(etagOf(await patch(psa(), id, etag, { eInvoicing: {}, address: {} })), etag);
  });

  it('refuses an empty body, unknown keys and values that are not valid, without touching the company', async () => {
    const { id, etag } = await fresh();
    const before = (await world.stored(0, id))!;
    assert.deepEqual(failure(await patch(psa(), id, etag, {})), issues(['(body)', 'required']));
    assert.deepEqual(failure(await patch(psa(), id, etag, { trashed: true, groupId: 'x', id: 'x' })), issues(['trashed', 'unknown'], ['groupId', 'unknown'], ['id', 'unknown']));
    assert.deepEqual(failure(await patch(psa(), id, etag, { name: '' })), issues(['name', 'minLength']));
    assert.deepEqual(failure(await patch(psa(), id, etag, { eInvoicing: { pec: 'nope', rea: { office: 'XX' } } })), issues(['eInvoicing.pec', 'format'], ['eInvoicing.rea.office', 'enum']));
    assert.equal((await call(psa(), 'PATCH', sub(id), undefined, { 'if-match': etag })).status, 422);
    assert.ok(sameDocument(before, (await world.stored(0, id))!));
    const big = await world.office.call('PATCH', sub(id), await world.as.tokenOf(psa()), { name: 'x'.repeat(70_000) }, { 'if-match': etag });
    assert.equal(big.status, 413);
  });

  it('is 404 outside the perimeter and 403 without the permission', async () => {
    const { id, etag } = await fresh();
    assert.equal((await patch(world.group(1).sa, id, etag, { name: 'x' })).status, 404);
    assert.equal((await patch(dealerB(), id, etag, { name: 'x' })).status, 404);
    assert.equal((await patch(psa(), new ObjectId(), etag, { name: 'x' })).status, 404);
    assert.equal((await patch(psa(), fixtureId('company', 3), etag, { name: 'x' })).status, 404);
    assert.deepEqual(failure(await patch(world.group(0).pa, id, etag, { name: 'x' })), { status: 403, code: 'FORBIDDEN', details: undefined });
    // A CA changes only his own company.
    assert.equal((await patch(ca(), id, etag, { name: 'x' })).status, 404);
    assert.equal((await patch(ca(), fixtureId('company', 2), etag, { name: 'x' })).status, 404);
    assert.equal((await call(psa(), 'PATCH', world.path(0, '/not-an-id'), { name: 'x' }, { 'if-match': etag })).status, 422);
  });

  it('lets the CA change every block of his own company, but not hub, transmitter, status or expiration date', async () => {
    const reply = await call(ca(), 'GET', sub(C1));
    assert.equal(reply.status, 200);
    const etag = etagOf(reply);
    const changed = await patch(ca(), C1, etag, {
      name: 'CA name',
      eInvoicing: { eori: 'EORI1', rea: { number: '5' } },
      invoiceNumbering: { discountLines: true },
      bankAccounts: [{ iban: IBAN, name: 'CA bank' }],
      mealVoucherIssuers: [{ name: 'CA issuer', cuts: [5] }],
      customerApp: { enableLoginSignup: true },
      media: { externalUrl: 'https://example.test/ca.png' },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const now = etagOf(changed);
    assert.deepEqual(failure(await patch(ca(), C1, now, { status: 'disabled', expirationDate: '2040-01-01', eInvoicing: { hub: 'aruba', transmitter: { country: 'DE', code: 'x' } } })), notAllowed('status', 'expirationDate', 'eInvoicing.hub', 'eInvoicing.transmitter.country', 'eInvoicing.transmitter.code'));
    // Sending the current values of the restricted fields back is accepted, so the whole object can be saved.
    const { id: _a, groupId: _b, trashed: _c, createdAt: _d, updatedAt: _e, ...writable } = changed.body.data;
    const saved = await patch(ca(), C1, now, { ...writable, name: 'CA again' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.name, 'CA again');
    // The SA has the same limits as the CA.
    assert.deepEqual(failure(await patch(sa(), C1, etagOf(saved), { eInvoicing: { hub: 'aruba' } })), notAllowed('eInvoicing.hub'));
    assert.equal((await patch(sa(), C1, etagOf(saved), { eInvoicing: { eori: 'EORI2' } })).status, 200);
  });

  it('lets the PSA and a dealer change hub, transmitter, status and expiration date', async () => {
    const { id, etag } = await fresh();
    for (const actor of [psa(), dealerA()]) {
      const reply = await patch(actor, id, (await call(psa(), 'GET', sub(id))).headers.get('etag')!, { status: 'disabled', expirationDate: null, eInvoicing: { hub: null, transmitter: { country: 'DE', code: `X${hex(actor).slice(0, 3)}` } } });
      assert.equal(reply.status, 200);
      assert.deepEqual([reply.body.data.status, reply.body.data.expirationDate, reply.body.data.eInvoicing.hub], ['disabled', null, null]);
    }
    assert.ok(etag);
  });

  it('applies the hub rules of the role on a change, and lets a dealer keep another dealer\'s hub', async () => {
    const other = `aruba__${hex(dealerB())}`;
    const { id, etag } = await fresh({ fattura_elettronica: { hub: other, regime_fiscale: 'RF01' } });
    // A dealer renames the company without touching the hub of another dealer: nothing is reset.
    const renamed = await patch(dealerA(), id, etag, { name: 'Dealer rename', eInvoicing: { hub: other } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.eInvoicing.hub, other);
    assert.equal(((await world.stored(0, id))!['fattura_elettronica'] as Document)['hub'], other);
    let version = etagOf(renamed);
    // He cannot move it to a third dealer, nor to a made-up one.
    assert.deepEqual(failure(await patch(dealerA(), id, version, { eInvoicing: { hub: `aruba__${hex(world.office.cluster.psa)}` } })), notAllowed('eInvoicing.hub'));
    assert.deepEqual(failure(await patch(dealerA(), id, version, { eInvoicing: { hub: 'other' } })), issues(['eInvoicing.hub', 'incorrect']));
    // He can choose none, aruba or himself.
    for (const hub of ['aruba', `aruba__${hex(dealerA())}`, null]) {
      const reply = await patch(dealerA(), id, version, { eInvoicing: { hub } });
      assert.equal(reply.status, 200, String(hub));
      assert.equal(reply.body.data.eInvoicing.hub, hub);
      version = etagOf(reply);
    }
    // The PSA may choose any existing dealer, and nothing else.
    assert.equal((await patch(psa(), id, version, { eInvoicing: { hub: other } })).status, 200);
    version = etagOf(await call(psa(), 'GET', sub(id)));
    assert.deepEqual(failure(await patch(psa(), id, version, { eInvoicing: { hub: `aruba__${hex(fixtureId('user', 600))}` } })), issues(['eInvoicing.hub', 'incorrect']));
    assert.deepEqual(failure(await patch(psa(), id, version, { eInvoicing: { hub: `aruba__${hex(sa())}` } })), issues(['eInvoicing.hub', 'incorrect']));
    assert.deepEqual(failure(await patch(psa(), id, version, { eInvoicing: { hub: `aruba__${hex(fixtureId('user', 601))}` } })), issues(['eInvoicing.hub', 'incorrect']));
    assert.equal(((await world.stored(0, id))!['fattura_elettronica'] as Document)['hub'], other);
  });

  it('checks the country, the province, the VAT number and the fiscal code when they change, not when they stay', async () => {
    const { id, etag } = await fresh({ code: 'LEGACY-VAT', code2: 'legacy', countryCode: 'IT', countryAreaCode: 'ZZ' });
    // The legacy data does not satisfy the rules, and it can still be changed in what the rules do not touch, even when it is sent back.
    const renamed = await patch(sa(), id, etag, { name: 'Still fine', address: { country: 'IT', province: 'ZZ' }, vatNumber: 'LEGACY-VAT', fiscalCode: 'legacy' });
    assert.equal(renamed.status, 200);
    let version = etagOf(renamed);
    assert.deepEqual(failure(await patch(sa(), id, version, { address: { province: 'TO' } })), issues(['address.province', 'incorrect']));
    assert.deepEqual(failure(await patch(sa(), id, version, { address: { country: 'ZZ' } })), issues(['address.country', 'incorrect']));
    assert.deepEqual(failure(await patch(sa(), id, version, { vatNumber: 'IT12345678901' })), issues(['vatNumber', 'format']));
    assert.deepEqual(failure(await patch(sa(), id, version, { fiscalCode: 'RSSMRA85T10A562T' })), issues(['fiscalCode', 'format']));
    // A country that lists no areas takes any province.
    const german = await patch(sa(), id, version, { address: { country: 'DE' } });
    assert.equal(german.status, 200);
    version = etagOf(german);
    // Changing the country back makes the stored VAT number and fiscal code subject to the rules of Italy.
    assert.deepEqual(failure(await patch(sa(), id, version, { address: { country: 'IT', province: 'MI' } })), issues(['vatNumber', 'format'], ['fiscalCode', 'format']));
    const italian = await patch(sa(), id, version, { address: { country: 'IT', province: 'MI' }, vatNumber: '01114601006', fiscalCode: '01114601006' });
    assert.equal(italian.status, 200, JSON.stringify(italian.body));
    version = etagOf(italian);
    // A valid Italian number is a valid number elsewhere, and the province is free in a country without areas.
    const abroad = await patch(sa(), id, version, { address: { country: 'DE', province: '' } });
    assert.equal(abroad.status, 200);
    assert.equal(abroad.body.data.address.country, 'DE');
    // The fiscal code can be removed.
    const removed = await patch(sa(), id, etagOf(abroad), { fiscalCode: null });
    assert.equal(removed.body.data.fiscalCode, null);
    assert.equal((await world.stored(0, id))!['code2'], '');
  });

  it('refuses a VAT number that another company of the group has, in any form, and accepts the own number again and the change of a company with a duplicate', async () => {
    const one = await fresh({ code: 'DUP-NUMBER-1', countryCode: 'DE' });
    const two = await fresh({ code: ' de 111 222 333 ', countryCode: 'DE' });
    const three = await fresh({ code: 'de111222333', countryCode: 'DE' });
    // The data already has a duplicate; renaming one of the pair is allowed.
    assert.equal((await patch(psa(), two.id, two.etag, { name: 'Renamed duplicate' })).status, 200);
    assert.deepEqual(failure(await patch(psa(), one.id, one.etag, { vatNumber: 'DE111222333' })), { status: 409, code: 'CONFLICT', details: [{ field: 'vatNumber', issue: 'taken' }] });
    assert.equal(((await world.stored(0, one.id))!['code']), 'DUP-NUMBER-1');
    // The same number, only written another way, is the company's own.
    const own = await fresh({ code: 'DE 555 666 777', countryCode: 'DE' });
    const again = await patch(psa(), own.id, own.etag, { vatNumber: 'de555666777' });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.vatNumber, 'de555666777');
    // But the number of another company is taken even when the data already has the same number twice.
    assert.deepEqual(failure(await patch(psa(), three.id, three.etag, { vatNumber: 'DE 111 222 333' })), { status: 409, code: 'CONFLICT', details: [{ field: 'vatNumber', issue: 'taken' }] });
    // A number only a trashed company has is free.
    const trashed = await fresh({ code: 'GONE-77', countryCode: 'DE', trash: true });
    assert.equal((await patch(psa(), one.id, etagOf(await call(psa(), 'GET', sub(one.id))), { vatNumber: 'gone-77' })).status, 200);
    assert.ok(trashed.id);
  });

  it('checks the currency, the price list and the minimum orders against the group, merging the minimum orders with the ones it has', async () => {
    const { id, etag } = await fresh({ settings: { ecommerce: { listId: '', minAmount: { EUR: { code: 'EUR', value: new Double(25.5), note: 'keep' }, XAU: { code: 'XAU', value: new Int32(9) } } }, global: {}, api: {} } });
    assert.deepEqual(failure(await patch(sa(), id, etag, { currency: 'JPY' })), issues(['currency', 'incorrect']));
    assert.deepEqual(failure(await patch(sa(), id, etag, { customerApp: { ecommerce: { priceListId: 'nope', minimumOrder: { JPY: 1 } } } })), issues(['customerApp.ecommerce.priceListId', 'incorrect'], ['customerApp.ecommerce.minimumOrder.JPY', 'incorrect']));
    const reply = await patch(sa(), id, etag, { currency: 'USD', customerApp: { ecommerce: { priceListId: hex(fixtureId('group', 901)), minimumOrder: { EUR: 40, USD: 12.5, XAU: 9 } } } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.data.customerApp.ecommerce.minimumOrder, { EUR: 40, XAU: 9, USD: 12.5 });
    const stored = ((await world.stored(0, id))!['settings'] as { ecommerce: { minAmount: Record<string, Document>; listId: string } }).ecommerce;
    assert.deepEqual([stored.listId, stored.minAmount['EUR']!['note'], stored.minAmount['EUR']!['code']], [hex(fixtureId('group', 901)), 'keep', 'EUR']);
    assert.ok(stored.minAmount['EUR']!['value'] instanceof Int32 && stored.minAmount['USD']!['value'] instanceof Double);
    // The legacy currency not in the group stays untouched, byte for byte, and can be sent back.
    assert.ok(sameDocument({ v: stored.minAmount['XAU'] }, { v: { code: 'XAU', value: new Int32(9) } }));
    // The price list can be removed.
    const cleared = await patch(sa(), id, etagOf(reply), { customerApp: { ecommerce: { priceListId: null } } });
    assert.equal(cleared.body.data.customerApp.ecommerce.priceListId, null);
    assert.equal((((await world.stored(0, id))!['settings'] as Document)['ecommerce'] as Document)['listId'], '');
  });

  it('keeps the ids of the accounts and the issuers, gives new ones their own, and refuses unknown or repeated ones', async () => {
    const { id, etag } = await fresh();
    const known = (await call(psa(), 'GET', sub(id))).body.data;
    const bankId = known.bankAccounts[0].id;
    const issuerId = known.mealVoucherIssuers[0].id;
    assert.deepEqual(failure(await patch(sa(), id, etag, { bankAccounts: [{ id: 'stranger', iban: IBAN }, { id: bankId, iban: IBAN }, { id: bankId, iban: IBAN }], mealVoucherIssuers: [{ id: 'stranger', name: 'x' }] })), issues(['bankAccounts.0.id', 'incorrect'], ['bankAccounts.2.id', 'incorrect'], ['mealVoucherIssuers.0.id', 'incorrect']));
    const reply = await patch(sa(), id, etag, { bankAccounts: [{ iban: 'DE89 3704 0044 0532 0130 00', name: 'New' }, { id: bankId, iban: IBAN, name: 'Main renamed', default: true }], mealVoucherIssuers: [{ id: issuerId, name: 'Pasti', cuts: [5, 10, null] }, { name: 'Second', cuts: [] }] });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const banks = reply.body.data.bankAccounts;
    assert.deepEqual(banks.map((bank: Document) => [bank['iban'], bank['name'], bank['default']]), [['DE89370400440532013000', 'New', false], [IBAN, 'Main renamed', true]]);
    assert.equal(banks[1].id, bankId);
    assert.match(banks[0].id, /^[0-9a-f]{24}$/);
    assert.deepEqual(reply.body.data.mealVoucherIssuers.map((issuer: Document) => issuer['id']).slice(0, 1), [issuerId]);
    assert.match(reply.body.data.mealVoucherIssuers[1].id, /^[0-9a-f]{24}$/);
    // The stored accounts have the strings of the legacy and no null.
    const stored = (await world.stored(0, id))!['banks'] as Array<Document>;
    assert.deepEqual(Object.keys(stored[0]!), ['id', 'name', 'iban', 'abi', 'cab', 'bic', 'default']);
    assert.deepEqual([stored[0]!['abi'], stored[0]!['bic']], ['', '']);
    // The list can be emptied.
    assert.deepEqual((await patch(sa(), id, etagOf(reply), { bankAccounts: [], mealVoucherIssuers: [] })).body.data.bankAccounts, []);
  });

  it('removes a logo, accepts the stored one sent back, and refuses a descriptor that does not come from an image of the group', async () => {
    const { id, etag, body } = await fresh();
    const logo = body.media.customersAppLogoLight;
    assert.equal((await patch(sa(), id, etag, { media: { customersAppLogoLight: logo } })).status, 200);
    assert.equal(etagOf(await patch(sa(), id, etag, { media: { customersAppLogoLight: logo } })), etag);
    assert.deepEqual(failure(await patch(sa(), id, etag, { media: { customersAppLogoLight: { ...logo, basename: 'other.png' } } })), issues(['media.customersAppLogoLight', 'notAllowed']));
    assert.deepEqual(failure(await patch(sa(), id, etag, { media: { customersAppLogoDark: logo } })), issues(['media.customersAppLogoDark', 'notAllowed']));
    const removed = await patch(sa(), id, etag, { media: { customersAppLogoLight: null, internalFileName: 'renamed.png' } });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.media.customersAppLogoLight, null);
    const images = ((await world.stored(0, id))!['medias'] as { images: Document }).images;
    assert.deepEqual([images['customersAppLogoLight'], images['internalFileName'], (images['unknownImage'] as Int32).value], [null, 'renamed.png', 1]);
  });

  it('fails with 409 and a message, writing nothing, when a stored block cannot be written into, and still changes the rest', async () => {
    const { id, etag } = await fresh({ settings: null });
    const before = (await world.stored(0, id))!;
    const refused = await patch(sa(), id, etag, { customerApp: { enableLoginSignup: true } });
    assert.deepEqual(failure(refused), { status: 409, code: 'CONFLICT', details: undefined });
    assert.match(refused.body.error.message, /block/);
    assert.ok(sameDocument(before, (await world.stored(0, id))!));
    assert.equal((await patch(sa(), id, etag, { name: 'Other keys work' })).status, 200);
  });

  it('completes a block that is empty with the defaults of the keys the request does not set', async () => {
    const { id, etag } = await fresh({ settings: {}, fattura_elettronica: {}, medias: {} });
    const reply = await patch(sa(), id, etag, { customerApp: { ecommerce: { status: true } }, eInvoicing: { eori: 'E1' }, media: { externalUrl: 'https://example.test/x' } });
    assert.equal(reply.status, 200);
    const document = (await world.stored(0, id))!;
    assert.equal(Object.keys((document['settings'] as { ecommerce: Document }).ecommerce).length, 27);
    assert.equal(Object.keys(document['fattura_elettronica'] as Document).length, 16);
    assert.deepEqual(((document['medias'] as { images: Document }).images), { internalFileName: '', externalUrl: 'https://example.test/x', customersAppLogoLight: null, customersAppLogoDark: null });
    assert.equal(((document['fattura_elettronica'] as Document)['regime_fiscale']), 'RF01');
  });

  it('records what changed by name only, never a value, and the IBAN never reaches a log', async () => {
    const { id, etag } = await fresh();
    const mark = world.office.activity.entries.length;
    const reply = await patch(sa(), id, etag, { name: 'Logged name', address: { city: 'Verona' }, bankAccounts: [{ iban: IBAN, bic: 'DEUTDEFF', name: 'Secret bank' }], eInvoicing: { eori: 'EORI-LOG' }, customerApp: { enableLoginSignup: false }, media: { externalUrl: 'https://log.test/x' } });
    assert.equal(reply.status, 200);
    const entries = world.office.activity.entries.slice(mark).filter((entry) => entry.action === 'company.updated');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]!.changes, [
      { field: 'name', redacted: true },
      { field: 'address.city', redacted: true },
      { field: 'eInvoicing', redacted: true },
      { field: 'bankAccounts', redacted: true },
      { field: 'customerApp', redacted: true },
      { field: 'media', redacted: true },
    ]);
    assert.deepEqual([entries[0]!.resource, entries[0]!.groupId, entries[0]!.actor.role], [{ type: 'company', id: hex(id) }, world.group(0).groupId, 'SA']);
    const text = JSON.stringify([world.office.activity.entries, world.office.logEvents]);
    for (const value of [IBAN, 'DEUTDEFF', 'Secret bank', 'Logged name', 'Verona', 'EORI-LOG', 'log.test']) {
      assert.ok(!text.includes(value), value);
    }
    // A request that changes nothing records nothing.
    const quiet = world.office.activity.entries.length;
    await patch(sa(), id, etagOf(reply), { name: 'Logged name' });
    assert.equal(world.office.activity.entries.length, quiet);
  });
});

describe('PATCH of a company whose geography is missing in the document', () => {
  it('changes it without failing, and holds the stored VAT number to the rules of a country it changes to', async () => {
    const noGeography = await fresh({ countryCode: 5, countryAreaCode: null, code: null, code2: null });
    assert.equal((await patch(sa(), noGeography.id, noGeography.etag, { name: 'No country' })).status, 200);
    // A province can be set on a company with no country: there is nothing to check it against.
    const version = etagOf(await call(psa(), 'GET', sub(noGeography.id)));
    const withProvince = await patch(sa(), noGeography.id, version, { address: { province: 'XY' } });
    assert.equal(withProvince.status, 200);
    // Changing the country makes the missing VAT number invalid for the new country.
    assert.deepEqual(failure(await patch(sa(), noGeography.id, etagOf(withProvince), { address: { country: 'DE' } })), issues(['vatNumber', 'format']));
    const valid = await patch(sa(), noGeography.id, etagOf(withProvince), { address: { country: 'IT', province: '' }, vatNumber: '00743110157' });
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
    // A company with no province changes country with the empty province.
    const noProvince = await fresh({ countryCode: 'DE', countryAreaCode: null, code: '15844561009' });
    assert.equal((await patch(sa(), noProvince.id, noProvince.etag, { address: { country: 'IT' } })).status, 200);
  });
});

describe('what the review of the security closed', () => {
  it('refuses a SA and a CA that change hub or transmitter through the whole e-invoicing block', async () => {
    const { id, etag, body } = await fresh();
    const changed = { hub: 'aruba__010000000000000000000001', transmitter: { country: 'DE', code: 'x' } };
    assert.deepEqual(failure(await put(sa(), id, 'e-invoicing', etag, { ...body.eInvoicing, ...changed })), notAllowed('eInvoicing.hub', 'eInvoicing.transmitter.country', 'eInvoicing.transmitter.code'));
    const own = await call(ca(), 'GET', sub(C1));
    assert.deepEqual(failure(await put(ca(), C1, 'e-invoicing', etagOf(own), { ...own.body.data.eInvoicing, ...changed })), notAllowed('eInvoicing.hub', 'eInvoicing.transmitter.country', 'eInvoicing.transmitter.code'));
  });

  it('refuses a Cerved switch changed by a SA or a CA, accepts it from a dealer', async () => {
    const { id, etag } = await fresh();
    assert.deepEqual(failure(await patch(sa(), id, etag, { invoiceNumbering: { cervedLookup: false } })), notAllowed('invoiceNumbering.cervedLookup'));
    assert.deepEqual(failure(await patch(ca(), C1, etagOf(await call(ca(), 'GET', sub(C1))), { invoiceNumbering: { cervedLookup: true } })), notAllowed('invoiceNumbering.cervedLookup'));
    assert.equal((await patch(dealerA(), id, etag, { invoiceNumbering: { cervedLookup: false } })).status, 200);
  });

  it('accepts only a simple file name for the internal media file', async () => {
    const { id, etag } = await fresh();
    for (const internalFileName of ['../../etc/x', 'a/b', 'a\\b', '.hidden', 'a..b', '-x']) {
      assert.deepEqual(failure(await patch(sa(), id, etag, { media: { internalFileName } })), issues(['media.internalFileName', 'pattern']), internalFileName);
    }
    assert.equal((await patch(sa(), id, etag, { media: { internalFileName: 'logo-1.v2_final.png' } })).status, 200);
  });

  it('refuses invisible and non-ASCII characters in a foreign VAT number, so it cannot dodge the uniqueness check', async () => {
    const { id, etag } = await fresh({ code: 'DE123456789' });
    for (const vatNumber of ['DE\u200B123456789', 'DE\u00A0123456789', 'DE\u00E9123456789']) {
      assert.deepEqual(failure(await patch(psa(), id, etag, { vatNumber })), issues(['vatNumber', 'format']), JSON.stringify(vatNumber));
    }
    assert.deepEqual(failure(await patch(psa(), id, etag, { vatNumber: 'DE123', fiscalCode: 'a\u200Bb' })), issues(['fiscalCode', 'format']));
  });

  it('does not let a request put operators or dotted keys in the nested blocks', async () => {
    const { id, etag } = await fresh();
    assert.equal((await patch(sa(), id, etag, JSON.parse('{"eInvoicing":{"rea":{"$set":1,"a.b":2}}}'))).status, 422);
    assert.equal((await patch(sa(), id, etag, JSON.parse('{"customerApp":{"ecommerce":{"minimumOrder":{"$gt":1,"a.b":2}}}}'))).status, 422);
    assert.equal((await patch(sa(), id, etag, JSON.parse('{"bankAccounts":[{"iban":"IT60X0542811101000000123456","$set":1,"a.b":2}]}'))).status, 422);
  });

  it('does not restore a company whose VAT number another company has taken in the meantime', async () => {
    const one = await fresh({ code: 'DE777888999', countryCode: 'DE' });
    const trashed = await call(sa(), 'POST', sub(one.id, '/trash'), undefined, { 'if-match': one.etag });
    await fresh({ code: 'de 777 888 999', countryCode: 'DE' });
    assert.deepEqual(failure(await call(sa(), 'POST', sub(one.id, '/restore'), undefined, { 'if-match': etagOf(trashed) })), { status: 409, code: 'CONFLICT', details: [{ field: 'vatNumber', issue: 'taken' }] });
    assert.equal((await world.stored(0, one.id))!['trash'], true);
  });
});

describe('PUT /v1/groups/{groupId}/companies/{companyId}/<block>', () => {
  it('replaces the e-invoicing block with the whole block, requiring every key', async () => {
    const { id, etag, body } = await fresh();
    const block = { ...body.eInvoicing, eori: 'EORI-9', recipientCode: 'zzz9999', rea: { ...body.eInvoicing.rea, office: 'RM' }, professionalRegister: { name: 'Albo', number: '12', province: 'MI', date: '2020-02-29' } };
    const reply = await put(sa(), id, 'e-invoicing', etag, block);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual([reply.body.data.eInvoicing.eori, reply.body.data.eInvoicing.recipientCode, reply.body.data.eInvoicing.rea.office, reply.body.data.eInvoicing.professionalRegister], ['EORI-9', 'ZZZ9999', 'RM', { name: 'Albo', number: '12', province: 'MI', date: '2020-02-29' }]);
    const stored = (await world.stored(0, id))!['fattura_elettronica'] as Document;
    assert.deepEqual([stored['codice_eori'], stored['rea_ufficio'], stored['albo_professionale'], stored['ap_data_iscrizione']], ['EORI-9', 'RM', 'Albo', '2020-02-29']);
    assert.ok(sameDocument({ v: stored['unknownEInvoicing'] }, { v: { keep: [new Int32(1), new Int32(2)] } }));
    assert.notEqual(etagOf(reply), etag);
    const { rea: _rea, ...incomplete } = block;
    assert.deepEqual(failure(await put(sa(), id, 'e-invoicing', etagOf(reply), incomplete)), issues(['rea', 'required']));
    assert.deepEqual(failure(await put(sa(), id, 'e-invoicing', etagOf(reply), { ...block, extra: 1 })), issues(['extra', 'unknown']));
    // The whole block of the current values is accepted from a SA, who cannot change the hub.
    const same = await put(sa(), id, 'e-invoicing', etagOf(reply), reply.body.data.eInvoicing);
    assert.equal(same.status, 200);
    assert.equal(etagOf(same), etagOf(reply));
    assert.deepEqual(failure(await put(sa(), id, 'e-invoicing', etagOf(reply), { ...block, hub: null })), notAllowed('eInvoicing.hub'));
  });

  it('replaces the numbering block', async () => {
    const { id, etag } = await fresh();
    const reply = await put(psa(), id, 'invoice-numbering', etag, { position: 'suffix', values: [{ name: 'X', cash: false }], lastInvoiceNumber: 5, discountLines: false, cervedLookup: false });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const stored = await world.stored(0, id);
    assert.deepEqual([stored!['invoicesPS'], stored!['invoicesPSValues'], ((stored!['settings'] as Document)['api'] as Document)['cerved']], ['suffix', [{ name: 'X', cash: false }], false]);
    // A SA cannot change the Cerved switch; the same value is accepted.
    assert.deepEqual(failure(await put(sa(), id, 'invoice-numbering', etagOf(reply), { position: 'suffix', values: [{ name: 'X', cash: false }], lastInvoiceNumber: 5, discountLines: false, cervedLookup: true })), notAllowed('invoiceNumbering.cervedLookup'));
    assert.equal((await put(sa(), id, 'invoice-numbering', etagOf(reply), { position: 'suffix', values: [{ name: 'X', cash: false }], lastInvoiceNumber: 5, discountLines: true, cervedLookup: false })).status, 200);
    assert.deepEqual(failure(await put(psa(), id, 'invoice-numbering', etagOf(await call(psa(), 'GET', sub(id))), { position: null, values: [{ name: 'A', cash: true }, { name: 'A', cash: true }], lastInvoiceNumber: null, discountLines: false, cervedLookup: false })), issues(['values.1.name', 'incorrect'], ['values.1.cash', 'incorrect']));
  });

  it('replaces the list of accounts and the list of issuers', async () => {
    const { id, etag, body } = await fresh();
    const banks = await put(sa(), id, 'bank-accounts', etag, [...body.bankAccounts, { iban: IBAN, name: 'Added' }]);
    assert.equal(banks.status, 200, JSON.stringify(banks.body));
    assert.equal(banks.body.data.bankAccounts.length, 2);
    assert.equal(banks.body.data.bankAccounts[0].id, body.bankAccounts[0].id);
    assert.deepEqual(failure(await put(sa(), id, 'bank-accounts', etagOf(banks), [{ iban: 'IT60X0542811101000000123457' }])), issues(['0.iban', 'format']));
    const issuers = await put(sa(), id, 'meal-voucher-issuers', etagOf(banks), [{ name: 'Only', cuts: [1] }]);
    assert.equal(issuers.status, 200);
    assert.deepEqual(issuers.body.data.mealVoucherIssuers.map((issuer: Document) => [issuer['name'], issuer['cuts']]), [['Only', [1]]]);
    assert.deepEqual(failure(await put(sa(), id, 'meal-voucher-issuers', etagOf(issuers), [{ id: 'stranger', name: 'x' }])), issues(['mealVoucherIssuers.0.id', 'incorrect']));
    assert.equal((await put(sa(), id, 'meal-voucher-issuers', etagOf(issuers), [])).body.data.mealVoucherIssuers.length, 0);
  });

  it('replaces the customer app block and the media block', async () => {
    const { id, etag, body } = await fresh();
    const customerApp = { ...body.customerApp, showTermsPage: true, ecommerce: { ...body.customerApp.ecommerce, status: false, minimumOrder: { EUR: 3 } } };
    const reply = await put(sa(), id, 'customer-app', etag, customerApp);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.customerApp.showTermsPage, true);
    assert.deepEqual(reply.body.data.customerApp.ecommerce.minimumOrder, { EUR: 3, USD: 30 });
    const { ecommerce: _ecommerce, ...rest } = customerApp;
    assert.deepEqual(failure(await put(sa(), id, 'customer-app', etagOf(reply), rest)), issues(['ecommerce', 'required']));
    const media = await put(sa(), id, 'media', etagOf(reply), { ...body.media, internalFileName: 'new.png', customersAppLogoDark: null });
    assert.equal(media.status, 200);
    assert.equal(media.body.data.media.internalFileName, 'new.png');
    assert.deepEqual(failure(await put(sa(), id, 'media', etagOf(media), { internalFileName: '', externalUrl: '', customersAppLogoLight: { _id: 'new' }, customersAppLogoDark: null })), issues(['customersAppLogoLight.basename', 'required'], ['customersAppLogoLight.extension', 'required'], ['customersAppLogoLight.filename', 'required'], ['customersAppLogoLight.mimetype', 'required'], ['customersAppLogoLight.title', 'required'], ['customersAppLogoLight.alt', 'required'], ['customersAppLogoLight.dirname', 'required'], ['customersAppLogoLight.type', 'required'], ['customersAppLogoLight.filectime', 'required']));
    assert.deepEqual(failure(await put(sa(), id, 'media', etagOf(media), { ...body.media, customersAppLogoDark: body.media.customersAppLogoLight })), issues(['media.customersAppLogoDark', 'notAllowed']));
  });

  it('is 404 outside the perimeter and for a PA, 405 for the methods the block does not have', async () => {
    const { id, etag, body } = await fresh();
    assert.equal((await put(world.group(1).sa, id, 'media', etag, body.media)).status, 404);
    assert.equal((await put(ca(), id, 'media', etag, body.media)).status, 404);
    assert.deepEqual(failure(await put(world.group(0).pa, id, 'media', etag, body.media)), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.equal((await call(sa(), 'GET', sub(id, '/media'))).status, 405);
    assert.equal((await call(sa(), 'PATCH', sub(id, '/media'), {}, { 'if-match': etag })).status, 405);
    assert.equal((await call(sa(), 'POST', sub(id, '/bank-accounts'), [])).status, 405);
  });
});
