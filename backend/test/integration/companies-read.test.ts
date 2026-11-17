import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { versionOf } from '../../src/shared/legacy-write/version.ts';
import { ecommerceFlagsDomain, IBAN, VAT } from '../helpers/company-fixtures.ts';
import { startCompaniesWorld } from '../helpers/companies.ts';
import type { CompaniesWorld } from '../helpers/companies.ts';
import { fixtureId, legacyCompany } from '../helpers/legacy-fixtures.ts';
import { insertCopies } from '../helpers/mirror.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';
import { EXACT_TYPES } from '../../src/shared/legacy-write/copy-rule.ts';
import { TEST_VERSION_KEY } from '../helpers/version-key.ts';

let ctx: TestDatabases;
let world: CompaniesWorld;
const { call, failure } = { call: (...args: Parameters<CompaniesWorld['as']['call']>) => world.as.call(...args), failure: (reply: Awaited<ReturnType<CompaniesWorld['as']['call']>>) => world.as.failure(reply) };
const hex = (id: ObjectId) => id.toHexString();
const C = (n: number) => fixtureId('company', n);
const names = (reply: { body: { data: Array<{ name: string }> } }) => reply.body.data.map((item) => item.name);
let full: ObjectId;

before(async () => {
  ctx = await openTestDatabases();
  world = await startCompaniesWorld(ctx);
  // Group 0: the two companies of the cluster, a complete one, a trashed one, a disabled one in Germany, and irregular ones.
  full = await world.seed(0, 100, { name: 'Zeta Complete' });
  await world.seed(0, 101, { name: 'Trashed Co', trash: true, code: 'T-101', countryCode: 'DE', countryAreaCode: '' });
  await world.seed(0, 102, { name: 'Disabled Reg.Ex (a+', status: false, code: 'DE 999', countryCode: 'DE', countryAreaCode: '', city: 'Berlin' });
  await insertCopies(ctx.databases, 'companies', [
    legacyCompany(103, world.group(0).groupId, { name: 7, code: null, city: [], countryCode: 5, countryAreaCode: {}, status: 'yes', trash: 'x' }),
  ]);
});
after(async () => {
  await world.office.close();
  await ctx.cleanup();
});

