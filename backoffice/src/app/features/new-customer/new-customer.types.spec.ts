import { FEATURE_NAMES } from '../../core/groups/feature-catalog';
import { fakeFeatureFlags } from '../../../testing/groups';
import {
  buildBody,
  CUSTOMER_TYPES,
  defaultExpiration,
  eInvoicingIssue,
  expirationInstant,
  fiscalCodeIssue,
  initialModel,
  planFeatures,
  planVatFill,
  postcodeIssue,
  presetFeatures,
  recipientCodeIssue,
  suggestUsername,
  TAX_PRESETS,
  vatIssue,
} from './new-customer.types';

const BASE = fakeFeatureFlags(false, { cash: true, productsVariants: true });
const on = (names: string[]) =>
  Object.fromEntries(FEATURE_NAMES.map((name) => [name, BASE[name] || names.includes(name)]));

describe('presets by type', () => {
  it('has the three types of the legacy, with their tax rates and departments', () => {
    expect(CUSTOMER_TYPES).toEqual(['risto', 'retail', 'beauty']);
    expect(TAX_PRESETS.risto).toEqual([
      { rate: 10, department: 1 },
      { rate: 22, department: 2 },
    ]);
    expect(TAX_PRESETS.retail).toEqual([{ rate: 22, department: 2 }]);
    expect(TAX_PRESETS.beauty).toEqual([{ rate: 22, department: 2 }]);
  });

  it.each([
    ['risto', 'advanced', ['rooms', 'scales', 'ordering']],
    ['risto', 'enterprice', ['rooms', 'scales', 'ordering']],
    ['risto', 'basic', ['rooms']],
    ['retail', 'advanced', []],
    ['retail', 'basic', []],
    ['beauty', 'advanced', ['services', 'appointments']],
    ['beauty', 'enterprice', ['services', 'appointments']],
    ['beauty', 'basic', ['services']],
  ] as const)('%s with the %s plan turns on %j', (type, plan, names) => {
    expect(presetFeatures(type, plan, BASE)).toEqual(on([...names]));
  });

  it('keeps the warehouse switch and drops the other features the operator set', () => {
    const current = fakeFeatureFlags(true);
    expect(presetFeatures('retail', 'basic', current)).toEqual({ ...BASE, warehouse: true });
    expect(presetFeatures('retail', 'basic', BASE).warehouse).toBe(false);
  });

  it('changes only the features that depend on the plan', () => {
    expect(planFeatures('risto', 'basic')).toEqual({ scales: false, ordering: false });
    expect(planFeatures('risto', 'advanced')).toEqual({ scales: true, ordering: true });
    expect(planFeatures('beauty', 'basic')).toEqual({ appointments: false });
    expect(planFeatures('beauty', 'enterprice')).toEqual({ appointments: true });
    expect(planFeatures('retail', 'advanced')).toEqual({});
  });
});

describe('expiration', () => {
  it('is 31 December of the current year in Italy', () => {
    expect(defaultExpiration(new Date('2026-11-16T10:00:00Z'))).toBe('2026-12-31');
    expect(defaultExpiration(new Date('2026-12-31T23:30:00Z'))).toBe('2027-12-31');
  });

  it('is 23:59:59 in Europe/Rome, with the offset of the day (winter and summer time)', () => {
    expect(expirationInstant('2026-12-31')).toBe('2026-12-31T22:59:59.000Z');
    expect(expirationInstant('2027-07-15')).toBe('2027-07-15T21:59:59.000Z');
  });
});

describe('suggestUsername', () => {
  it('joins first and last name in lower case without spaces', () => {
    expect(suggestUsername(' Mario ', 'De Rossi')).toBe('mario.derossi');
  });

  it('is empty until both names are filled', () => {
    expect(suggestUsername('Mario', ' ')).toBe('');
    expect(suggestUsername('', 'Rossi')).toBe('');
  });
});

