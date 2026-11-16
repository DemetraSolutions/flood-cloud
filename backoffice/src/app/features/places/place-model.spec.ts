import { fakePlace, LIST_1 } from '../../../testing/places';
import {
  blockBody,
  createBody,
  dirtySections,
  isGeneralField,
  KIOSK_TEXTS,
  PlaceModel,
  patchBody,
  pickedLogo,
  toModel,
  withSections,
} from './place-model';
import { PlaceRecord, PlaceSection } from './place.types';

/** A fresh, editable model of the standard fake place. */
function modelOf(overrides: Partial<PlaceRecord> = {}): PlaceModel {
  return structuredClone(toModel(fakePlace(overrides)));
}

/** A record with values of the wrong type where the API promises another one. */
function messy(parts: Record<string, unknown>): PlaceRecord {
  return { ...fakePlace(), ...parts } as unknown as PlaceRecord;
}

describe('toModel', () => {
  it('has the defaults of a new place without a record', () => {
    const model = toModel(null);
    expect(model.general).toEqual({
      name: '',
      companyId: '',
      address: { street: '', postcode: '', city: '', province: '', country: 'IT' },
      contactName: '',
      email: '',
      phone: '',
      priceListId: '',
      ecommercePriceListId: '',
      invoiceSeries: '',
      priceLists: [],
    });
    expect(model.license).toEqual({
      plan: 'basic',
      expirationDate: '',
      status: 'active',
      sentry: false,
    });
    expect(model.openingHours.timezone).toBe('Europe/Rome');
    expect(model.openingHours.week['1']).toEqual({ active: false, values: [] });
    expect(model.openingHours.special).toEqual([]);
    expect(model.cashSettings.workshiftNames).toEqual([]);
    expect(model.cashSettings.f['fastLogin']).toBe(false);
    expect(model.cashSettings.f['chargeDocumentQt']).toBe('');
    expect(model.cashSettings.f['receiptsCancellation']).toBe('');
    expect(model.payments.paymentTypes).toEqual([]);
    expect(model.tables.tipValues).toEqual([]);
    expect(model.reservations.timeBlocks).toEqual([]);
    expect(model.delivery.shippingCosts).toEqual([]);
    expect(model.delivery.minAmount).toEqual({});
    expect(model.selfOrdering.priceListsConfig).toEqual([]);
    expect(model.kiosk.productsCategories).toEqual([]);
    expect(model.kiosk.titleText).toEqual({});
    expect(model.media.logos.logoLight).toBeNull();
  });

  it('reads a full record', () => {
    const model = toModel(fakePlace());
    expect(model.general.name).toBe('Bar Roma');
    expect(model.general.address.province).toBe('MI');
    expect(model.general.invoiceSeries).toBe('FE');
    expect(model.general.priceLists).toEqual([
      { id: LIST_1, allYouCanEat: true, ayceCode1: '12', ayceCode2: '' },
    ]);
    expect(model.license).toEqual({
      plan: 'advanced',
      expirationDate: '2030-01-01',
      status: 'active',
      sentry: false,
    });
    expect(model.openingHours.week['1']).toEqual({
      active: true,
      values: [{ start: '09:00', end: '18:00' }],
    });
    expect(model.openingHours.special).toEqual([{ date: '2026-12-25', closed: true, values: [] }]);
    expect(model.openingHours.deliveryTime.special).toEqual([]);
    expect(model.cashSettings.workshiftNames).toEqual([{ name: 'Pranzo' }, { name: 'Cena' }]);
    expect(model.payments.paymentTypes[0]).toEqual({
      id: 'abc1234',
      name: 'Contanti',
      cash: true,
      electronic: false,
      cheque: false,
      tickets: false,
      electronicInvoiceMode: 'MP01',
    });
    expect(model.tables.tipValues).toEqual([{ type: 'p', value: '10' }]);
    expect(model.reservations.timeBlocks).toEqual([
      { weekDays: [1, 2], start: '12:00', end: '14:00' },
    ]);
    expect(model.delivery.shippingCosts).toEqual([{ taxed: '2.5', toKm: '5' }]);
    expect(model.delivery.minAmount).toEqual({ EUR: '10' });
    expect(model.selfOrdering.priceListsConfig[0]).toEqual({
      listId: LIST_1,
      roundTime: '5',
      roundMaxProducts: '3',
      totalMaxProducts: '',
      variants: true,
      freeVariants: false,
      tableAutoClose: false,
      productsCategories: [
        {
          _id: expect.any(String),
          roundMaxProducts: '2',
          totalMaxProducts: '',
          position: '1',
          purchasable: true,
        },
      ],
    });
    expect(model.kiosk.productsCategories).toEqual([{ _id: expect.any(String), position: '1' }]);
    expect(model.kiosk.titleText).toEqual({ it: 'Benvenuti' });
    expect(model.media.logos.logoLight?.descriptor?.filename).toBe('logo');
    expect(model.media.logos.logoLight?.label).toBe('logo');
    expect(model.media.logos.logoLight?.imageId).toBeNull();
    expect(model.media.logos.coverLight).toBeNull();
    expect(model.cashSettings.f['receiptsCancellation']).toBe('');
    expect(model.printing.f['receipt.subtotalFontSize']).toBe('1-1');
    expect(model.reservations.f['step']).toBe('15');
    expect(model.fidelity.f['type']).toBe('');
  });

  it('uses the title of a logo as its label', () => {
    const base = fakePlace();
    const descriptor = { ...(base.media['logoLight'] as object), title: 'Il logo' };
    const model = toModel(fakePlace({ media: { ...base.media, logoLight: descriptor } }));
    expect(model.media.logos.logoLight?.label).toBe('Il logo');
  });

  it('reads the wrong types of an old record without failing', () => {
    const base = fakePlace();
    const model = toModel(
      messy({
        name: 5,
        invoiceSeries: false,
        priceLists: [{ id: 'x', allYouCanEat: 'yes', ayceCode1: 3, ayceCode2: null }],
        license: { plan: 7, expirationDate: null, status: 'disabled', sentry: 'true' },
        openingHours: {
          timezone: 3,
          week: 'wrong',
          special: [1],
          deliveryTime: {
            week: {
              '1': { active: 'x', values: 'no' },
              '2': { active: true, values: [{ start: 1 }, 'x'] },
            },
            special: { '2027-01-01': { closed: 'x', values: [{ start: '10:00', end: '11:00' }] } },
          },
        },
        cashSettings: {
          ...base.cashSettings,
          workshiftNames: ['a', 4, null],
          fastLogin: 'true',
          operatingTime: 5,
        },
        payments: {
          ...base.payments,
          paymentTypes: ['x', { id: 1, name: 2, cash: 'y', electronicInvoiceMode: null }],
        },
        tables: { ...base.tables, tipValues: [{ type: 1, value: '5' }, 3] },
        reservations: {
          ...base.reservations,
          step: 'x',
          timeBlocks: [{ weekDays: [1, '2', null, 3], start: 1, end: null }, 'x'],
        },
        delivery: {
          ...base.delivery,
          takeAway: { shippingCosts: 'no' },
          minAmount: { EUR: '10', USD: 7 },
        },
        selfOrdering: {
          ...base.selfOrdering,
          priceListsConfig: {
            a: 'x',
            b: { roundTime: '3', variants: 'yes', productsCategories: [{ position: 'x' }, 'y'] },
          },
        },
        kiosk: {
          ...base.kiosk,
          productsCategories: 'no',
          titleText: { it: 'A', en: 4 },
          subTitleText: ['a'],
          startButtonText: null,
        },
        media: { ...base.media, logoLight: 'x', coverLight: null, logoKiosk: 5 },
      }),
    );
    expect(model.general.name).toBe('');
    expect(model.general.invoiceSeries).toBe('');
    expect(model.general.priceLists).toEqual([
      { id: 'x', allYouCanEat: false, ayceCode1: '', ayceCode2: '' },
    ]);
    expect(model.license).toEqual({
      plan: '',
      expirationDate: '',
      status: 'disabled',
      sentry: false,
    });
    expect(model.openingHours.timezone).toBe('');
    expect(model.openingHours.week['3']).toEqual({ active: false, values: [] });
    expect(model.openingHours.special).toEqual([]);
    expect(model.openingHours.deliveryTime.week['1']).toEqual({ active: false, values: [] });
    expect(model.openingHours.deliveryTime.week['2']).toEqual({
      active: true,
      values: [
        { start: '', end: '' },
        { start: '', end: '' },
      ],
    });
    expect(model.openingHours.deliveryTime.special).toEqual([
      { date: '2027-01-01', closed: false, values: [{ start: '10:00', end: '11:00' }] },
    ]);
    expect(model.cashSettings.workshiftNames).toEqual([{ name: 'a' }, { name: '' }, { name: '' }]);
    expect(model.cashSettings.f['fastLogin']).toBe(false);
    expect(model.cashSettings.f['operatingTime']).toBe('');
    expect(model.payments.paymentTypes).toEqual([
      {
        id: '',
        name: '',
        cash: false,
        electronic: false,
        cheque: false,
        tickets: false,
        electronicInvoiceMode: '',
      },
      {
        id: '',
        name: '',
        cash: false,
        electronic: false,
        cheque: false,
        tickets: false,
        electronicInvoiceMode: '',
      },
    ]);
    expect(model.tables.tipValues).toEqual([
      { type: '', value: '' },
      { type: '', value: '' },
    ]);
    expect(model.reservations.f['step']).toBe('');
    expect(model.reservations.timeBlocks).toEqual([
      { weekDays: [1, 3], start: '', end: '' },
      { weekDays: [], start: '', end: '' },
    ]);
    expect(model.delivery.shippingCosts).toEqual([]);
    expect(model.delivery.minAmount).toEqual({ EUR: '', USD: '7' });
    expect(model.selfOrdering.priceListsConfig).toEqual([
      {
        listId: 'a',
        roundTime: '',
        roundMaxProducts: '',
        totalMaxProducts: '',
        variants: false,
        freeVariants: false,
        tableAutoClose: false,
        productsCategories: [],
      },
      {
        listId: 'b',
        roundTime: '',
        roundMaxProducts: '',
        totalMaxProducts: '',
        variants: false,
        freeVariants: false,
        tableAutoClose: false,
        productsCategories: [
          { _id: '', roundMaxProducts: '', totalMaxProducts: '', position: '', purchasable: false },
          { _id: '', roundMaxProducts: '', totalMaxProducts: '', position: '', purchasable: false },
        ],
      },
    ]);
    expect(model.kiosk.productsCategories).toEqual([]);
    expect(model.kiosk.titleText).toEqual({ it: 'A' });
    expect(model.kiosk.subTitleText).toEqual({});
    expect(model.kiosk.startButtonText).toEqual({});
    expect(model.media.logos.logoLight).toBeNull();
    expect(model.media.logos.coverLight).toBeNull();
    expect(model.media.logos.logoKiosk).toBeNull();
  });

  it('keeps the texts of every language of the kiosk', () => {
    const base = fakePlace();
    const model = toModel(
      fakePlace({
        kiosk: {
          ...base.kiosk,
          titleText: { it: 'Ciao', en: 'Hi' },
          subTitleText: { it: 'Sotto' },
          startButtonText: { it: 'Via' },
          eatHereText: { it: 'Qui', fr: 'Ici' },
          takeAwayText: { it: 'Fuori' },
        },
      }),
    );
    expect(model.kiosk.titleText).toEqual({ it: 'Ciao', en: 'Hi' });
    expect(model.kiosk.eatHereText).toEqual({ it: 'Qui', fr: 'Ici' });
    expect(model.kiosk.takeAwayText).toEqual({ it: 'Fuori' });
  });
});