describe('GET /v1/groups/{groupId}/companies', () => {
  it('lists the untrashed companies with the compact fields of the contract and an ETag', async () => {
    const reply = await call(world.group(0).sa, 'GET', world.path(0));
    assert.equal(reply.status, 200);
    assert.deepEqual(names(reply), ['', 'Disabled Reg.Ex (a+', 'Zeta Complete', 'company-001', 'company-002']);
    assert.deepEqual(reply.body.data.find((item: { name: string }) => item.name === 'Zeta Complete'), {
      id: hex(full),
      name: 'Zeta Complete',
      vatNumber: VAT,
      city: 'Milano',
      province: 'MI',
      country: 'IT',
      status: 'active',
      trashed: false,
      trashedAt: null,
    });
    assert.deepEqual(reply.body.data[0], { id: hex(C(103)), name: '', vatNumber: null, city: null, province: null, country: null, status: 'disabled', trashed: false, trashedAt: null });
    assert.deepEqual(reply.body.page, { limit: 50, next: null });
    const text = JSON.stringify(reply.body);
    for (const secret of ['fattura_elettronica', IBAN, 'banks', 'Via Roma', 'info@acme', 'pec@acme']) {
      assert.ok(!text.includes(secret), secret);
    }
    const etag = reply.headers.get('etag')!;
    assert.match(etag, /^W\/"/);
    const again = await world.office.call('GET', world.path(0), (await world.as.tokenOf(world.group(0).sa)), undefined, { 'if-none-match': etag });
    assert.equal(again.status, 304);
  });

  it('filters by status, country, province, trash and ids', async () => {
    const sa = world.group(0).sa;
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?status=disabled'))), ['', 'Disabled Reg.Ex (a+']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?status=active'))), ['Zeta Complete', 'company-001', 'company-002']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?country=DE'))), ['Disabled Reg.Ex (a+']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?country=IT&province=MI'))), ['Zeta Complete']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?province=RM'))), ['company-001', 'company-002']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?trashed=true'))), ['Trashed Co']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, `?ids=${hex(full)},${hex(C(1))}&sort=-name`))), ['company-001', 'Zeta Complete']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, `?status=active&country=IT&ids=${hex(full)},${hex(C(102))}`))), ['Zeta Complete']);
  });

  it('searches the name and the VAT number literally, case-insensitively, and pages by name', async () => {
    const sa = world.group(0).sa;
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?q=reg.ex%20(a%2B'))), ['Disabled Reg.Ex (a+']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, `?q=${VAT.slice(2, 8)}`))), ['Zeta Complete']);
    assert.deepEqual(names(await call(sa, 'GET', world.path(0, '?q=de%20999'))), ['Disabled Reg.Ex (a+']);
    assert.deepEqual((await call(sa, 'GET', world.path(0, '?q=.*'))).body.data, []);
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const reply: Awaited<ReturnType<typeof call>> = await call(sa, 'GET', world.path(0, `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`));
      walked.push(...names(reply));
      cursor = reply.body.page.next;
      if (cursor === null) {
        break;
      }
    }
    assert.deepEqual(walked, ['', 'Disabled Reg.Ex (a+', 'Zeta Complete', 'company-001', 'company-002']);
  });

  it('rejects what the list does not accept with 422', async () => {
    for (const query of ['status=x', 'country=ITA', 'country=it', 'province=', 'trashed=maybe', 'sort=vatNumber', 'limit=0', 'unknown=1', 'ids=x']) {
      assert.equal((await call(world.group(0).sa, 'GET', world.path(0, `?${query}`))).status, 422, query);
    }
  });

  it('applies the perimeter: a CA sees his company only, a PA has no companies:read and other groups are 404', async () => {
    const g = world.group(0);
    assert.deepEqual(names(await call(g.ca, 'GET', world.path(0))), ['company-001']);
    assert.deepEqual(failure(await call(g.pa, 'GET', world.path(0))), { status: 403, code: 'FORBIDDEN', details: undefined });
    assert.equal((await call(world.group(1).sa, 'GET', world.path(0))).status, 404);
    assert.equal((await call(world.office.cluster.dealerB, 'GET', world.path(0))).status, 404);
    assert.ok((await call(world.office.cluster.dealerA, 'GET', world.path(0))).body.data.length > 0);
    assert.deepEqual(names(await call(world.group(1).sa, 'GET', world.path(1))), ['company-003', 'company-004']);
  });
});

