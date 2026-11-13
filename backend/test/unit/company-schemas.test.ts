import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/shared/http/errors.ts';
import {
  companiesQuery,
  companyParams,
  createCompanyBody,
  patchCompanyBody,
  putBankAccountsBody,
  putCustomerAppBody,
  putEInvoicingBody,
  putInvoiceNumberingBody,
  putMealVoucherIssuersBody,
  putMediaBody,
} from '../../src/modules/companies/companies.schemas.ts';
import { validate } from '../../src/shared/validation/schema.ts';
import type { Schema } from '../../src/shared/validation/schema.ts';
import { ECOMMERCE_FLAGS } from '../../src/shared/legacy-write/company-paths.ts';
import { IBAN, VAT } from '../helpers/company-fixtures.ts';

const parse = (schema: Schema<unknown>, value: unknown): unknown => validate(schema, value, '(body)');
const details = (schema: Schema<unknown>, value: unknown): unknown => {
  try {
    validate(schema, value, '(body)');
  } catch (error) {
    if (error instanceof AppError) {
      return error.details;
    }
    throw error;
  }
  return null;
};
const issues = (schema: Schema<unknown>, value: unknown, ...expected: Array<[string, string]>): void => assert.deepEqual(details(schema, value), expected.map(([field, issue]) => ({ field, issue })));

const ADDRESS = { street: 'Via Roma 1', postcode: '20100', city: 'Milano', country: 'IT' };
const MINIMUM = { name: 'Acme', vatNumber: VAT, address: ADDRESS };

describe('company body: creation and modification', () => {
  it('accepts the general data alone on a creation, trimmed', () => {
    assert.deepEqual(parse(createCompanyBody, { name: '  Acme  ', vatNumber: ` ${VAT} `, address: { ...ADDRESS, province: 'MI' } }), { name: 'Acme', vatNumber: VAT, address: { ...ADDRESS, province: 'MI' } });
  });

  it('requires name, VAT number and the address of a creation, but not the province', () => {
    issues(createCompanyBody, {}, ['name', 'required'], ['vatNumber', 'required'], ['address', 'required']);
    issues(createCompanyBody, { ...MINIMUM, address: {} }, ['address.street', 'required'], ['address.postcode', 'required'], ['address.city', 'required'], ['address.country', 'required']);
    issues(createCompanyBody, { ...MINIMUM, name: '   ', vatNumber: '' }, ['name', 'minLength'], ['vatNumber', 'minLength']);
  });

  it('accepts any subset on a modification, and the empty object (the service refuses it)', () => {
    assert.deepEqual(parse(patchCompanyBody, {}), {});
    assert.deepEqual(parse(patchCompanyBody, { address: { city: 'Roma' }, eInvoicing: { rea: { office: 'RM' } }, customerApp: { ecommerce: { catalogMode: true } } }), {
      address: { city: 'Roma' },
      eInvoicing: { rea: { office: 'RM' } },
      customerApp: { ecommerce: { catalogMode: true } },
    });
    issues(patchCompanyBody, { name: '' }, ['name', 'minLength']);
    issues(patchCompanyBody, { address: { street: '' } }, ['address.street', 'minLength']);
  });

  it('rejects unknown keys, operators and the fields the API never writes', () => {
    issues(patchCompanyBody, { id: 'x', groupId: 'x', trashed: true, createdAt: 'x', settings: {}, fattura_elettronica: {}, code: 'x' }, ['id', 'unknown'], ['groupId', 'unknown'], ['trashed', 'unknown'], ['createdAt', 'unknown'], ['settings', 'unknown'], ['fattura_elettronica', 'unknown'], ['code', 'unknown']);
    issues(patchCompanyBody, JSON.parse('{"$set": 1, "address": {"__proto__": 1, "a.b": 2}}'), ['(key)', 'forbiddenKey'], ['address.(key)', 'forbiddenKey'], ['address.(key)', 'forbiddenKey']);
    issues(patchCompanyBody, { eInvoicing: { unknown: 1, transmitter: { x: 1 } } }, ['eInvoicing.unknown', 'unknown'], ['eInvoicing.transmitter.x', 'unknown']);
  });

  it('checks the country, the currency, the status, the e-mail and the phone', () => {
    issues(patchCompanyBody, { address: { country: 'it' }, currency: 'eur', status: 'on', email: 'nope', phone: 'x'.repeat(31) }, ['address.country', 'pattern'], ['currency', 'pattern'], ['email', 'format'], ['phone', 'maxLength'], ['status', 'enum']);
    assert.deepEqual(parse(patchCompanyBody, { email: ' Info@Acme.EXAMPLE ', phone: '' , fiscalCode: '', status: 'disabled', currency: 'USD' }), { email: 'info@acme.example', phone: null, fiscalCode: null, status: 'disabled', currency: 'USD' });
    assert.deepEqual(parse(patchCompanyBody, { email: null, phone: null, fiscalCode: null }), { email: null, phone: null, fiscalCode: null });
  });

  it('takes the expiration date as an instant, normalized, or null', () => {
    assert.deepEqual(parse(patchCompanyBody, { expirationDate: '2031-02-03' }), { expirationDate: '2031-02-03T00:00:00.000Z' });
    assert.deepEqual(parse(patchCompanyBody, { expirationDate: '2031-02-03T10:20:30Z' }), { expirationDate: '2031-02-03T10:20:30.000Z' });
    assert.deepEqual(parse(patchCompanyBody, { expirationDate: null }), { expirationDate: null });
    issues(patchCompanyBody, { expirationDate: '2031-02-30' }, ['expirationDate', 'format']);
    issues(patchCompanyBody, { expirationDate: 5 }, ['expirationDate', 'type']);
  });
});