describe('dirtySections and withSections', () => {
  it('lists the sections that differ from the baseline', () => {
    const baseline = modelOf();
    const model = structuredClone(baseline);
    expect(dirtySections(model, baseline).size).toBe(0);
    model.general.name = 'Altro';
    model.kiosk.titleText = { it: 'x' };
    expect([...dirtySections(model, baseline)].sort()).toEqual(['general', 'kiosk']);
  });

  it('aligns only the given sections with the saved place', () => {
    const model = modelOf();
    model.general.name = 'Draft';
    model.license.plan = 'basic';
    const saved = fakePlace({ name: 'Saved' });
    const next = withSections(model, saved, ['general']);
    expect(next.general.name).toBe('Saved');
    expect(next.license.plan).toBe('basic');
    expect(model.general.name).toBe('Draft');
  });
});

describe('blockBody', () => {
  const record = fakePlace();

  describe('license', () => {
    it('keeps the stored instant when the date is unchanged', () => {
      expect(blockBody(modelOf(), 'license', record)).toEqual({
        plan: 'advanced',
        expirationDate: '2030-01-01T10:30:00.000Z',
        status: 'active',
        sentry: false,
      });
    });

    it('sends the new date when it changed', () => {
      const model = modelOf();
      model.license.expirationDate = '2031-02-03';
      model.license.status = 'disabled';
      model.license.sentry = true;
      expect(blockBody(model, 'license', record)).toEqual({
        plan: 'advanced',
        expirationDate: '2031-02-03',
        status: 'disabled',
        sentry: true,
      });
    });

    it('sends null for an empty date', () => {
      const model = modelOf();
      model.license.expirationDate = '';
      expect(blockBody(model, 'license', record)).toMatchObject({ expirationDate: null });
    });

    it('sends the date of a place without stored date or record', () => {
      const model = toModel(null);
      expect(blockBody(model, 'license', null)).toMatchObject({ expirationDate: null });
      model.license.expirationDate = '2031-02-03';
      expect(blockBody(model, 'license', null)).toMatchObject({
        plan: 'basic',
        expirationDate: '2031-02-03',
      });
      const unset = fakePlace({ license: { ...record.license, expirationDate: null } });
      expect(blockBody(toModel(unset), 'license', unset)).toMatchObject({ expirationDate: null });
    });
  });

  it('writes the opening hours with the delivery hours', () => {
    const model = modelOf();
    model.openingHours.week['2'] = { active: true, values: [{ start: '08:00', end: '12:00' }] };
    model.openingHours.deliveryTime.special = [
      { date: '2027-01-01', closed: false, values: [{ start: '10:00', end: '11:00' }] },
    ];
    const body = blockBody(model, 'openingHours', record) as {
      timezone: string;
      week: Record<string, unknown>;
      special: Record<string, unknown>;
      deliveryTime: { week: Record<string, unknown>; special: Record<string, unknown> };
    };
    expect(body.timezone).toBe('Europe/Rome');
    expect(Object.keys(body.week).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(body.week['2']).toEqual({ active: true, values: [{ start: '08:00', end: '12:00' }] });
    expect(body.special).toEqual({ '2026-12-25': { closed: true, values: [] } });
    expect(body.deliveryTime.special).toEqual({
      '2027-01-01': { closed: false, values: [{ start: '10:00', end: '11:00' }] },
    });
  });

  it('writes the cash settings without blank shift names', () => {
    const model = modelOf();
    model.cashSettings.workshiftNames = [
      { name: ' Pranzo ' },
      { name: '  ' },
      { name: '' },
      { name: 'Cena' },
    ];
    model.cashSettings.f['chargeDocumentQt'] = '';
    const body = blockBody(model, 'cashSettings', record) as Record<string, unknown>;
    expect(body['workshiftNames']).toEqual(['Pranzo', 'Cena']);
    expect(body['fastLogin']).toBe(false);
    expect(body['chargeDocumentQt']).toBe(1);
    expect(body['receiptsCancellation']).toBeNull();
    expect(body['localWarehouseOutOfStock']).toBe('disabled');
  });

  it('writes the payment types with and without an id', () => {
    const model = modelOf();
    model.payments.paymentTypes.push({
      id: '',
      name: 'Buoni',
      cash: false,
      electronic: false,
      cheque: false,
      tickets: true,
      electronicInvoiceMode: '',
    });
    const body = blockBody(model, 'payments', record) as {
      defaultType: string;
      paymentTypes: object[];
    };
    expect(body.defaultType).toBe('cash');
    expect(body.paymentTypes).toEqual([
      {
        id: 'abc1234',
        name: 'Contanti',
        cash: true,
        electronic: false,
        cheque: false,
        tickets: false,
        electronicInvoiceMode: 'MP01',
      },
      {
        name: 'Buoni',
        cash: false,
        electronic: false,
        cheque: false,
        tickets: true,
        electronicInvoiceMode: null,
      },
    ]);
  });

  it('writes the tables with numeric tips', () => {
    const body = blockBody(modelOf(), 'tables', record) as Record<string, unknown>;
    expect(body['tipValues']).toEqual([{ type: 'p', value: 10 }]);
    expect(body['exitsNumber']).toBe(5);
    expect(body['exits']).toBe(false);
  });

  it('writes the reservation time blocks and the durations in milliseconds', () => {
    const model = modelOf();
    model.reservations.f['step'] = '30';
    const body = blockBody(model, 'reservations', record) as Record<string, unknown>;
    expect(body['timeBlocks']).toEqual([{ weekDays: [1, 2], start: '12:00', end: '14:00' }]);
    expect(body['step']).toBe(1_800_000);
    expect(body['duration']).toBe(1_800_000);
    expect(body['webWidget']).toMatchObject({ status: false, color: '#8936f7' });
  });

  it('writes the delivery with nested shipping costs and the non-empty minimum amounts', () => {
    const model = modelOf();
    model.delivery.minAmount = { EUR: '12.5', USD: '', GBP: '0' };
    const body = blockBody(model, 'delivery', record) as {
      takeAway: Record<string, unknown>;
      minAmount: Record<string, number>;
      step: number | null;
    };
    expect(body.takeAway['shippingCosts']).toEqual([{ taxed: 2.5, toKm: 5 }]);
    expect(body.takeAway['status']).toBe(false);
    expect(body.minAmount).toEqual({ EUR: 12.5, GBP: 0 });
    expect(body.step).toBeNull();
  });

  it('writes the self ordering limits by price list, empty numbers as null', () => {
    const model = modelOf();
    model.selfOrdering.priceListsConfig[0].productsCategories.push({
      _id: 'c2',
      roundMaxProducts: '',
      totalMaxProducts: '4',
      position: '',
      purchasable: false,
    });
    model.selfOrdering.priceListsConfig[0].roundTime = '';
    const body = blockBody(model, 'selfOrdering', record) as {
      status: boolean;
      priceListsConfig: Record<string, { roundTime: number | null; productsCategories: object[] }>;
    };
    expect(body.status).toBe(false);
    const config = body.priceListsConfig[LIST_1];
    expect(config.roundTime).toBeNull();
    expect(config.productsCategories[1]).toEqual({
      _id: 'c2',
      roundMaxProducts: null,
      totalMaxProducts: 4,
      position: null,
      purchasable: false,
    });
    expect(config.productsCategories[0]).toMatchObject({
      roundMaxProducts: 2,
      totalMaxProducts: null,
      position: 1,
    });
  });

  it('writes the kiosk with its categories and one text per language', () => {
    const model = modelOf();
    model.kiosk.productsCategories.push({ _id: 'c2', position: '' });
    model.kiosk.eatHereText = { it: 'Qui', en: 'Here' };
    const body = blockBody(model, 'kiosk', record) as Record<string, unknown>;
    expect(body['productsCategories']).toEqual([
      { _id: expect.any(String), position: 1 },
      { _id: 'c2', position: null },
    ]);
    expect(body['eatHereText']).toEqual({ it: 'Qui', en: 'Here' });
    expect(body['titleText']).toEqual({ it: 'Benvenuti' });
    for (const name of KIOSK_TEXTS) {
      expect(body).toHaveProperty(name);
    }
    expect(body['mode']).toBe('sale');
  });

  it('writes the media: the descriptor kept, the picked image, or null', () => {
    const model = modelOf();
    const kept = model.media.logos.logoLight;
    model.media.logos.coverLight = {
      descriptor: kept!.descriptor,
      imageId: 'img1',
      label: 'x',
      previewUrl: 'blob:x',
    };
    const body = blockBody(model, 'media', record) as Record<string, unknown>;
    expect(body['logoLight']).toBe(kept!.descriptor);
    expect(body['coverLight']).toEqual({ imageId: 'img1' });
    expect(body['logoKiosk']).toBeNull();
    expect(body['coverKiosk']).toBeNull();
    expect(body['productPlaceholderKiosk']).toBeNull();
    expect(body['internalFileNameLogo']).toBe('');
  });

  it.each([
    ['printing', 'receipt'],
    ['appointments', 'type'],
    ['externalDisplay', 'tips'],
    ['fidelity', 'showPoints'],
    ['tobacco', 'status'],
  ] as const)('writes the scalar keys of %s', (section, key) => {
    const body = blockBody(modelOf(), section, record) as Record<string, unknown>;
    expect(body).toHaveProperty(key);
    expect(Object.keys(body)).not.toContain('f');
  });

  it('writes nested keys of the printing and the null choices', () => {
    const body = blockBody(modelOf(), 'printing', record) as { receipt: Record<string, unknown> };
    expect(body.receipt['user']).toBe(false);
    expect(body.receipt['subtotalFontSize']).toBe('1-1');
    const fidelity = blockBody(modelOf(), 'fidelity', record) as Record<string, unknown>;
    expect(fidelity['type']).toBeNull();
    const appointments = blockBody(modelOf(), 'appointments', record) as {
      email: Record<string, unknown>;
      step: number | null;
    };
    expect(appointments.email['templateId']).toBeNull();
  });
});

describe('patchBody', () => {
  const record = fakePlace();
  const general = new Set<PlaceSection>(['general']);

  it('sends nothing for an unchanged general tab', () => {
    expect(patchBody(modelOf(), modelOf(), general, record)).toEqual({});
  });

  it('sends nothing for a section that is not asked for', () => {
    const model = modelOf();
    model.general.name = 'X';
    expect(patchBody(model, modelOf(), new Set(), record)).toEqual({});
  });

  it('sends only the changed text fields, nullable ones as null when emptied', () => {
    const model = modelOf();
    model.general.name = 'Nuovo';
    model.general.companyId = 'c2';
    model.general.contactName = '';
    model.general.email = 'x@y.it';
    model.general.phone = '';
    model.general.priceListId = '';
    model.general.ecommercePriceListId = LIST_1;
    model.general.invoiceSeries = 'ZZ';
    expect(patchBody(model, modelOf(), general, record)).toEqual({
      name: 'Nuovo',
      companyId: 'c2',
      contactName: null,
      email: 'x@y.it',
      phone: null,
      priceListId: null,
      ecommercePriceListId: LIST_1,
      invoiceSeries: 'ZZ',
    });
  });

  it.each(['street', 'postcode', 'city', 'province', 'country'] as const)(
    'sends only the %s of the address when it changed',
    (key) => {
      const model = modelOf();
      model.general.address[key] = 'Z';
      expect(patchBody(model, modelOf(), general, record)).toEqual({ address: { [key]: 'Z' } });
    },
  );

  it('sends the whole price lists when they changed', () => {
    const model = modelOf();
    model.general.priceLists = [
      { id: LIST_1, allYouCanEat: false, ayceCode1: '', ayceCode2: '9' },
      { id: 'l2', allYouCanEat: true, ayceCode1: '1', ayceCode2: '' },
    ];
    expect(patchBody(model, modelOf(), general, record)).toEqual({
      priceLists: [
        { id: LIST_1, allYouCanEat: false, ayceCode1: null, ayceCode2: '9' },
        { id: 'l2', allYouCanEat: true, ayceCode1: '1', ayceCode2: null },
      ],
    });
  });

  it('adds the whole blocks of the other sections, general changes only when general is asked', () => {
    const model = modelOf();
    model.general.name = 'Nuovo';
    model.license.plan = 'basic';
    model.cashSettings.workshiftNames = [{ name: 'Sera' }];
    const body = patchBody(
      model,
      modelOf(),
      new Set<PlaceSection>(['license', 'cashSettings']),
      record,
    );
    expect(Object.keys(body).sort()).toEqual(['cashSettings', 'license']);
    expect(body['license']).toMatchObject({ plan: 'basic' });
    expect(body['cashSettings']).toMatchObject({ workshiftNames: ['Sera'] });
    const both = patchBody(model, modelOf(), new Set<PlaceSection>(['general', 'license']), record);
    expect(Object.keys(both).sort()).toEqual(['license', 'name']);
  });
});

describe('createBody', () => {
  it('sends only the required data of an empty form', () => {
    const model = toModel(null);
    model.general.name = 'Bar';
    model.general.companyId = 'c1';
    model.general.address.street = 'Via 1';
    model.general.address.postcode = '20100';
    model.general.address.city = 'Milano';
    expect(createBody(model, false)).toEqual({
      name: 'Bar',
      companyId: 'c1',
      address: { street: 'Via 1', postcode: '20100', city: 'Milano', country: 'IT' },
    });
  });

  it('sends every optional field that was filled in, and the plan when asked', () => {
    const model = modelOf();
    model.license.plan = 'enterprice';
    const body = createBody(model, true);
    expect(body).toEqual({
      name: 'Bar Roma',
      companyId: expect.any(String),
      address: {
        street: 'Via Roma 1',
        postcode: '20100',
        city: 'Milano',
        country: 'IT',
        province: 'MI',
      },
      contactName: 'Mario Rossi',
      email: 'bar@esempio.it',
      phone: '+39 02 1234567',
      priceListId: LIST_1,
      invoiceSeries: 'FE',
      priceLists: [{ id: LIST_1, allYouCanEat: true, ayceCode1: '12', ayceCode2: null }],
      license: { plan: 'enterprice' },
    });
    model.general.ecommercePriceListId = 'l2';
    expect(createBody(model, false)).toMatchObject({ ecommercePriceListId: 'l2' });
    expect(createBody(model, false)).not.toHaveProperty('license');
  });
});

describe('isGeneralField and pickedLogo', () => {
  it('tells the fields of the general tab', () => {
    expect(isGeneralField('name')).toBe(true);
    expect(isGeneralField('address.city')).toBe(true);
    expect(isGeneralField('priceLists.0.id')).toBe(true);
    expect(isGeneralField('license')).toBe(false);
    expect(isGeneralField('printing.receipt.user')).toBe(false);
  });

  it('re-exports the logo helper of the companies', () => {
    expect(typeof pickedLogo).toBe('function');
  });
});
