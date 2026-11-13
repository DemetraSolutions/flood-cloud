import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import { LEAVES, legacyLogoDescriptor, leafWrites, numberOf, setValueAt, toCompany, toCompanySummary, valueAt } from '../../src/modules/companies/company.mapper.ts';
import { COMPANY_BLOCK_PATHS, COMPANY_WHOLE_KEYS } from '../../src/shared/legacy-write/company-paths.ts';
import { COMPANIES_OWNED_FIELDS } from '../../src/db/collections.ts';
import { IBAN, VAT, ecommerceFlagsDomain, fullLegacyCompany } from '../helpers/company-fixtures.ts';
import { fixtureId } from '../helpers/legacy-fixtures.ts';

const GROUP = fixtureId('group', 1);
const company = (document = fullLegacyCompany(1, GROUP)) => toCompany(document, GROUP);

describe('company mapper: reading', () => {
  it('maps the general data of a complete company', () => {
    const read = company();
    assert.equal(read.id, fixtureId('company', 1).toHexString());
    assert.equal(read.groupId, GROUP.toHexString());
    assert.deepEqual(
      [read.name, read.vatNumber, read.fiscalCode, read.currency, read.email, read.phone, read.status, read.trashed, read.expirationDate],
      ['Acme S.r.l.', VAT, VAT, 'EUR', 'info@acme.example', '+39 02 1234567', 'active', false, '2030-01-01T00:00:00.000Z'],
    );
    assert.deepEqual(read.address, { street: 'Via Roma 1', postcode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
    assert.equal(read.createdAt, '2024-01-15T10:00:00.000Z');
    assert.equal(read.updatedAt, '2024-01-15T10:00:00.000Z');
  });

  it('maps the e-invoicing block, with empty strings as null', () => {
    assert.deepEqual(company().eInvoicing, {
      hub: 'aruba',
      transmitter: { country: 'IT', code: '01879020517' },
      eori: null,
      pec: 'pec@acme.example',
      recipientCode: 'ABC1234',
      professionalRegister: { name: null, number: null, province: null, date: null },
      rea: { office: 'MI', number: '123456', shareCapital: '10000.5', shareholders: 'SU', liquidation: 'LN' },
      taxRegime: 'RF01',
    });
  });

  it('maps the numbering, the lists, the customer app and the media, unwrapping the numbers of the exact types', () => {
    const read = company();
    assert.deepEqual(read.invoiceNumbering, {
      position: 'prefix',
      values: [
        { name: 'FE', cash: true },
        { name: 'NC', cash: false },
      ],
      lastInvoiceNumber: 120,
      discountLines: true,
      cervedLookup: true,
    });
    assert.deepEqual(read.bankAccounts, [{ id: 'bank1', name: 'Main', iban: IBAN, abi: '05428', cab: '11101', bic: null, default: true }]);
    assert.deepEqual(read.mealVoucherIssuers, [{ id: 'tsupplier1', name: 'Pasti', cuts: [5, 10, null] }]);
    assert.deepEqual(read.customerApp, {
      enableLoginSignup: true,
      showPrivacyPage: true,
      showTermsPage: false,
      ecommerce: { ...ecommerceFlagsDomain(), priceListId: 'pricelist1', minimumOrder: { EUR: 25.5, USD: 30 }, showProductRemainingQuantity: 3 },
    });
    assert.deepEqual(read.media, {
      internalFileName: 'logo.png',
      externalUrl: 'https://example.test/logo.png',
      customersAppLogoLight: { _id: 'f00d', basename: 'light.png', extension: 'png', filename: 'light', mimetype: 'image/png', title: 'Light', alt: 'Light logo', dirname: '/media/image', type: 'image', filectime: 1_700_000_000_000 },
      customersAppLogoDark: null,
    });
  });

  it('never returns a key it does not know, at any level', () => {
    const text = JSON.stringify(company());
    for (const unknown of ['unknownEInvoicing', 'unknownGlobal', 'unknownApi', 'unknownEcommerce', 'unknownSettings', 'unknownImage', 'unknownMedia', 'futureKey', 'mmThumb', 'invoicesPS', 'fattura_elettronica', 'settings']) {
      assert.ok(!text.includes(unknown), unknown);
    }
  });

  it('reads a company with nothing in it without failing: null for text, false, 0 and empty lists for the rest', () => {
    const read = company({ _id: fixtureId('company', 2) });
    assert.equal(read.name, null);
    assert.equal(read.status, 'disabled');
    assert.deepEqual(read.address, { street: null, postcode: null, city: null, province: null, country: null });
    assert.equal(read.eInvoicing.hub, null);
    assert.deepEqual(read.invoiceNumbering, { position: null, values: [], lastInvoiceNumber: null, discountLines: false, cervedLookup: false });
    assert.deepEqual([read.bankAccounts, read.mealVoucherIssuers, read.customerApp.ecommerce.minimumOrder], [[], [], {}]);
    assert.equal(read.customerApp.ecommerce.priceListId, null);
    assert.equal(read.customerApp.ecommerce.showProductRemainingQuantity, 0);
    assert.deepEqual(read.media, { internalFileName: '', externalUrl: '', customersAppLogoLight: null, customersAppLogoDark: null });
    assert.deepEqual([read.expirationDate, read.createdAt, read.updatedAt, read.trashed], [null, null, null, false]);
  });

  it('is tolerant of wrong types, blocks that are not objects and elements that are not well formed', () => {
    const read = company({
      _id: fixtureId('company', 3),
      name: 5,
      code: null,
      code2: '',
      email: '',
      telephone: 7,
      status: 'yes',
      trash: 'x',
      expirationDate: 'soon',
      insertDate: new Date('nope'),
      address: { street: 'x' },
      settings: null,
      fattura_elettronica: 'x',
      medias: [],
      invoicesPS: 'middle',
      invoicesPSValues: [null, 3, { name: 4, cash: 'yes' }, { name: 'A', cash: true }],
      banks: [{ id: 5, iban: 6, abi: '', cab: 7, default: 1 }, 'x'],
      ticketsSuppliers: [{ id: 'x', name: 'y', cuts: 'no' }, { name: 'z', cuts: [new Long(4), 'a', new Decimal128('2'), Number.NaN, 2.5] }, { id: 'n' }],
    });
    assert.deepEqual([read.name, read.vatNumber, read.fiscalCode, read.email, read.phone, read.status, read.trashed, read.expirationDate, read.createdAt], [null, null, null, null, null, 'disabled', false, null, null]);
    assert.equal(read.address.street, null);
    assert.deepEqual(read.invoiceNumbering.values, [
      { name: '', cash: false },
      { name: 'A', cash: true },
    ]);
    assert.equal(read.invoiceNumbering.position, null);
    assert.deepEqual(read.bankAccounts, [{ id: '', name: '', iban: '', abi: null, cab: null, bic: null, default: false }]);
    assert.deepEqual(read.mealVoucherIssuers, [
      { id: 'x', name: 'y', cuts: [] },
      { id: '', name: 'z', cuts: [4, null, null, null, 2.5] },
      { id: 'n', name: '', cuts: [] },
    ]);
    assert.equal(read.eInvoicing.taxRegime, null);
    assert.equal(read.media.internalFileName, '');
  });

  it('reads a minimum order of other shapes without failing, and a logo that is not an object as none', () => {
    const read = company({
      settings: { ecommerce: { minAmount: { EUR: { code: 'EUR', value: 'x' }, USD: 5, GBP: { value: new Int32(7) }, JPY: null } }, global: { lastInvoiceNumber: new Double(1.5) } },
      medias: { images: { customersAppLogoLight: 'file.png', customersAppLogoDark: { basename: 5 } } },
    });
    assert.deepEqual(read.customerApp.ecommerce.minimumOrder, { GBP: 7 });
    assert.equal(read.invoiceNumbering.lastInvoiceNumber, null);
    assert.equal(read.media.customersAppLogoLight, null);
    assert.deepEqual(read.media.customersAppLogoDark, { _id: null, basename: null, extension: null, filename: null, mimetype: null, title: null, alt: null, dirname: null, type: null, filectime: null });
  });

  it('reads a document without a valid _id as the empty id, and the whole-number double lastInvoiceNumber as a number', () => {
    assert.equal(toCompany({ _id: 'x' }, GROUP).id, '');
    assert.equal(company({ settings: { global: { lastInvoiceNumber: new Double(7) } } }).invoiceNumbering.lastInvoiceNumber, 7);
  });

  it('unwraps the numeric types and refuses what is not a finite number', () => {
    assert.equal(numberOf(5), 5);
    assert.equal(numberOf(new Int32(5)), 5);
    assert.equal(numberOf(new Double(5.5)), 5.5);
    assert.equal(numberOf(new Long(5)), 5);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, new Double(Number.NaN), '5', null, undefined, {}, new Decimal128('1')]) {
      assert.equal(numberOf(value), null);
    }
  });

  it('maps a list item of the copies', () => {
    const _id = fixtureId('company', 1);
    assert.deepEqual(toCompanySummary({ _id, name: 'A', code: VAT, city: 'Milano', countryAreaCode: 'MI', countryCode: 'IT', status: true, trash: false, banks: [] }), {
      id: _id.toHexString(),
      name: 'A',
      vatNumber: VAT,
      city: 'Milano',
      province: 'MI',
      country: 'IT',
      status: 'active',
      trashed: false,
    });
    assert.deepEqual(toCompanySummary({ _id, name: 5, code: 6, status: 'true', trash: true }), { id: _id.toHexString(), name: '', vatNumber: null, city: null, province: null, country: null, status: 'disabled', trashed: true });
  });
});