describe('company body: e-invoicing', () => {
  const FULL = {
    hub: 'aruba',
    transmitter: { country: 'IT', code: '01879020517' },
    eori: null,
    pec: 'pec@acme.example',
    recipientCode: 'abc1234',
    professionalRegister: { name: null, number: null, province: 'MI', date: '2020-02-29' },
    rea: { office: 'MI', number: '123', shareCapital: '10000.50', shareholders: 'SU', liquidation: 'LN' },
    taxRegime: 'RF19',
  };

  it('accepts the whole block, with the recipient code in upper case, and empty strings as null', () => {
    assert.deepEqual(parse(putEInvoicingBody, FULL), { ...FULL, recipientCode: 'ABC1234' });
    assert.deepEqual(
      parse(putEInvoicingBody, { ...FULL, hub: '', eori: '', pec: '', recipientCode: '', taxRegime: '', transmitter: { country: '', code: '' }, rea: { office: '', number: '', shareCapital: '', shareholders: '', liquidation: '' }, professionalRegister: { name: '', number: '', province: '', date: '' } }),
      { hub: null, eori: null, pec: null, recipientCode: null, taxRegime: null, transmitter: { country: null, code: null }, rea: { office: null, number: null, shareCapital: null, shareholders: null, liquidation: null }, professionalRegister: { name: null, number: null, province: null, date: null } },
    );
  });

  it('requires every key of the whole block, nested ones included', () => {
    issues(putEInvoicingBody, {}, ['hub', 'required'], ['transmitter', 'required'], ['eori', 'required'], ['pec', 'required'], ['recipientCode', 'required'], ['professionalRegister', 'required'], ['rea', 'required'], ['taxRegime', 'required']);
    issues(putEInvoicingBody, { ...FULL, transmitter: {}, rea: { office: 'MI' } }, ['transmitter.country', 'required'], ['transmitter.code', 'required'], ['rea.number', 'required'], ['rea.shareCapital', 'required'], ['rea.shareholders', 'required'], ['rea.liquidation', 'required']);
  });

  it('checks the formats', () => {
    issues(
      putEInvoicingBody,
      { ...FULL, pec: 'x', recipientCode: 'ABC', taxRegime: 'RF03', transmitter: { country: 'ITA', code: 'x'.repeat(29) }, professionalRegister: { name: null, number: null, province: 'XX', date: '2026-02-30' }, rea: { office: 'XX', number: 'x'.repeat(21), shareCapital: '1,5', shareholders: 'XX', liquidation: 'XX' } },
      ['transmitter.country', 'maxLength'],
      ['transmitter.code', 'maxLength'],
      ['pec', 'format'],
      ['recipientCode', 'format'],
      ['professionalRegister.province', 'enum'],
      ['professionalRegister.date', 'format'],
      ['rea.office', 'enum'],
      ['rea.number', 'maxLength'],
      ['rea.shareCapital', 'format'],
      ['rea.shareholders', 'enum'],
      ['rea.liquidation', 'enum'],
      ['taxRegime', 'enum'],
    );
  });
});

