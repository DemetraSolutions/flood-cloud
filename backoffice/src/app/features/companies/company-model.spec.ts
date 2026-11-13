import { fakeCompany, fakeImage } from '../../../testing/companies';
import {
  blockBody,
  createBody,
  dirtySections,
  formPathOf,
  patchBody,
  pickedLogo,
  sectionOfField,
  toModel,
  withSections,
} from './company-model';
import { companyRoute, CompanySection } from './company.types';

describe('toModel', () => {
  it('gives the defaults of a new company', () => {
    const model = toModel(null);
    expect(model.general).toMatchObject({
      name: '',
      status: 'active',
      currency: 'EUR',
      expirationDate: '',
      address: { country: 'IT', province: '' },
    });
    expect(model.invoiceNumbering).toEqual({
      position: '',
      values: [],
      lastInvoiceNumber: '',
      discountLines: false,
      cervedLookup: false,
    });
    expect(model.bankAccounts).toEqual([]);
    expect(model.customerApp.ecommerce).toMatchObject({
      status: false,
      priceListId: '',
      showProductRemainingQuantity: '0',
      minimumOrder: {},
      enableFidelity: false,
    });
    expect(model.media).toEqual({
      internalFileName: '',
      externalUrl: '',
      customersAppLogoLight: null,
      customersAppLogoDark: null,
    });
  });

  it('turns a company into texts, with empty ones for the missing data', () => {
    const base = fakeCompany();
    const model = toModel(
      fakeCompany({
        expirationDate: '2030-05-06T00:00:00.000Z',
        email: null,
        currency: null,
        bankAccounts: [
          { ...base.bankAccounts[0], name: null, abi: null, cab: null, bic: 'BCITITMM' },
        ],
        invoiceNumbering: { ...base.invoiceNumbering, position: null, lastInvoiceNumber: null },
      }),
    );
    expect(model.general.expirationDate).toBe('2030-05-06');
    expect(model.general.email).toBe('');
    expect(model.general.currency).toBe('');
    expect(model.bankAccounts[0]).toMatchObject({
      name: '',
      abi: '',
      cab: '',
      bic: 'BCITITMM',
      default: true,
    });
    expect(model.invoiceNumbering.position).toBe('');
    expect(model.invoiceNumbering.lastInvoiceNumber).toBe('');
    expect(model.mealVoucherIssuers[0].cuts).toEqual(['5', '10', '']);
    expect(model.customerApp.ecommerce.minimumOrder).toEqual({ EUR: '25.5' });
    expect(model.media.customersAppLogoLight?.label).toBe('logo');
    expect(toModel(fakeCompany()).invoiceNumbering.lastInvoiceNumber).toBe('120');
  });

  it('labels a stored logo by its title when it has one', () => {
    const base = fakeCompany();
    const descriptor = {
      ...(base.media.customersAppLogoLight as object),
      title: 'Titolo',
    } as never;
    const model = toModel(
      fakeCompany({ media: { ...base.media, customersAppLogoDark: descriptor } }),
    );
    expect(model.media.customersAppLogoDark?.label).toBe('Titolo');
  });
});

describe('dirtySections and withSections', () => {
  it('names the sections that differ from the baseline', () => {
    const baseline = toModel(fakeCompany());
    expect(dirtySections(baseline, baseline).size).toBe(0);
    const model = structuredClone(baseline);
    model.general.name = 'Altro';
    model.bankAccounts.push({
      id: '',
      name: '',
      iban: 'X',
      abi: '',
      cab: '',
      bic: '',
      default: false,
    });
    expect([...dirtySections(model, baseline)]).toEqual(['general', 'bankAccounts']);
  });

  it('replaces only the sections that were saved', () => {
    const model = toModel(fakeCompany());
    model.general.name = 'Bozza';
    model.eInvoicing.pec = 'bozza@x.it';
    const next = withSections(model, fakeCompany({ name: 'Salvata' }), ['general']);
    expect(next.general.name).toBe('Salvata');
    expect(next.eInvoicing.pec).toBe('bozza@x.it');
  });
});