describe('field rules', () => {
  it('checks the VAT number by country', () => {
    expect(vatIssue('IT', '')).toBeUndefined();
    expect(vatIssue('IT', '00743110157')).toBeUndefined();
    expect(vatIssue('IT', '123')).toBe('pattern');
    expect(vatIssue('DE', 'DE123456')).toBeUndefined();
    expect(vatIssue('DE', 'D')).toBe('pattern');
  });

  it('checks the fiscal code by country', () => {
    expect(fiscalCodeIssue('IT', '')).toBeUndefined();
    expect(fiscalCodeIssue('IT', '00743110157')).toBeUndefined();
    expect(fiscalCodeIssue('IT', 'RSSMRA80A01H501U')).toBeUndefined();
    expect(fiscalCodeIssue('IT', 'ABC')).toBe('pattern');
    expect(fiscalCodeIssue('FR', 'x-1')).toBeUndefined();
    expect(fiscalCodeIssue('FR', 'x'.repeat(31))).toBe('pattern');
  });

  it('checks the recipient code', () => {
    expect(recipientCodeIssue('')).toBeUndefined();
    expect(recipientCodeIssue('abc1234')).toBeUndefined();
    expect(recipientCodeIssue('ABCDEF')).toBeUndefined();
    expect(recipientCodeIssue('ABC')).toBe('pattern');
  });

  it('checks the postcode by country', () => {
    expect(postcodeIssue('IT', ' ')).toBe('required');
    expect(postcodeIssue('IT', '20100')).toBeUndefined();
    expect(postcodeIssue('IT', '2010')).toBe('pattern');
    expect(postcodeIssue('DE', '10115')).toBeUndefined();
    expect(postcodeIssue('DE', 'x'.repeat(17))).toBe('pattern');
  });

  it('asks an Italian company for the recipient code or the PEC', () => {
    const model = initialModel(new Date('2026-01-01T00:00:00Z'));
    expect(eInvoicingIssue(model)).toBe('required');
    expect(eInvoicingIssue({ ...model, recipientCode: 'ABC1234' })).toBeUndefined();
    expect(eInvoicingIssue({ ...model, pec: 'a@pec.it' })).toBeUndefined();
    expect(eInvoicingIssue({ ...model, country: 'DE' })).toBeUndefined();
  });
});

describe('initialModel', () => {
  it('opens with the legacy defaults', () => {
    const model = initialModel(new Date('2026-11-16T10:00:00Z'));
    expect(model).toMatchObject({
      type: 'risto',
      plan: 'advanced',
      country: 'IT',
      expirationDate: '2026-12-31',
      otherAddress: false,
      demo: false,
      dealerId: '',
    });
    expect(model.features).toEqual(on(['rooms', 'scales', 'ordering']));
  });
});