describe('company body: invoice numbering', () => {
  const FULL = { position: 'prefix', values: [{ name: 'FE', cash: true }, { name: 'NC', cash: false }], lastInvoiceNumber: 120, discountLines: true, cervedLookup: false };
  it('accepts the whole block and its limits', () => {
    assert.deepEqual(parse(putInvoiceNumberingBody, FULL), FULL);
    assert.deepEqual(parse(putInvoiceNumberingBody, { ...FULL, position: null, values: [], lastInvoiceNumber: null }), { ...FULL, position: null, values: [], lastInvoiceNumber: null });
    assert.deepEqual(parse(putInvoiceNumberingBody, { ...FULL, lastInvoiceNumber: 2_147_483_647 }), { ...FULL, lastInvoiceNumber: 2_147_483_647 });
    assert.equal((parse(putInvoiceNumberingBody, { ...FULL, values: Array.from({ length: 50 }, (_unused, index) => ({ name: `S${String(index)}`, cash: false })) }) as { values: unknown[] }).values.length, 50);
  });
  it('requires every key of the whole block', () => {
    issues(putInvoiceNumberingBody, {}, ['position', 'required'], ['values', 'required'], ['lastInvoiceNumber', 'required'], ['discountLines', 'required'], ['cervedLookup', 'required']);
  });
  it('checks the position, the number and the series', () => {
    issues(putInvoiceNumberingBody, { ...FULL, position: 'middle', lastInvoiceNumber: 2_147_483_648 }, ['position', 'enum'], ['lastInvoiceNumber', 'maximum']);
    issues(putInvoiceNumberingBody, { ...FULL, lastInvoiceNumber: -1 }, ['lastInvoiceNumber', 'minimum']);
    issues(putInvoiceNumberingBody, { ...FULL, lastInvoiceNumber: 1.5 }, ['lastInvoiceNumber', 'type']);
    issues(putInvoiceNumberingBody, { ...FULL, values: [{ name: '', cash: false }, { name: 'x'.repeat(51), cash: false }] }, ['values.0.name', 'minLength'], ['values.1.name', 'maxLength']);
    issues(putInvoiceNumberingBody, { ...FULL, values: Array.from({ length: 51 }, (_unused, index) => ({ name: `S${String(index)}`, cash: false })) }, ['values', 'tooMany']);
  });
  it('refuses repeated names and more than one series for the cash sales, naming the later elements', () => {
    issues(putInvoiceNumberingBody, { ...FULL, values: [{ name: 'A', cash: true }, { name: 'A', cash: true }, { name: 'B', cash: true }, { name: 'B', cash: false }] }, ['values.1.name', 'incorrect'], ['values.3.name', 'incorrect'], ['values.1.cash', 'incorrect'], ['values.2.cash', 'incorrect']);
  });
});

