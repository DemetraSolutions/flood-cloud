import { ApiError } from '../../core/api/api-error';
import { fakeDealer } from '../../../testing/dealers';
import {
  buildCompanyBody,
  buildCompanyPatch,
  codeIssue,
  CompanyModel,
  formFieldOf,
  hasAddress,
  isItalian,
  provinceIssue,
  sdiIssue,
  textOrNull,
  toCompanyModel,
  toDealerFormModel,
  toFormErrors,
} from './dealer.types';

const EMPTY = toCompanyModel(null);
const FULL = toCompanyModel(fakeDealer());
const foreign = (over: Partial<CompanyModel>): CompanyModel => ({
  ...FULL,
  countryCode: 'DE',
  province: '',
  ...over,
});

describe('models', () => {
  it('builds empty models with the default country', () => {
    expect(EMPTY).toMatchObject({ businessName: '', countryCode: 'IT', street: '' });
    expect(toDealerFormModel(null)).toMatchObject({
      username: '',
      userLanguage: 'it',
      countryCode: 'IT',
    });
  });

  it('copies the stored dealer, turning nulls into empty strings', () => {
    expect(FULL).toMatchObject({ businessName: 'Dealer Nord Srl', city: 'Milano', province: 'MI' });
    const sparse = toCompanyModel(
      fakeDealer({
        vatNumber: null,
        address: { street: 's', postcode: 'p', city: 'c', province: null, countryCode: 'DE' },
      }),
    );
    expect(sparse).toMatchObject({ vatNumber: '', province: '', countryCode: 'DE' });
  });

  it('trims text and turns blank into null', () => {
    expect(textOrNull('  a ')).toBe('a');
    expect(textOrNull('   ')).toBeNull();
  });
});

describe('address and country', () => {
  it('knows when an address was started', () => {
    expect(hasAddress(EMPTY)).toBe(false);
    expect(hasAddress({ ...EMPTY, province: 'MI' })).toBe(true);
    expect(hasAddress({ ...EMPTY, city: ' x' })).toBe(true);
  });

  it('is Italian without an address, or with country IT in any case', () => {
    expect(isItalian({ ...EMPTY, countryCode: 'DE' })).toBe(true);
    expect(isItalian({ ...FULL, countryCode: ' it ' })).toBe(true);
    expect(isItalian({ ...FULL, countryCode: '' })).toBe(true);
    expect(isItalian(foreign({}))).toBe(false);
  });
});

describe('codeIssue', () => {
  it('accepts empty and valid Italian codes, case-insensitively', () => {
    expect(codeIssue('vatNumber', EMPTY)).toBeUndefined();
    expect(codeIssue('vatNumber', FULL)).toBeUndefined();
    expect(codeIssue('fiscalCode', { ...FULL, fiscalCode: 'rssmra80a01h501u' })).toBeUndefined();
    expect(codeIssue('fiscalCode', FULL)).toBeUndefined();
  });

  it('rejects wrong Italian codes', () => {
    expect(codeIssue('vatNumber', { ...FULL, vatNumber: '123' })).toBe('pattern');
    expect(codeIssue('vatNumber', { ...FULL, vatNumber: '1234567890A' })).toBe('pattern');
    expect(codeIssue('fiscalCode', { ...FULL, fiscalCode: 'ABC' })).toBe('pattern');
  });

  it('uses the looser foreign rule elsewhere', () => {
    expect(codeIssue('vatNumber', foreign({ vatNumber: 'de123' }))).toBeUndefined();
    expect(codeIssue('vatNumber', foreign({ vatNumber: 'D' }))).toBe('pattern');
    expect(codeIssue('fiscalCode', foreign({ fiscalCode: 'AB-1' }))).toBe('pattern');
  });
});

describe('sdiIssue and provinceIssue', () => {
  it('needs seven alphanumeric characters, when given', () => {
    expect(sdiIssue('')).toBeUndefined();
    expect(sdiIssue('abc1234')).toBeUndefined();
    expect(sdiIssue('ABC123')).toBe('pattern');
  });

  it('requires a two-letter province for an Italian address only', () => {
    expect(provinceIssue(EMPTY)).toBeUndefined();
    expect(provinceIssue(FULL)).toBeUndefined();
    expect(provinceIssue({ ...FULL, province: '' })).toBe('required');
    expect(provinceIssue({ ...FULL, province: 'M1' })).toBe('pattern');
    expect(provinceIssue({ ...FULL, province: 'mi' })).toBeUndefined();
    expect(provinceIssue(foreign({ province: '' }))).toBeUndefined();
  });
});