describe('buildBody', () => {
  const filled = {
    ...initialModel(new Date('2026-11-16T10:00:00Z')),
    groupName: ' Nuovo Cliente ',
    companyName: 'Cliente Srl',
    vatNumber: ' 00743110157 ',
    fiscalCode: 'rssmra80a01h501u',
    recipientCode: 'abc1234',
    pec: 'cliente@pec.it',
    street: 'Via Roma 1',
    postcode: '20100',
    city: 'Milano',
    province: 'MI',
    companyPhone: '02 1234',
    companyEmail: 'info@cliente.it',
    placeName: 'Insegna',
    contactName: 'Anna',
    placePhone: '333 1',
    placeEmail: 'bar@cliente.it',
    firstName: 'Mario',
    lastName: 'Rossi',
    userPhone: '333 2',
    userEmail: 'mario@cliente.it',
    username: ' mario.rossi ',
    password: 'Temp-Password-9',
  };
  const taxes = TAX_PRESETS.risto;

  it('sends every filled field, without the type', () => {
    expect(buildBody({ ...filled, dealerId: 'd1', demo: true }, taxes, 'PSA')).toEqual({
      group: {
        name: 'Nuovo Cliente',
        features: filled.features,
        demo: true,
        dealerId: 'd1',
      },
      company: {
        name: 'Cliente Srl',
        vatNumber: '00743110157',
        address: {
          street: 'Via Roma 1',
          postcode: '20100',
          city: 'Milano',
          country: 'IT',
          province: 'MI',
        },
        fiscalCode: 'RSSMRA80A01H501U',
        email: 'info@cliente.it',
        phone: '02 1234',
        eInvoicing: { recipientCode: 'ABC1234', pec: 'cliente@pec.it' },
      },
      place: {
        name: 'Insegna',
        plan: 'advanced',
        expirationDate: '2026-12-31T22:59:59.000Z',
        contactName: 'Anna',
        email: 'bar@cliente.it',
        phone: '333 1',
      },
      user: {
        username: 'mario.rossi',
        password: 'Temp-Password-9',
        firstName: 'Mario',
        lastName: 'Rossi',
        email: 'mario@cliente.it',
        phone: '333 2',
      },
      taxes,
    });
  });

  it('leaves out what is empty, and the demo flag and the dealer of a dealer', () => {
    const body = buildBody(
      {
        ...initialModel(new Date('2026-11-16T10:00:00Z')),
        groupName: 'G',
        companyName: 'C',
        vatNumber: '1',
        street: 's',
        postcode: 'p',
        city: 'c',
        placeName: 'P',
        username: 'u',
        password: 'x',
        dealerId: 'd1',
        demo: true,
      },
      taxes,
      'D',
    );
    expect(body.group).toEqual({ name: 'G', features: expect.any(Object) });
    expect(body.company).toEqual({
      name: 'C',
      vatNumber: '1',
      address: { street: 's', postcode: 'p', city: 'c', country: 'IT' },
    });
    expect(body.place).toEqual({
      name: 'P',
      plan: 'advanced',
      expirationDate: '2026-12-31T22:59:59.000Z',
    });
    expect(body.user).toEqual({ username: 'u', password: 'x' });
  });

  it('sends the demo flag of a platform administrator without a dealer', () => {
    const body = buildBody({ ...filled, demo: false }, taxes, 'PSA');
    expect(body.group).toEqual({ name: 'Nuovo Cliente', features: filled.features, demo: false });
  });

  it('sends the address of the place only when it differs from the company', () => {
    const body = buildBody(
      {
        ...filled,
        otherAddress: true,
        placeStreet: ' Via Po 2 ',
        placePostcode: '10100',
        placeCity: 'Torino',
        placeProvince: 'TO',
      },
      taxes,
      'D',
    );
    expect(body.place.address).toEqual({
      street: 'Via Po 2',
      postcode: '10100',
      city: 'Torino',
      province: 'TO',
    });
    const noProvince = buildBody(
      { ...filled, otherAddress: true, placeStreet: 'a', placePostcode: 'b', placeCity: 'c' },
      taxes,
      undefined,
    );
    expect(noProvince.place.address).toEqual({ street: 'a', postcode: 'b', city: 'c' });
  });
});

describe('planVatFill', () => {
  const found = {
    vatNumber: '00743110157',
    name: 'Azienda Spa',
    fiscalCode: null,
    address: {
      street: 'Via 1',
      postcode: '20100',
      city: 'Milano',
      province: 'mi',
      country: 'IT' as const,
    },
    pec: ' a@pec.it ',
  };

  it('fills the empty fields with trimmed values and upper-case provinces', () => {
    expect(planVatFill(initialModel(new Date()), found, ['MI'])).toEqual({
      empty: {
        companyName: 'Azienda Spa',
        street: 'Via 1',
        postcode: '20100',
        city: 'Milano',
        province: 'MI',
        pec: 'a@pec.it',
      },
      overwrite: {},
    });
  });

  it('separates the fields that hold another value and ignores equal ones', () => {
    const model = {
      ...initialModel(new Date()),
      companyName: 'ALTRA',
      city: 'milano',
      street: ' ',
    };
    const plan = planVatFill(model, found, []);
    expect(plan.overwrite).toEqual({ companyName: 'Azienda Spa' });
    expect(plan.empty).toMatchObject({ street: 'Via 1' });
    expect(plan.empty).not.toHaveProperty('province');
    expect(plan.empty).not.toHaveProperty('city');
  });
});