describe('request bodies', () => {
  const baseline = toModel(fakeCompany());

  it('builds the creation body from the filled-in data', () => {
    const minimal = toModel(null).general;
    Object.assign(minimal, { name: 'N', vatNumber: 'V' });
    Object.assign(minimal.address, { street: 'S', postcode: 'P', city: 'C' });
    expect(createBody(minimal)).toEqual({
      name: 'N',
      vatNumber: 'V',
      address: { street: 'S', postcode: 'P', city: 'C', country: 'IT' },
      currency: 'EUR',
      status: 'active',
    });
    Object.assign(minimal, {
      fiscalCode: 'F',
      email: 'e@x.it',
      phone: '1',
      expirationDate: '2030-01-01',
    });
    minimal.address.province = 'MI';
    expect(createBody(minimal)).toEqual({
      name: 'N',
      vatNumber: 'V',
      address: { street: 'S', postcode: 'P', city: 'C', country: 'IT', province: 'MI' },
      currency: 'EUR',
      status: 'active',
      fiscalCode: 'F',
      email: 'e@x.it',
      phone: '1',
      expirationDate: '2030-01-01',
    });
  });

  it('sends only the blocks when the general tab is not among the sections', () => {
    const model = structuredClone(baseline);
    model.general.name = 'Ignorato';
    const body = patchBody(model, baseline, new Set<CompanySection>(['media']));
    expect(Object.keys(body)).toEqual(['media']);
  });

  it('sends nothing of the general tab when nothing changed', () => {
    expect(patchBody(baseline, baseline, new Set<CompanySection>(['general']))).toEqual({});
  });

  it('sends the changed general fields and the whole blocks asked for', () => {
    const model = structuredClone(baseline);
    model.general.vatNumber = 'IT01114601006';
    model.general.fiscalCode = '';
    model.general.address.city = 'Roma';
    model.general.currency = 'USD';
    model.general.expirationDate = '';
    model.general.status = 'disabled';
    model.general.phone = '';
    model.general.email = 'nuova@x.it';
    const body = patchBody(
      model,
      baseline,
      new Set<CompanySection>(['general', 'invoiceNumbering']),
    );
    expect(body).toMatchObject({
      vatNumber: 'IT01114601006',
      address: { city: 'Roma' },
      currency: 'USD',
      status: 'disabled',
      phone: null,
      email: 'nuova@x.it',
      invoiceNumbering: { position: 'prefix', lastInvoiceNumber: 120 },
    });
    expect(body['fiscalCode']).toBeUndefined();
    expect(Object.keys(body)).not.toContain('eInvoicing');
  });

  it('writes the e-invoicing block with every key, empty texts as null', () => {
    const model = toModel(fakeCompany());
    model.eInvoicing.eori = '';
    model.eInvoicing.hub = '';
    expect(blockBody(model, 'eInvoicing')).toEqual({
      hub: null,
      transmitter: { country: 'IT', code: '01879020517' },
      eori: null,
      pec: 'pec@esempio.it',
      recipientCode: 'ABC1234',
      professionalRegister: { name: null, number: null, province: null, date: null },
      rea: {
        office: 'MI',
        number: '123456',
        shareCapital: '10000.50',
        shareholders: 'SU',
        liquidation: 'LN',
      },
      taxRegime: 'RF01',
    });
  });

  it('writes the numbering, the banks and the issuers', () => {
    const model = toModel(fakeCompany());
    model.invoiceNumbering.position = '';
    model.invoiceNumbering.lastInvoiceNumber = '';
    expect(blockBody(model, 'invoiceNumbering')).toEqual({
      position: null,
      values: [
        { name: 'FE', cash: true },
        { name: 'NC', cash: false },
      ],
      lastInvoiceNumber: null,
      discountLines: true,
      cervedLookup: false,
    });
    model.bankAccounts.push({
      id: '',
      name: '',
      iban: 'it60 x054 2811 1010 0000 0123 456',
      abi: '',
      cab: '',
      bic: '',
      default: false,
    });
    expect(blockBody(model, 'bankAccounts')).toEqual([
      {
        id: '6a1b00000000000000000001',
        name: 'Banca',
        iban: 'IT60X0542811101000000123456',
        abi: '05428',
        cab: '11101',
        bic: null,
        default: true,
      },
      {
        name: null,
        iban: 'IT60X0542811101000000123456',
        abi: null,
        cab: null,
        bic: null,
        default: false,
      },
    ]);
    model.mealVoucherIssuers.push({ id: '', name: 'Nuovo', cuts: ['7.5', ''] });
    expect(blockBody(model, 'mealVoucherIssuers')).toEqual([
      { id: '6a1c00000000000000000001', name: 'Buoni Pasto', cuts: [5, 10, null] },
      { name: 'Nuovo', cuts: [7.5, null] },
    ]);
  });

  it('writes the customer app with numbers, and the media with the right logo form', () => {
    const model = toModel(fakeCompany());
    model.customerApp.ecommerce.priceListId = '';
    model.customerApp.ecommerce.minimumOrder = { EUR: '30', USD: '' };
    model.customerApp.ecommerce.showProductRemainingQuantity = '4';
    const app = blockBody(model, 'customerApp') as Record<string, unknown>;
    expect(app).toMatchObject({
      enableLoginSignup: true,
      ecommerce: {
        status: true,
        priceListId: null,
        minimumOrder: { EUR: 30, USD: 0 },
        showProductRemainingQuantity: 4,
      },
    });
    model.media.customersAppLogoDark = pickedLogo(fakeImage());
    const media = blockBody(model, 'media') as Record<string, unknown>;
    expect(media['customersAppLogoDark']).toEqual({ imageId: fakeImage().id });
    expect(media['customersAppLogoLight']).toEqual(fakeCompany().media.customersAppLogoLight);
    model.media.customersAppLogoLight = null;
    expect(
      (blockBody(model, 'media') as Record<string, unknown>)['customersAppLogoLight'],
    ).toBeNull();
  });
});

describe('pickedLogo', () => {
  it('describes an image picked from the library', () => {
    expect(pickedLogo(fakeImage())).toEqual({
      descriptor: null,
      imageId: fakeImage().id,
      label: 'Logo Bar',
      previewUrl: 'https://files.test/s/logo.png',
    });
    expect(pickedLogo(fakeImage({ urls: null })).previewUrl).toBeNull();
  });
});

describe('field paths', () => {
  it('tells the section of a backend field', () => {
    expect(sectionOfField('address.street')).toBe('general');
    expect(sectionOfField('bankAccounts.0.iban')).toBe('bankAccounts');
    expect(sectionOfField('(body)')).toBe('general');
  });

  it('places the general fields under the general tab of the model', () => {
    expect(formPathOf('vatNumber')).toBe('general.vatNumber');
    expect(formPathOf('address.street')).toBe('general.address.street');
    expect(formPathOf('eInvoicing.hub')).toBe('eInvoicing.hub');
    expect(formPathOf('anything')).toBe('anything');
  });

  it('builds the route of a company', () => {
    expect(companyRoute('g', 'c')).toEqual(['/groups', 'g', 'companies', 'c']);
  });
});