describe('company mapper: the table of keys', () => {
  it('has a stored path for every owned key the backend writes, and no other', () => {
    const writable = LEAVES.filter((leaf) => leaf.readOnly !== true).map((leaf) => leaf.legacy);
    const owned = COMPANIES_OWNED_FIELDS.filter((field) => !['trash', 'updateDate'].includes(field));
    assert.deepEqual([...writable].sort(), [...owned].sort());
    assert.equal(writable.length, new Set(writable).size);
    assert.ok(COMPANY_WHOLE_KEYS.every((key) => writable.includes(key)) && COMPANY_BLOCK_PATHS.every((path) => writable.includes(path)));
    const domain = LEAVES.map((leaf) => leaf.domain);
    assert.equal(domain.length, new Set(domain).size);
  });

  it('reads and sets values at dotted paths of plain objects only', () => {
    const tree: Record<string, unknown> = {};
    setValueAt(tree, 'a.b.c', 1);
    setValueAt(tree, 'a.b.d', null);
    assert.deepEqual(tree, { a: { b: { c: 1, d: null } } });
    assert.equal(valueAt(tree, 'a.b.c'), 1);
    assert.equal(valueAt(tree, 'a.b.d'), null);
    for (const path of ['a.x', 'x', 'a.b.c.d', 'a.b.toString']) {
      assert.equal(valueAt(tree, path), undefined, path);
    }
    assert.equal(valueAt([1], '0'), undefined);
    assert.equal(valueAt(null, 'a'), undefined);
  });
});

