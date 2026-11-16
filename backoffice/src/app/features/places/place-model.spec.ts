import {
  CENTER,
  DEVICE_1,
  DEVICE_ID_1,
  fakePlace,
  LIST_1,
  ROOM,
  STATION,
  STORAGE,
} from '../../../testing/places';
import {
  blockBody,
  createBody,
  dirtySections,
  isGeneralField,
  KIOSK_TEXTS,
  newDevice,
  newPrintStation,
  newProductionCenter,
  newRoom,
  newStorage,
  newTable,
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
        license: { plan: 7, expirationDate: null, status: 'disabled' },
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
      });
    });

    it('sends the new date when it changed', () => {
      const model = modelOf();
      model.license.expirationDate = '2031-02-03';
      model.license.status = 'disabled';
      expect(blockBody(model, 'license', record)).toEqual({
        plan: 'advanced',
        expirationDate: '2031-02-03',
        status: 'disabled',
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

describe('new rows', () => {
  it('builds the empty rows with the defaults of the old form', () => {
    expect(newDevice()).toMatchObject({
      id: '',
      withoutId: false,
      type: 'desk',
      automaticCashUsername: { set: false, value: '', clear: false },
      printStations: [],
    });
    expect(newPrintStation()).toMatchObject({ id: '', driver: 'EPSON-EPOS-PRINT', pulseNumber: '' });
    expect(newProductionCenter()).toEqual({ id: '', withoutId: false, name: '', capacity: '' });
    expect(newTable('T9', '4')).toMatchObject({
      id: '',
      name: 'T9',
      seats: '4',
      view: { w: 1, h: 1, x: null, y: null, shape: 'rect' },
    });
    expect(newTable().name).toBe('');
    expect(newRoom()).toMatchObject({ id: '', view: { type: 'grid', status: false, h: 8, w: 8 } });
    expect(newStorage()).toEqual({ id: '', name: '', cash: false, ecommerce: false });
  });
});

describe('the lists of the place', () => {
  it('reads devices, print stations, rooms and storages', () => {
    const model = toModel(fakePlace());
    expect(model.devices.editable).toBe(true);
    expect(model.devices.items).toHaveLength(2);
    expect(model.devices.items[0]).toMatchObject({
      id: DEVICE_ID_1,
      withoutId: false,
      server: true,
      name: 'Cassa 1',
      automaticCashUsername: { set: true, value: '', clear: false },
      automaticCashPassword: { set: false, value: '', clear: false },
      printStations: [STATION.id],
    });
    expect(model.printStations.stations[0]).toMatchObject({
      id: STATION.id,
      pulseNumber: '1',
      pulseNumberSecondary: '',
    });
    expect(model.printStations.productionCenters[0]).toEqual({
      id: CENTER.id,
      withoutId: false,
      name: 'Forno',
      capacity: '10',
    });
    expect(model.printStations.stationsEditable).toBe(true);
    expect(model.printStations.productionCentersEditable).toBe(true);
    expect(model.rooms.items[0]).toMatchObject({ name: 'Sala 1', service: '10', withoutId: false });
    expect(model.rooms.items[0].tables[0]).toEqual({
      id: 'tab0001',
      withoutId: false,
      name: 'T1',
      seats: '4',
      userId: '',
      view: { w: 1, h: 1, x: 0, y: 0, shape: 'rect' },
    });
    expect(model.rooms.items[0].tables[1].view).toEqual({
      w: 2,
      h: 1,
      x: null,
      y: null,
      shape: 'round',
    });
    expect(model.storages.items).toEqual([
      { id: STORAGE.id, name: 'Deposito 1', cash: true, ecommerce: false },
    ]);
  });

  it('is empty for a new place and reads the editable flags', () => {
    const empty = toModel(null);
    expect(empty.devices).toEqual({ items: [], editable: true });
    expect(empty.printStations).toEqual({
      stations: [],
      productionCenters: [],
      stationsEditable: true,
      productionCentersEditable: true,
    });
    expect(empty.rooms).toEqual({ items: [], editable: true });
    expect(empty.storages).toEqual({ items: [], editable: true });
    const locked = toModel(
      fakePlace({
        devices: { items: [], editable: false },
        printStations: {
          stations: [],
          productionCenters: [],
          stationsEditable: false,
          productionCentersEditable: false,
        },
        rooms: { items: [], editable: false },
        storages: { items: [], editable: false },
      }),
    );
    expect(locked.devices.editable).toBe(false);
    expect(locked.printStations.stationsEditable).toBe(false);
    expect(locked.printStations.productionCentersEditable).toBe(false);
    expect(locked.rooms.editable).toBe(false);
    expect(locked.storages.editable).toBe(false);
  });

  it('reads the rows without an id and the wrong types of an old record', () => {
    const model = toModel(
      messy({
        devices: {
          items: [
            {
              ...DEVICE_1,
              withoutId: true,
              server: 'x',
              name: 4,
              printStations: ['a', 3, null],
              automaticCashUsernameSet: 'yes',
            },
          ],
          editable: true,
        },
        printStations: {
          stations: [{ id: 's', withoutId: true, name: 1, pulseNumber: 'x', summaryCategoriesIds: 'no' }],
          productionCenters: [{ id: 'c', withoutId: true, capacity: 'x' }],
          stationsEditable: true,
          productionCentersEditable: true,
        },
        rooms: {
          items: [
            {
              ...ROOM,
              withoutId: true,
              view: 'x',
              tables: [{ id: 't', withoutId: true, view: { w: 'x', h: 3, x: 'y', y: 2, shape: 'oval' } }],
            },
            { ...ROOM, view: { type: 'other', status: 'x', h: 'x', w: 4 } },
          ],
          editable: true,
        },
        storages: { items: [{ id: 'g', name: 5, cash: 'y', ecommerce: 1 }], editable: true },
      }),
    );
    expect(model.devices.items[0]).toMatchObject({
      withoutId: true,
      server: false,
      name: '',
      printStations: ['a'],
      automaticCashUsername: { set: false },
    });
    expect(model.printStations.stations[0]).toMatchObject({
      withoutId: true,
      name: '',
      pulseNumber: '',
      summaryCategoriesIds: [],
    });
    expect(model.printStations.productionCenters[0]).toMatchObject({ withoutId: true, capacity: '' });
    expect(model.rooms.items[0]).toMatchObject({
      withoutId: true,
      view: { type: '', status: false, h: 8, w: 8 },
    });
    expect(model.rooms.items[0].tables[0]).toMatchObject({
      withoutId: true,
      view: { w: 1, h: 3, x: null, y: 2, shape: 'rect' },
    });
    expect(model.rooms.items[1].view).toEqual({ type: 'grid', status: false, h: 8, w: 4 });
    expect(model.storages.items[0]).toEqual({ id: 'g', name: '', cash: false, ecommerce: false });
  });

  it('writes the devices with the credentials only when typed or cleared', () => {
    const model = modelOf();
    const [desk, display] = model.devices.items;
    desk.automaticCashUsername.value = 'user';
    desk.automaticCashPassword.clear = true;
    const created = newDevice();
    created.name = 'Nuova';
    model.devices.items.push(created);
    const body = blockBody(model, 'devices', fakePlace()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).toMatchObject({
      id: DEVICE_ID_1,
      name: 'Cassa 1',
      automaticCashUsername: 'user',
      automaticCashPassword: null,
      printStations: [STATION.id],
    });
    expect(body.items[1]).not.toHaveProperty('automaticCashUsername');
    expect(body.items[1]).not.toHaveProperty('automaticCashPassword');
    expect(body.items[1]['id']).toBe(display.id);
    expect(body.items[2]).not.toHaveProperty('id');
    expect(body.items[2]).not.toHaveProperty('automaticCashUsername');
  });

  it('writes the print stations and the production centers, omitting the locked lists', () => {
    const model = modelOf();
    model.printStations.stations.push({ ...newPrintStation(), name: 'Bar', pulseNumber: '2' });
    model.printStations.productionCenters.push({ ...newProductionCenter(), name: 'Pizza', capacity: '3' });
    const body = blockBody(model, 'printStations', fakePlace()) as {
      stations: Record<string, unknown>[];
      productionCenters: Record<string, unknown>[];
    };
    expect(body.stations[0]).toMatchObject({ id: STATION.id, pulseNumber: 1, pulseNumberSecondary: null });
    expect(body.stations[1]).toMatchObject({ name: 'Bar', pulseNumber: 2 });
    expect(body.stations[1]).not.toHaveProperty('id');
    expect(body.productionCenters).toEqual([
      { id: CENTER.id, name: 'Forno', capacity: 10 },
      { name: 'Pizza', capacity: 3 },
    ]);
    model.printStations.stationsEditable = false;
    expect(blockBody(model, 'printStations', fakePlace())).toHaveProperty('productionCenters');
    expect(blockBody(model, 'printStations', fakePlace())).not.toHaveProperty('stations');
    model.printStations.stationsEditable = true;
    model.printStations.productionCentersEditable = false;
    expect(blockBody(model, 'printStations', fakePlace())).toHaveProperty('stations');
    expect(blockBody(model, 'printStations', fakePlace())).not.toHaveProperty('productionCenters');
    model.printStations.stationsEditable = false;
    expect(blockBody(model, 'printStations', fakePlace())).toEqual({});
  });

  it('writes the rooms with their tables and the storages', () => {
    const model = modelOf();
    const room = { ...newRoom(), name: 'Terrazza', service: '5' };
    room.tables.push(newTable('A', ''));
    model.rooms.items.push(room);
    model.storages.items.push({ ...newStorage(), name: 'Nuovo', ecommerce: true });
    const rooms = blockBody(model, 'rooms', fakePlace()) as { items: Record<string, any>[] };
    expect(rooms.items[0]).toMatchObject({ id: ROOM.id, service: 10, listId: ROOM.listId });
    expect(rooms.items[0]['tables'][0]).toEqual({
      id: 'tab0001',
      name: 'T1',
      seats: 4,
      userId: '',
      view: { w: 1, h: 1, x: 0, y: 0, shape: 'rect' },
    });
    expect(rooms.items[1]).not.toHaveProperty('id');
    expect(rooms.items[1]['tables'][0]).toEqual({
      name: 'A',
      seats: null,
      userId: '',
      view: { w: 1, h: 1, x: null, y: null, shape: 'rect' },
    });
    expect(rooms.items[1]['view']).toEqual({ type: 'grid', status: false, h: 8, w: 8 });
    expect(blockBody(model, 'storages', fakePlace())).toEqual({
      items: [
        { id: STORAGE.id, name: 'Deposito 1', cash: true, ecommerce: false },
        { name: 'Nuovo', cash: false, ecommerce: true },
      ],
    });
  });
});

describe('integrations and dealer settings', () => {
  const secretKeys = (model: PlaceModel): string[] => Object.keys(model.integrations.secrets);

  it('reads the switches and settings, never a credential', () => {
    const base = fakePlace();
    const record = fakePlace({
      integrations: {
        ...base.integrations,
        easyappear: { status: true, appTokenSet: true },
        tsh: { status: false, testMode: true, idSet: false, secretSet: true, propertyId: 'P1' },
        keenon: { status: false, storeId: 'S1' },
      },
    });
    const model = toModel(record);
    expect(model.integrations.f['easyappear.status']).toBe(true);
    expect(model.integrations.f['tsh.propertyId']).toBe('P1');
    expect(model.integrations.f['tsh.testMode']).toBe(true);
    expect(Object.keys(model.integrations.f)).not.toContain('easyappear.appToken');
    expect(model.integrations.secrets['easyappear.appToken']).toEqual({
      set: true,
      value: '',
      clear: false,
    });
    expect(model.integrations.secrets['tsh.id'].set).toBe(false);
    expect(model.integrations.secrets['tsh.secret'].set).toBe(true);
    expect(secretKeys(model)).toContain('plateform.password');
    expect(Object.values(model.integrations.secrets).every((secret) => secret.value === '')).toBe(true);
  });

  it('has no credential set for a new place', () => {
    const model = toModel(null);
    expect(Object.values(model.integrations.secrets).every((secret) => !secret.set)).toBe(true);
    expect(model.dealerSettings.f).toEqual({ sentry: false, serverIp: '', connectorAddress: '' });
  });

  it('writes only the credentials that were typed or cleared, nested by key', () => {
    const model = modelOf();
    const body = blockBody(model, 'integrations', fakePlace()) as Record<string, any>;
    expect(body['easyappear']).toEqual({ status: false });
    expect(body['plateform']).toEqual({ status: false });
    model.integrations.f['easyappear.status'] = true;
    model.integrations.secrets['easyappear.appToken'].value = 'tok';
    model.integrations.secrets['plateform.username'].clear = true;
    model.integrations.secrets['plateform.password'].value = 'ignored';
    model.integrations.secrets['plateform.password'].clear = true;
    model.integrations.secrets['tsh.id'].value = 'id1';
    model.integrations.secrets['tsh.secret'].value = 'sec1';
    const changed = blockBody(model, 'integrations', fakePlace()) as Record<string, any>;
    expect(changed['easyappear']).toEqual({ status: true, appToken: 'tok' });
    expect(changed['plateform']).toEqual({ status: false, username: null, password: null });
    expect(changed['tsh']).toMatchObject({ id: 'id1', secret: 'sec1', testMode: false });
    expect(changed['yellgo']).toEqual({ status: false });
  });

  it('writes the dealer settings as scalars and keeps clean credentials out of the dirty set', () => {
    const model = modelOf();
    model.dealerSettings.f['sentry'] = true;
    model.dealerSettings.f['serverIp'] = '10.0.0.1';
    expect(blockBody(model, 'dealerSettings', fakePlace())).toEqual({
      sentry: true,
      serverIp: '10.0.0.1',
      connectorAddress: '',
    });
    const baseline = modelOf();
    expect(dirtySections(model, baseline)).toEqual(new Set(['dealerSettings']));
    const typed = structuredClone(baseline);
    typed.integrations.secrets['yellgo.apiKey'].value = 'k';
    expect(dirtySections(typed, baseline)).toEqual(new Set(['integrations']));
  });

  it('replaces the saved sections of the lists and credentials with withSections', () => {
    const model = modelOf();
    model.integrations.secrets['yellgo.apiKey'].value = 'k';
    model.rooms.items = [];
    const saved = fakePlace();
    const next = withSections(model, saved, ['integrations', 'rooms']);
    expect(next.integrations.secrets['yellgo.apiKey'].value).toBe('');
    expect(next.rooms.items).toHaveLength(1);
    expect(model.rooms.items).toHaveLength(0);
  });

  it('nests a credential below the key of its switch', () => {
    const model = modelOf();
    model.integrations.secrets['easyappear.appToken'].value = 't';
    const body = blockBody(model, 'integrations', fakePlace()) as Record<string, any>;
    expect(body['easyappear'].appToken).toBe('t');
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