describe('company body: bank accounts', () => {
  const BANK = { name: 'Main', iban: IBAN, abi: '05428', cab: '11101', bic: 'DEUTDEFF', default: true };
  it('normalizes the IBAN and the BIC, fills the defaults and keeps an id', () => {
    assert.deepEqual(parse(putBankAccountsBody, [{ id: 'bank1', iban: ' it60 x054 2811 1010 0000 0123 456 ' }]), [{ id: 'bank1', name: '', iban: IBAN, abi: null, cab: null, bic: null, default: false }]);
    assert.deepEqual(parse(putBankAccountsBody, [{ ...BANK, bic: 'deutdeff500', abi: '', cab: null }]), [{ name: 'Main', iban: IBAN, abi: null, cab: null, bic: 'DEUTDEFF500', default: true }]);
    assert.deepEqual(parse(putBankAccountsBody, []), []);
  });
  it('requires an IBAN with the checksum and checks the other codes', () => {
    issues(putBankAccountsBody, [{}], ['0.iban', 'required']);
    issues(putBankAccountsBody, [{ iban: '' }], ['0.iban', 'minLength']);
    issues(putBankAccountsBody, [{ iban: 'IT60X0542811101000000123457' }], ['0.iban', 'format']);
    issues(putBankAccountsBody, [{ iban: IBAN, abi: '1234', cab: 'abcde', bic: 'XX', name: 'x'.repeat(101), id: 'a b' }], ['0.id', 'pattern'], ['0.name', 'maxLength'], ['0.abi', 'format'], ['0.cab', 'format'], ['0.bic', 'format']);
    issues(putBankAccountsBody, [{ iban: 5 }], ['0.iban', 'type']);
  });
  it('allows at most twenty accounts and one default', () => {
    assert.equal((parse(putBankAccountsBody, Array.from({ length: 20 }, () => ({ iban: IBAN }))) as unknown[]).length, 20);
    issues(putBankAccountsBody, Array.from({ length: 21 }, () => ({ iban: IBAN })), ['(body)', 'tooMany']);
    issues(putBankAccountsBody, [{ iban: IBAN, default: true }, { iban: IBAN, default: false }, { iban: IBAN, default: true }, { iban: IBAN, default: true }], ['2.default', 'incorrect'], ['3.default', 'incorrect']);
  });
});

describe('company body: meal voucher issuers', () => {
  it('fills the cuts, keeps an id and checks the limits', () => {
    assert.deepEqual(parse(putMealVoucherIssuersBody, [{ name: ' Pasti ' }, { id: 'x1', name: 'Altri', cuts: [5, 7.5, null, 0] }]), [{ name: 'Pasti', cuts: [] }, { id: 'x1', name: 'Altri', cuts: [5, 7.5, null, 0] }]);
    issues(putMealVoucherIssuersBody, [{ name: '' }, { name: 'x', cuts: [-1] }, { name: 'x', cuts: Array.from({ length: 51 }, () => 1) }, { name: 'x', cuts: ['5'] }], ['0.name', 'minLength'], ['1.cuts.0', 'minimum'], ['2.cuts', 'tooMany'], ['3.cuts.0', 'type']);
    issues(putMealVoucherIssuersBody, Array.from({ length: 51 }, () => ({ name: 'x' })), ['(body)', 'tooMany']);
  });
});