describe('GET /v1/groups/{groupId}/companies/{companyId}', () => {
  it('returns the whole company in the English names of the domain, with the version as a strong ETag', async () => {
    const reply = await call(world.group(0).sa, 'GET', world.path(0, `/${hex(full)}`));
    assert.equal(reply.status, 200);
    const company = reply.body.data;
    assert.equal(company.id, hex(full));
    assert.equal(company.groupId, hex(world.group(0).groupId));
    assert.deepEqual(
      [company.name, company.vatNumber, company.fiscalCode, company.currency, company.email, company.phone, company.status, company.trashed, company.expirationDate],
      ['Zeta Complete', VAT, VAT, 'EUR', 'info@acme.example', '+39 02 1234567', 'active', false, '2030-01-01T00:00:00.000Z'],
    );
    assert.deepEqual(company.address, { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
    assert.deepEqual(company.eInvoicing.rea, { office: 'MI', number: '123456', shareCapital: '10000.5', shareholders: 'SU', liquidation: 'LN' });
    assert.deepEqual(company.invoiceNumbering, { position: 'prefix', values: [{ name: 'FE', cash: true }, { name: 'NC', cash: false }], lastInvoiceNumber: 120, discountLines: true, cervedLookup: true });
    assert.deepEqual(company.bankAccounts, [{ id: 'bank1', name: 'Main', iban: IBAN, abi: '05428', cab: '11101', bic: null, default: true }]);
    assert.deepEqual(company.mealVoucherIssuers, [{ id: 'tsupplier1', name: 'Pasti', cuts: [5, 10, null] }]);
    assert.deepEqual(company.customerApp.ecommerce, { ...ecommerceFlagsDomain(), priceListId: 'pricelist1', minimumOrder: { EUR: 25.5, USD: 30 }, showProductRemainingQuantity: 3 });
    assert.equal(company.media.customersAppLogoLight._id, 'f00d');
    assert.equal(company.media.customersAppLogoDark, null);
    assert.equal(company.createdAt, '2024-01-15T10:00:00.000Z');
    // The version of the stored document, the one If-Match expects.
    const document = (await world.stored(0, full))!;
    assert.equal(reply.headers.get('etag'), `"${versionOf('companies', document, TEST_VERSION_KEY)}"`);
    const text = JSON.stringify(reply.body);
    for (const unknown of ['unknownEInvoicing', 'unknownGlobal', 'unknownEcommerce', 'unknownSettings', 'unknownMedia', 'futureKey', 'mmThumb', 'fattura_elettronica']) {
      assert.ok(!text.includes(unknown), unknown);
    }
  });

  it('reads the document of the group database, not its copy: a company the copy lacks is found, one only the copy has is not', async () => {
    const original = await world.seed(0, 110, { name: 'Original only' });
    await ctx.databases.common().collection('companies').deleteOne({ _id: original });
    assert.equal((await call(world.group(0).sa, 'GET', world.path(0, `/${hex(original)}`))).body.data.name, 'Original only');
    await insertCopies(ctx.databases, 'companies', [legacyCompany(111, world.group(0).groupId, { name: 'Copy only' })]);
    assert.equal((await call(world.group(0).sa, 'GET', world.path(0, `/${hex(C(111))}`))).status, 404);
  });

  it('reads a trashed company, and a company whose data is wrong, without failing', async () => {
    assert.equal((await call(world.group(0).sa, 'GET', world.path(0, `/${hex(C(101))}`))).body.data.trashed, true);
    const odd = await world.seed(0, 112, { name: 5, code: null, address: [], settings: null, fattura_elettronica: 'x', medias: [], banks: 'x', ticketsSuppliers: null, invoicesPSValues: 4, status: 'x', expirationDate: 'x' });
    const reply = await call(world.group(0).sa, 'GET', world.path(0, `/${hex(odd)}`));
    assert.equal(reply.status, 200);
    assert.deepEqual([reply.body.data.name, reply.body.data.vatNumber, reply.body.data.status, reply.body.data.bankAccounts, reply.body.data.expirationDate], [null, null, 'disabled', [], null]);
  });

  it('allows the PSA, the dealer, the SA and the CA of the company; refuses the PA; hides the company from the others with 404', async () => {
    const own = world.path(0, `/${hex(C(1))}`);
    for (const actor of [world.office.cluster.psa, world.office.cluster.dealerA, world.group(0).sa, world.group(0).ca]) {
      assert.equal((await call(actor, 'GET', own)).status, 200);
    }
    assert.equal((await call(world.group(0).pa, 'GET', own)).status, 403);
    // A CA does not read another company of his group, a SA nothing of another group, a dealer nothing of another dealer.
    assert.equal((await call(world.group(0).ca, 'GET', world.path(0, `/${hex(C(2))}`))).status, 404);
    assert.equal((await call(world.group(1).sa, 'GET', own)).status, 404);
    assert.equal((await call(world.office.cluster.dealerB, 'GET', own)).status, 404);
    assert.equal((await call(world.group(1).ca, 'GET', own)).status, 404);
  });

  it('is 404 for a company of another group asked through the own group, and for one that does not exist', async () => {
    assert.equal((await call(world.group(0).sa, 'GET', world.path(0, `/${hex(C(3))}`))).status, 404);
    assert.equal((await call(world.office.cluster.psa, 'GET', world.path(0, `/${hex(new ObjectId())}`))).status, 404);
    assert.equal((await call(world.group(0).sa, 'GET', world.path(0, '/not-an-id'))).status, 422);
    assert.equal((await call(world.office.cluster.psa, 'GET', '/groups/not-a-group/companies')).status, 404);
  });

  it('does not accept a request body or a query it does not know on the detail, and answers 405 for other methods', async () => {
    const own = world.path(0, `/${hex(C(1))}`);
    assert.equal((await call(world.group(0).sa, 'PUT', own, {}, { 'if-match': '"x"' })).status, 405);
    assert.equal((await call(world.group(0).sa, 'POST', own, {})).status, 405);
  });

  it('shows every company of the group with the document of the group database as the source of its version', async () => {
    const document = (await ctx.databases.group(world.group(0).groupId, 'cluster0').collection('companies').findOne({ _id: full }, { ...EXACT_TYPES }))!;
    const reply = await call(world.office.cluster.psa, 'GET', world.path(0, `/${hex(full)}`));
    assert.equal(reply.headers.get('etag'), `"${versionOf('companies', document, TEST_VERSION_KEY)}"`);
  });
});