describe('buildCompanyBody', () => {
  it('sends only the filled fields, codes in upper case, no address when empty', () => {
    expect(
      buildCompanyBody({ ...EMPTY, businessName: ' Acme ', vatNumber: ' 0123456789a ' }),
    ).toEqual({
      businessName: 'Acme',
      vatNumber: '0123456789A',
    });
  });

  it('adds the address with the default country and the province when present', () => {
    const body = buildCompanyBody({ ...FULL, province: 'mi', countryCode: '' });
    expect(body.address).toEqual({
      street: 'Via Roma 1',
      postcode: '20100',
      city: 'Milano',
      countryCode: 'IT',
      province: 'MI',
    });
    expect(buildCompanyBody(foreign({ province: '' })).address).toEqual({
      street: 'Via Roma 1',
      postcode: '20100',
      city: 'Milano',
      countryCode: 'DE',
    });
    expect(body.pec).toBe('nord@pec.example.com');
    expect(body.sdiCode).toBe('ABC1234');
  });
});

describe('buildCompanyPatch', () => {
  const dealer = fakeDealer();

  it('is empty without changes or without a dealer', () => {
    expect(buildCompanyPatch(FULL, dealer)).toEqual({});
    expect(buildCompanyPatch(FULL, null)).toEqual({});
  });

  it('sends changed fields, upper-casing codes and nulling emptied ones', () => {
    expect(
      buildCompanyPatch(
        { ...FULL, businessName: ' Nuova ', vatNumber: '', sdiCode: 'xyz1234', pec: '' },
        dealer,
      ),
    ).toEqual({ businessName: 'Nuova', vatNumber: null, sdiCode: 'XYZ1234', pec: null });
  });

  it('merges the address partially', () => {
    expect(buildCompanyPatch({ ...FULL, city: 'Torino', province: 'to' }, dealer)).toEqual({
      address: { city: 'Torino', province: 'TO' },
    });
    expect(buildCompanyPatch({ ...FULL, province: '', countryCode: 'DE' }, dealer)).toEqual({
      address: { countryCode: 'DE', province: null },
    });
  });

  it('removes the address when it is cleared, and sends it whole when it is new', () => {
    expect(
      buildCompanyPatch({ ...FULL, street: '', postcode: '', city: '', province: '' }, dealer),
    ).toEqual({
      address: null,
    });
    const without = fakeDealer({ address: null });
    expect(buildCompanyPatch(toCompanyModel(without), without)).toEqual({});
    expect(
      buildCompanyPatch(
        { ...toCompanyModel(without), street: 'Via 1', postcode: '1', city: 'X', province: 'MI' },
        without,
      ).address,
    ).toEqual({ street: 'Via 1', postcode: '1', city: 'X', countryCode: 'IT', province: 'MI' });
  });
});

describe('error field names', () => {
  it('maps backend fields to form fields', () => {
    expect(formFieldOf('company.vatNumber')).toBe('vatNumber');
    expect(formFieldOf('company.address.province')).toBe('province');
    expect(formFieldOf('address.city')).toBe('city');
    expect(formFieldOf('businessName')).toBe('businessName');
    expect(formFieldOf('user.username')).toBe('username');
    expect(formFieldOf('user.firstName')).toBe('userFirstName');
    expect(formFieldOf('user.unknown')).toBe('user.unknown');
    expect(formFieldOf('username')).toBe('username');
  });

  it('renames the details of an error', () => {
    const error = new ApiError({
      status: 409,
      code: 'CONFLICT',
      message: 'm',
      requestId: 'r',
      details: [{ field: 'company.vatNumber', issue: 'taken' }],
    });
    const mapped = toFormErrors(error);
    expect(mapped.details).toEqual([{ field: 'vatNumber', issue: 'taken' }]);
    expect(mapped.requestId).toBe('r');
    expect(mapped.code).toBe('CONFLICT');
  });
});