describe('company body: customer app', () => {
  const FULL = (): Record<string, unknown> => ({
    enableLoginSignup: true,
    showPrivacyPage: false,
    showTermsPage: true,
    ecommerce: { ...Object.fromEntries(ECOMMERCE_FLAGS.map((key) => [key, false])), priceListId: 'pl1', minimumOrder: { EUR: 25.5 }, showProductRemainingQuantity: 3 },
  });
  it('accepts the whole block with every flag of the legacy', () => {
    assert.deepEqual(parse(putCustomerAppBody, FULL()), FULL());
    assert.deepEqual((parse(putCustomerAppBody, { ...FULL(), ecommerce: { ...(FULL()['ecommerce'] as object), priceListId: '', minimumOrder: {} } }) as { ecommerce: { priceListId: null } }).ecommerce.priceListId, null);
  });
  it('requires the exact key set and refuses the others', () => {
    issues(putCustomerAppBody, {}, ['enableLoginSignup', 'required'], ['showPrivacyPage', 'required'], ['showTermsPage', 'required'], ['ecommerce', 'required']);
    const missing = FULL();
    delete (missing['ecommerce'] as Record<string, unknown>)['enableFidelity'];
    delete (missing['ecommerce'] as Record<string, unknown>)['priceListId'];
    issues(putCustomerAppBody, missing, ['ecommerce.enableFidelity', 'required'], ['ecommerce.priceListId', 'required']);
    issues(putCustomerAppBody, { ...FULL(), ecommerce: { ...(FULL()['ecommerce'] as object), extra: true } }, ['ecommerce.extra', 'unknown']);
  });
  it('checks the types, the amounts and the currency keys of the minimum order', () => {
    issues(putCustomerAppBody, { ...FULL(), showTermsPage: 'yes', ecommerce: { ...(FULL()['ecommerce'] as object), catalogMode: 1, showProductRemainingQuantity: -1, priceListId: 'a b', minimumOrder: { eur: 1, USD: -1, GBP: 'x' } } }, ['showTermsPage', 'type'], ['ecommerce.catalogMode', 'type'], ['ecommerce.priceListId', 'pattern'], ['ecommerce.minimumOrder.eur', 'format'], ['ecommerce.minimumOrder.USD', 'minimum'], ['ecommerce.minimumOrder.GBP', 'type'], ['ecommerce.showProductRemainingQuantity', 'minimum']);
    issues(putCustomerAppBody, { ...FULL(), ecommerce: { ...(FULL()['ecommerce'] as object), minimumOrder: Object.fromEntries(Array.from({ length: 11 }, (_unused, index) => [`C${String.fromCharCode(65 + index)}A`, 1])) } }, ['ecommerce.minimumOrder', 'tooMany']);
  });
});

describe('company body: media', () => {
  const LOGO = { _id: 'f00d', basename: 'light.png', extension: 'png', filename: 'light', mimetype: 'image/png', title: null, alt: null, dirname: '/media/image', type: 'image', filectime: 1_700_000_000_000 };
  const FULL = { internalFileName: 'logo.png', externalUrl: 'https://example.test/logo.png', customersAppLogoLight: LOGO, customersAppLogoDark: null };
  it('accepts the whole block, the logos as a descriptor or null, and no URL', () => {
    assert.deepEqual(parse(putMediaBody, FULL), FULL);
    assert.deepEqual(parse(putMediaBody, { ...FULL, externalUrl: '', internalFileName: '' }), { ...FULL, externalUrl: '', internalFileName: '' });
    assert.deepEqual(parse(putMediaBody, { ...FULL, externalUrl: 'http://example.test/x' }), { ...FULL, externalUrl: 'http://example.test/x' });
  });
  it('requires every key and refuses an URL that is not http(s), control characters, a descriptor with other keys and too long texts', () => {
    issues(putMediaBody, {}, ['internalFileName', 'required'], ['externalUrl', 'required'], ['customersAppLogoLight', 'required'], ['customersAppLogoDark', 'required']);
    issues(putMediaBody, { ...FULL, externalUrl: 'javascript:alert(1)' }, ['externalUrl', 'format']);
    issues(putMediaBody, { ...FULL, externalUrl: 'not a url' }, ['externalUrl', 'format']);
    issues(putMediaBody, { ...FULL, externalUrl: 'https://x.test/\u0007' }, ['externalUrl', 'pattern']);
    issues(putMediaBody, { ...FULL, internalFileName: 'a\nb' }, ['internalFileName', 'pattern']);
    for (const internalFileName of ['../x', 'a/b', 'a\\b', '.x', 'a..b']) {
      issues(putMediaBody, { ...FULL, internalFileName }, ['internalFileName', 'pattern']);
    }
    issues(putMediaBody, { ...FULL, internalFileName: 'x'.repeat(256), externalUrl: `https://x.test/${'x'.repeat(2048)}` }, ['internalFileName', 'maxLength'], ['externalUrl', 'maxLength']);
    issues(putMediaBody, { ...FULL, customersAppLogoLight: { ...LOGO, mmThumb: {} } }, ['customersAppLogoLight.mmThumb', 'unknown']);
    issues(putMediaBody, { ...FULL, customersAppLogoDark: { ...LOGO, filectime: 'x', _id: 5 } }, ['customersAppLogoDark._id', 'type'], ['customersAppLogoDark.filectime', 'type']);
  });
});