describe('company mapper: choosing the keys to write', () => {
  const current = company();
  const stored = fullLegacyCompany(1, GROUP);
  const writes = (request: unknown) => Object.fromEntries(leafWrites(request, current, stored).map((write) => [write.legacy, write.value]));

  it('writes nothing for a request that sends the current values back, whatever their order', () => {
    assert.deepEqual(writes({ name: current.name, address: { ...current.address }, eInvoicing: current.eInvoicing, customerApp: current.customerApp, bankAccounts: current.bankAccounts, media: current.media, status: 'active' }), {});
    assert.deepEqual(writes(JSON.parse(JSON.stringify(current))), {});
  });

  it('writes only what differs, each key at its stored path with its stored form', () => {
    assert.deepEqual(
      writes({
        name: 'New',
        fiscalCode: null,
        email: null,
        phone: '123',
        status: 'disabled',
        expirationDate: '2031-02-03T00:00:00.000Z',
        address: { city: 'Roma', province: '' },
        eInvoicing: { hub: null, eori: 'X', transmitter: { code: null }, rea: { office: null } },
        invoiceNumbering: { position: 'suffix', lastInvoiceNumber: null, cervedLookup: false, values: [{ name: 'Z', cash: false }] },
        customerApp: { showTermsPage: true, ecommerce: { priceListId: null, showProductRemainingQuantity: 4, enableFidelity: true } },
        media: { internalFileName: '', customersAppLogoLight: null },
      }),
      {
        name: 'New',
        code2: '',
        email: null,
        telephone: '123',
        status: false,
        expirationDate: new Date('2031-02-03T00:00:00.000Z'),
        city: 'Roma',
        countryAreaCode: '',
        'fattura_elettronica.hub': '',
        'fattura_elettronica.codice_eori': 'X',
        'fattura_elettronica.IdTrasmittente_codice': '',
        'fattura_elettronica.rea_ufficio': '',
        invoicesPS: 'suffix',
        invoicesPSValues: [{ name: 'Z', cash: false }],
        'settings.global.lastInvoiceNumber': null,
        'settings.api.cerved': false,
        'settings.global.showTermsPage': true,
        'settings.ecommerce.listId': '',
        'settings.ecommerce.showProductRemainingQuantity': 4,
        'settings.ecommerce.enableFidelity': true,
        'medias.images.internalFileName': '',
        'medias.images.customersAppLogoLight': null,
      },
    );
  });

  it('writes a logo taken from an image as the descriptor of the legacy Media Manager: eleven keys in order, the creation time as a double, an empty mmThumb', () => {
    const source = { _id: 'a'.repeat(24), basename: 'logo-1a2b3c4d.png', extension: 'png', filename: 'Logo', mimetype: 'image/png', title: 'T', alt: 'A', dirname: '/media/image', type: 'image', filectime: 1_731_490_000_123 };
    const [light] = Object.values(writes({ media: { customersAppLogoLight: source } })) as [Record<string, unknown>];
    assert.deepEqual(Object.keys(light), ['_id', 'dirname', 'basename', 'extension', 'filename', 'mimetype', 'filectime', 'mmThumb', 'type', 'title', 'alt']);
    assert.ok(light['filectime'] instanceof Double);
    assert.equal((light['filectime'] as Double).value, 1_731_490_000_123);
    assert.deepEqual([light['mmThumb'], light['type'], light['_id'], light['filename']], [{}, 'image', 'a'.repeat(24), 'Logo']);
    assert.deepEqual(writes({ media: { customersAppLogoLight: null, customersAppLogoDark: null } }), { 'medias.images.customersAppLogoLight': null });
    assert.deepEqual(legacyLogoDescriptor(source), light);
  });

  it('writes an expiration date removed as null and a status enabled as true', () => {
    assert.deepEqual(writes({ expirationDate: null }), { expirationDate: null });
    const disabled = toCompany(fullLegacyCompany(1, GROUP, { status: false }), GROUP);
    assert.deepEqual(Object.fromEntries(leafWrites({ status: 'active' }, disabled, null).map((write) => [write.legacy, write.value])), { status: true });
  });

  it('writes the lists whole, in the stored shape of each element', () => {
    assert.deepEqual(writes({ bankAccounts: [{ id: 'bank1', name: 'Main', iban: IBAN, abi: null, cab: '11101', bic: 'DEUTDEFF', default: true }] }), {
      banks: [{ id: 'bank1', name: 'Main', iban: IBAN, abi: '', cab: '11101', bic: 'DEUTDEFF', default: true }],
    });
    assert.deepEqual(writes({ mealVoucherIssuers: [{ id: 'tsupplier1', name: 'Pasti', cuts: [5, null] }] }), { ticketsSuppliers: [{ id: 'tsupplier1', name: 'Pasti', cuts: [5, null] }] });
    assert.deepEqual(writes({ bankAccounts: [] }), { banks: [] });
  });

  it('keeps the minimum orders of other currencies exactly as stored and the unknown keys of an entry', () => {
    const entry = { code: 'EUR', value: new Double(25.5), note: 'keep' };
    const document = fullLegacyCompany(1, GROUP, { settings: { ecommerce: { minAmount: { EUR: entry, XAU: { code: 'XAU', value: new Int32(9) }, odd: 'x' } } } });
    const read = toCompany(document, GROUP);
    assert.deepEqual(read.customerApp.ecommerce.minimumOrder, { EUR: 25.5, XAU: 9 });
    const [write] = leafWrites({ customerApp: { ecommerce: { minimumOrder: { EUR: 30, USD: 1 } } } }, read, document);
    assert.deepEqual(write!.value, { EUR: { code: 'EUR', value: 30, note: 'keep' }, XAU: { code: 'XAU', value: new Int32(9) }, odd: 'x', USD: { code: 'USD', value: 1 } });
    // Nothing stored yet: the map is built from the request.
    const [fresh] = leafWrites({ customerApp: { ecommerce: { minimumOrder: { EUR: 3 } } } }, null, null);
    assert.deepEqual(fresh!.value, { EUR: { code: 'EUR', value: 3 } });
    const [overNothing] = leafWrites({ customerApp: { ecommerce: { minimumOrder: { EUR: 3 } } } }, read, { settings: { ecommerce: { minAmount: 'x' } } });
    assert.deepEqual(overNothing!.value, { EUR: { code: 'EUR', value: 3 } });
  });

  it('writes every key the request has on a creation, and ignores the read-only ones', () => {
    const request = { name: 'N', status: 'active', trashed: true, createdAt: '2020-01-01T00:00:00.000Z', eInvoicing: { hub: null } };
    assert.deepEqual(
      leafWrites(request, null, null).map((write) => [write.domain, write.legacy, write.value]),
      [
        ['name', 'name', 'N'],
        ['status', 'status', true],
        ['eInvoicing.hub', 'fattura_elettronica.hub', ''],
      ],
    );
  });
});

describe('company mapper: ids', () => {
  it('keeps the ObjectId of the document as the hex id', () => {
    const id = new ObjectId();
    assert.equal(toCompany({ _id: id }, GROUP).id, id.toHexString());
  });
});