describe('company body: a logo picked from an image', () => {
  const FULL = { internalFileName: '', externalUrl: '', customersAppLogoLight: null, customersAppLogoDark: null };
  const imageId = '0123456789abcdef01234567';
  it('accepts { imageId } for either logo, next to null and the stored descriptor', () => {
    assert.deepEqual(parse(putMediaBody, { ...FULL, customersAppLogoLight: { imageId }, customersAppLogoDark: { imageId } }), { ...FULL, customersAppLogoLight: { imageId }, customersAppLogoDark: { imageId } });
    assert.deepEqual(parse(patchCompanyBody, { media: { customersAppLogoDark: { imageId } } }), { media: { customersAppLogoDark: { imageId } } });
  });
  it('judges any object with an imageId as a reference: only that key, 24 lower case hexadecimal characters', () => {
    issues(putMediaBody, { ...FULL, customersAppLogoLight: { imageId, basename: 'x.png' } }, ['customersAppLogoLight.basename', 'unknown']);
    issues(putMediaBody, { ...FULL, customersAppLogoLight: { imageId: 'abc' } }, ['customersAppLogoLight.imageId', 'minLength']);
    issues(putMediaBody, { ...FULL, customersAppLogoLight: { imageId: 'G'.repeat(24) } }, ['customersAppLogoLight.imageId', 'pattern']);
    issues(putMediaBody, { ...FULL, customersAppLogoLight: { imageId: imageId.toUpperCase() } }, ['customersAppLogoLight.imageId', 'pattern']);
    issues(putMediaBody, { ...FULL, customersAppLogoLight: { imageId: 5 } }, ['customersAppLogoLight.imageId', 'type']);
    issues(putMediaBody, { ...FULL, customersAppLogoLight: { imageId: undefined, _id: 'x' } }, ['customersAppLogoLight._id', 'unknown'], ['customersAppLogoLight.imageId', 'required']);
  });
});

describe('company list query and params', () => {
  it('accepts the list parameters and the filters of the list', () => {
    assert.deepEqual(parse(companiesQuery, { status: 'active', country: 'IT', province: 'MI', trashed: 'true', q: ' acme ', limit: '10', sort: '-name' }), { status: 'active', country: 'IT', province: 'MI', trashed: 'true', q: 'acme', limit: 10, sort: '-name' });
    assert.deepEqual(parse(companiesQuery, {}), {});
    issues(companiesQuery, { status: 'x', country: 'ITA', province: '', trashed: 'maybe', sort: 'vat', ids: 'x' }, ['sort', 'enum'], ['trashed', 'enum'], ['ids', 'minLength'], ['status', 'enum'], ['country', 'maxLength'], ['province', 'minLength']);
    issues(companiesQuery, { country: 'it' }, ['country', 'pattern']);
    issues(companiesQuery, { unknown: '1' }, ['unknown', 'unknown']);
  });
  it('takes the company id of the path and lets the group parameter through', () => {
    const id = '0123456789abcdef01234567';
    assert.equal((parse(companyParams, { groupId: id, companyId: id }) as { companyId: { toHexString(): string } }).companyId.toHexString(), id);
    issues(companyParams, { companyId: 'x' }, ['companyId', 'format']);
  });
});
