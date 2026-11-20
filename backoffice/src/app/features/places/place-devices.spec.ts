import { backend, errorBody } from '../../../testing/api';
import {
  DEVICE_1,
  DEVICE_2,
  DEVICE_ID_1,
  DEVICE_ID_2,
  fakePlace,
  GROUP,
  PLACE_URL,
  renderPlace,
  ROOM,
  STATION_ID,
} from '../../../testing/places';
import {
  cleanUp,
  clickIn,
  failSave,
  READ_ONLY,
  savePut,
  submitTab,
  typeWithin,
  within,
} from '../../../testing/places-tabs';
import { PlaceDevice } from './place.types';

const L = (key: string) => `PLACES.DEVICES.${key}`;
const T = (type: string) => L(`TYPE.${type}`);

afterEach(cleanUp);

type View = Awaited<ReturnType<typeof renderPlace>>;
const cards = (view: View) => [...view.root.querySelectorAll<HTMLElement>('article.device')];
const box = (row: HTMLElement, label: string) => within(row, label) as HTMLInputElement;
const tick = async (view: View, row: HTMLElement, label: string, checked: boolean) => {
  const control = box(row, label);
  control.checked = checked;
  control.dispatchEvent(new Event('change'));
  await view.view();
};
const open = async (view: View, index: number) => {
  await clickIn(view, cards(view)[index], 'PLACES.DEVICES.EDIT');
  return cards(view)[index];
};
/** The body of a device as the save sends it (no credentials, unchanged). */
const stored = (device: PlaceDevice) => {
  const { automaticCashUsernameSet, automaticCashPasswordSet, ...rest } = device;
  void automaticCashUsernameSet;
  void automaticCashPasswordSet;
  return rest;
};
const withDevices = (items: PlaceDevice[], plan = 'advanced', editable = true) =>
  fakePlace({
    devices: { items, editable },
    license: { plan, expirationDate: '2030-01-01T10:30:00.000Z', status: 'active' },
  });
const NEW_DEVICE = {
  server: false,
  type: 'desk',
  name: 'Nuovo',
  driver: '',
  host: '',
  serialNumber: '',
  epsonProtocol17: false,
  epsonEreceipt: false,
  DLN502017Rounding: false,
  secondaryDriver: '',
  secondaryHost: '',
  automaticCashDriver: '',
  automaticCashHost: '',
  posProtocol17ip: '',
  posProtocol17port: '',
  posProtocol17terminalId: '',
  posDojoTerminalId: '',
  externalDisplayId: '',
  secondaryCompanyPrinterId: '',
  favoritesId: '',
  scaleDialog0204Ip: '',
  scaleDialog0204Port: '',
  scaleDialog0204SendPrice: false,
  barcodePriceRule: '',
  orderingPrintSingleProduct: false,
  orderingPrintSingleProductTables: false,
  printStations: [] as string[],
  multisafepayAppStatus: false,
  multisafepayQrStatus: false,
  multisafepayTerminals: [] as { terminalId: string; name: string }[],
};
const CA = { role: 'CA' as const, groupId: GROUP };

describe('PlaceDevices', () => {
  it('lists the devices closed, with the server badge and the type', async () => {
    const view = await renderPlace({ path: 'devices' });
    const [first, second] = cards(view);
    expect(first.querySelector('strong')?.textContent).toBe('Cassa 1');
    expect(first.querySelector('fc-status-badge')?.textContent).toContain(L('SERVER'));
    expect(first.textContent).toContain(T('DESK'));
    expect(second.querySelector('fc-status-badge')).toBeNull();
    expect(second.textContent).toContain(T('EXTERNAL_DISPLAY'));
    expect(first.querySelector('input')).toBeNull();
    expect(view.text()).toContain(L('SERVER_INFO'));
  });

  it('opens a device with its stored data and never shows a credential', async () => {
    const view = await renderPlace({ path: 'devices' });
    const card = await open(view, 0);
    expect(box(card, L('SERVER')).checked).toBe(true);
    expect(box(card, L('NAME')).value).toBe('Cassa 1');
    expect(box(card, T('DESK')).checked).toBe(true);
    expect(box(card, T('HANDHELD')).checked).toBe(false);
    expect(box(card, L('FISCAL_DRIVER')).value).toBe('EPSON-FP-81-II-RT');
    expect(
      [...box(card, L('FISCAL_DRIVER')).querySelectorAll('option')].map((o) => o.value),
    ).toEqual(['', 'EPSON-FP-81-II-RT', 'CUSTOM-K3-Q3X-KUBEX', 'EPSON-EPOS-PRINT', 'ESCPOS']);
    expect(box(card, L('CASH_DRIVER')).querySelectorAll('option')).toHaveLength(14);
    expect(box(card, L('SECONDARY_DRIVER')).querySelectorAll('option')).toHaveLength(3);
    expect(box(card, L('HOST')).value).toBe('192.168.1.10');
    expect(box(card, L('CASH_HOST')).value).toBe('192.168.1.30');
    expect(box(card, L('DISPLAY')).value).toBe(DEVICE_ID_2);
    expect(box(card, 'Cucina').checked).toBe(true);
    expect(card.querySelector('input[type=password]')).toBeNull();
    const states = [...card.querySelectorAll('.credential-state')].map((s) =>
      s.textContent?.trim(),
    );
    expect(states).toEqual(['PLACES.CREDENTIAL.SET', 'PLACES.CREDENTIAL.NOT_SET']);
    expect(card.querySelector('button[aria-expanded=true]')?.textContent?.trim()).toBe(
      'PLACES.DEVICES.CLOSE',
    );
    await clickIn(view, card, 'PLACES.DEVICES.CLOSE');
    expect(cards(view)[0].querySelector('input')).toBeNull();
  });

  it('saves a change with the whole list, keeping the ids and sending no credential', async () => {
    const view = await renderPlace({ path: 'devices' });
    const card = await open(view, 0);
    await typeWithin(view, card, L('NAME'), 'Cassa principale');
    await typeWithin(view, card, L('FISCAL_DRIVER'), 'ESCPOS');
    await typeWithin(view, card, L('HOST'), '10.0.0.1');
    await typeWithin(view, card, L('SERIAL_NUMBER'), 'SN9');
    await tick(view, card, L('EPSON_PROTOCOL_17'), true);
    await tick(view, card, L('EPSON_ERECEIPT'), true);
    await tick(view, card, L('ROUNDING'), true);
    await typeWithin(view, card, L('SECONDARY_DRIVER'), 'ESCPOS');
    await typeWithin(view, card, L('SECONDARY_HOST'), '10.0.0.2');
    await typeWithin(view, card, L('CASH_DRIVER'), 'CASHDRO-7');
    await typeWithin(view, card, L('CASH_HOST'), '10.0.0.3');
    await typeWithin(view, card, L('IP'), '10.0.0.4');
    await typeWithin(view, card, L('PORT'), '9100');
    const terminals = [...card.querySelectorAll('label')].filter(
      (l) => l.textContent?.trim() === L('TERMINAL_ID'),
    );
    const setTerminal = async (index: number, value: string) => {
      const field = card.querySelector<HTMLInputElement>(`#${terminals[index].htmlFor}`)!;
      field.value = value;
      field.dispatchEvent(new Event('input'));
      await view.view();
    };
    await setTerminal(0, 'T17');
    await setTerminal(1, 'DOJO');
    await typeWithin(view, card, L('DISPLAY'), '');
    await typeWithin(view, card, L('FAVORITES'), 'fav0001');
    await tick(view, card, 'Cucina', false);
    await tick(view, card, 'Cucina', true);
    await tick(view, card, L('SINGLE_PRODUCT'), true);
    await tick(view, card, L('SINGLE_PRODUCT_TABLES'), true);
    await typeWithin(view, card, L('SCALE_IP'), '10.0.0.5');
    await typeWithin(view, card, L('SCALE_PORT'), '5000');
    await tick(view, card, L('SCALE_SEND_PRICE'), true);
    await typeWithin(view, card, L('BARCODE_RULE'), '2PPPPPVVVVVC');
    await savePut(view, 'devices', {
      items: [
        {
          ...stored(DEVICE_1),
          name: 'Cassa principale',
          driver: 'ESCPOS',
          host: '10.0.0.1',
          serialNumber: 'SN9',
          epsonProtocol17: true,
          epsonEreceipt: true,
          DLN502017Rounding: true,
          secondaryDriver: 'ESCPOS',
          secondaryHost: '10.0.0.2',
          automaticCashDriver: 'CASHDRO-7',
          automaticCashHost: '10.0.0.3',
          posProtocol17ip: '10.0.0.4',
          posProtocol17port: '9100',
          posProtocol17terminalId: 'T17',
          posDojoTerminalId: 'DOJO',
          externalDisplayId: '',
          favoritesId: 'fav0001',
          printStations: [STATION_ID],
          orderingPrintSingleProduct: true,
          orderingPrintSingleProductTables: true,
          scaleDialog0204Ip: '10.0.0.5',
          scaleDialog0204Port: '5000',
          scaleDialog0204SendPrice: true,
          barcodePriceRule: '2PPPPPVVVVVC',
        },
        stored(DEVICE_2),
      ],
    });
    expect(view.toasts()).toEqual(['PLACES.SAVED']);
  });

  it('sends a credential only when typed, null when removed, nothing when cancelled', async () => {
    const view = await renderPlace({ path: 'devices' });
    const card = await open(view, 0);
    const [username, password] = [...card.querySelectorAll<HTMLElement>('fc-credential-field')];
    await clickIn(view, username, 'PLACES.CREDENTIAL.REMOVE');
    await clickIn(view, password, 'PLACES.CREDENTIAL.SET_NEW');
    const field = password.querySelector('input') as HTMLInputElement;
    expect(field.value).toBe('');
    expect(field.type).toBe('password');
    field.value = 'pw-nuova';
    field.dispatchEvent(new Event('input'));
    await view.view();
    await savePut(view, 'devices', {
      items: [
        { ...stored(DEVICE_1), automaticCashUsername: null, automaticCashPassword: 'pw-nuova' },
        stored(DEVICE_2),
      ],
    });
  });

  it('sends the new username when it is changed', async () => {
    const view = await renderPlace({ path: 'devices' });
    const card = await open(view, 0);
    const [username] = [...card.querySelectorAll<HTMLElement>('fc-credential-field')];
    await clickIn(view, username, 'PLACES.CREDENTIAL.CHANGE');
    const field = username.querySelector('input') as HTMLInputElement;
    field.value = 'operatore';
    field.dispatchEvent(new Event('input'));
    await view.view();
    await savePut(view, 'devices', {
      items: [{ ...stored(DEVICE_1), automaticCashUsername: 'operatore' }, stored(DEVICE_2)],
    });
  });

  it('adds a device without id, open, and requires a name', async () => {
    const view = await renderPlace({ path: 'devices' });
    await view.click(L('ADD'));
    const card = cards(view)[2];
    expect(card.querySelector('strong')?.textContent).toBe(L('UNNAMED'));
    expect(box(card, T('DESK')).checked).toBe(true);
    expect(card.querySelector<HTMLButtonElement>('button[aria-expanded=true]')?.disabled).toBe(
      true,
    );
    await view.click('COMMON.SAVE');
    expect(view.text()).toContain('FORM.ISSUE.REQUIRED');
    await typeWithin(view, card, L('NAME'), 'Nuovo');
    const sent = (await savePut(view, 'devices', {
      items: [stored(DEVICE_1), stored(DEVICE_2), NEW_DEVICE],
    })) as { items: object[] };
    expect(sent.items[2]).not.toHaveProperty('id');
  });

  it('copies a device without id, server flag and credentials', async () => {
    const view = await renderPlace({ path: 'devices' });
    await clickIn(view, cards(view)[0], 'PLACES.DEVICES.COPY');
    const card = cards(view)[2];
    expect(box(card, L('NAME')).value).toBe('PLACES.DEVICES.COPY_NAME {"name":"Cassa 1"}');
    expect(box(card, L('SERVER')).checked).toBe(false);
    expect(
      [...card.querySelectorAll('.credential-state')].map((s) => s.textContent?.trim()),
    ).toEqual(['PLACES.CREDENTIAL.NOT_SET', 'PLACES.CREDENTIAL.NOT_SET']);
    const { id, ...copy } = stored(DEVICE_1);
    void id;
    await savePut(view, 'devices', {
      items: [
        stored(DEVICE_1),
        stored(DEVICE_2),
        { ...copy, server: false, name: 'PLACES.DEVICES.COPY_NAME {"name":"Cassa 1"}' },
      ],
    });
  });

  it('keeps one server: ticking it on a device clears the others', async () => {
    const view = await renderPlace({ path: 'devices' });
    await view.click(L('ADD'));
    await typeWithin(view, cards(view)[2], L('NAME'), 'Nuovo');
    await tick(view, cards(view)[2], L('SERVER'), true);
    expect(view.root.querySelectorAll('article fc-status-badge')).toHaveLength(1);
    expect(cards(view)[0].querySelector('fc-status-badge')).toBeNull();
    await tick(view, cards(view)[2], L('SERVER'), false);
    expect(view.root.querySelectorAll('article fc-status-badge')).toHaveLength(0);
    await tick(view, cards(view)[2], L('SERVER'), true);
    await savePut(view, 'devices', {
      items: [
        { ...stored(DEVICE_1), server: false },
        stored(DEVICE_2),
        { ...NEW_DEVICE, server: true },
      ],
    });
  });

  it('removes a device and the links the others and the rooms had to it', async () => {
    const view = await renderPlace({ path: 'devices' });
    await clickIn(view, cards(view)[1], 'PLACES.DEVICES.DELETE');
    expect(cards(view)).toHaveLength(1);
    await view.click('COMMON.SAVE');
    const request = backend().expectOne(PLACE_URL);
    const body = request.request.body as Record<string, { items: Record<string, unknown>[] }>;
    expect(Object.keys(body).sort()).toEqual(['devices']);
    expect(body['devices'].items).toEqual([{ ...stored(DEVICE_1), externalDisplayId: '' }]);
    request.flush({ data: fakePlace() }, { headers: { ETag: '"v2"' } });
    await view.view();
  });

  it('removing the device a room uses clears the room link', async () => {
    const view = await renderPlace({ path: 'devices' });
    await clickIn(view, cards(view)[0], 'PLACES.DEVICES.DELETE');
    await view.click('COMMON.SAVE');
    const request = backend().expectOne(PLACE_URL);
    const body = request.request.body as Record<string, { items: Record<string, unknown>[] }>;
    expect(body['rooms'].items[0]['deviceId']).toBe('');
    expect(ROOM.deviceId).toBe(DEVICE_ID_1);
    request.flush({ data: fakePlace() }, { headers: { ETag: '"v2"' } });
    await view.view();
  });

  it('removing a device not saved yet leaves the links alone', async () => {
    const view = await renderPlace({ path: 'devices' });
    await view.click(L('ADD'));
    await clickIn(view, cards(view)[2], 'PLACES.DEVICES.DELETE');
    expect(cards(view)).toHaveLength(2);
    expect(cards(view)[0].textContent).toContain('Cassa 1');
  });

  it('keeps the open device open when another is removed before or after it', async () => {
    const view = await renderPlace({ path: 'devices' });
    await open(view, 1);
    await clickIn(view, cards(view)[0], 'PLACES.DEVICES.DELETE');
    expect(cards(view)[0].querySelector('input')).not.toBeNull();
    await view.click(L('ADD'));
    await open(view, 0);
    await clickIn(view, cards(view)[1], 'PLACES.DEVICES.DELETE');
    expect(cards(view)[0].querySelector('input')).not.toBeNull();
    await clickIn(view, cards(view)[0], 'PLACES.DEVICES.DELETE');
    expect(cards(view)).toHaveLength(0);
    expect(view.text()).toContain(L('EMPTY'));
  });

  it.each([
    ['advanced', [DEVICE_1], 9],
    ['basic', [DEVICE_1], 5],
    ['start', [DEVICE_1], 1],
    ['start', [{ ...DEVICE_1, type: 'handheld' }], 2],
    ['start', [{ ...DEVICE_1, type: 'legacy-type' }], 2],
  ])('offers the types by plan %s and keeps the stored one', async (plan, items, count) => {
    const view = await renderPlace({ path: 'devices', place: withDevices(items, plan) });
    const card = await open(view, 0);
    const labels = [...card.querySelectorAll('.radio label')].map((l) => l.textContent?.trim());
    expect(labels).toHaveLength(count);
    expect(labels[0]).toBe(T('DESK'));
    if (plan === 'basic') {
      expect(labels).toEqual([
        T('DESK'),
        T('WAITING_LIST'),
        T('EXTERNAL_DISPLAY'),
        T('KIOSK'),
        T('TGM'),
      ]);
    }
    if (items[0].type === 'legacy-type') {
      expect(labels[1]).toBe('legacy-type');
    }
  });

  it.each([
    ['a store administrator without the module', [], CA, false],
    ['a store administrator with the module', ['tobaccosGamesMonopoly'], CA, true],
    ['a dealer', [], { role: 'D' as const }, true],
    ['a platform administrator', [], {}, true],
  ])('offers the tobacco printer to %s: %s', async (_who, features, profile, shown) => {
    const view = await renderPlace({ path: 'devices', features, profile });
    const card = await open(view, 0);
    const visible = [...card.querySelectorAll('.radio label')].some(
      (l) => l.textContent?.trim() === T('TGM'),
    );
    expect(visible).toBe(shown);
    expect(card.textContent?.includes(L('COMPANY_PRINTER'))).toBe(shown);
  });

  it('changes the type and shows only the blocks that make sense for it', async () => {
    const view = await renderPlace({ path: 'devices' });
    const card = await open(view, 0);
    const has = (text: string) => card.textContent?.includes(text);
    expect(
      [L('FISCAL'), L('SECONDARY'), L('CASH'), L('POS17'), L('DOJO'), L('DISPLAY')].every(has),
    ).toBe(true);
    expect([L('FAVORITES'), L('ORDERING'), L('SCALE'), L('BARCODE')].every(has)).toBe(true);
    const radio = box(card, T('HANDHELD'));
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    await view.view();
    expect(has(L('FISCAL'))).toBe(false);
    expect(has(L('SECONDARY'))).toBe(false);
    expect(has(L('POS17'))).toBe(false);
    expect(has(L('DISPLAY'))).toBe(false);
    expect(has(L('SCALE'))).toBe(false);
    expect(has(L('ORDERING'))).toBe(true);
    expect(has(L('FAVORITES'))).toBe(true);
    await savePut(view, 'devices', {
      items: [{ ...stored(DEVICE_1), type: 'handheld' }, stored(DEVICE_2)],
    });
  });

  it('offers only saved devices of the right type to link, and keeps a link it does not know', async () => {
    const view = await renderPlace({
      path: 'devices',
      place: withDevices([
        { ...DEVICE_1, externalDisplayId: 'gone0001' },
        DEVICE_2,
        { ...DEVICE_2, id: 'dev0003', name: '' },
      ]),
    });
    await view.click(L('ADD'));
    const added = cards(view)[3];
    await typeWithin(view, added, L('NAME'), 'Display 2');
    const radio = box(added, T('EXTERNAL_DISPLAY'));
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    await view.view();
    const card = await open(view, 0);
    expect([...box(card, L('DISPLAY')).querySelectorAll('option')].map((o) => o.value)).toEqual([
      '',
      DEVICE_ID_2,
      'dev0003',
      'gone0001',
    ]);
    expect(box(card, L('DISPLAY')).value).toBe('gone0001');
    expect(
      [...box(card, L('COMPANY_PRINTER')).querySelectorAll('option')].map((o) => o.value),
    ).toEqual(['']);
  });

  it('keeps a favorites group the lookup does not return, and a driver it does not know', async () => {
    const view = await renderPlace({
      path: 'devices',
      place: withDevices([{ ...DEVICE_1, favoritesId: 'oldfav', driver: 'OLD' }]),
    });
    const card = await open(view, 0);
    expect(box(card, L('FAVORITES')).value).toBe('oldfav');
    expect(box(card, L('FISCAL_DRIVER')).value).toBe('OLD');
  });

  it('says so when there are no saved print stations', async () => {
    const view = await renderPlace({
      path: 'devices',
      place: fakePlace({
        devices: { items: [DEVICE_1], editable: true },
        printStations: {
          stations: [],
          productionCenters: [],
          stationsEditable: true,
          productionCentersEditable: true,
        },
      }),
    });
    const card = await open(view, 0);
    expect(card.textContent).toContain(L('NO_STATIONS'));
  });

  it('opens the device with an error and shows the 422 of its fields and of the list', async () => {
    const view = await renderPlace({ path: 'devices' });
    const card = await open(view, 0);
    await typeWithin(view, card, L('NAME'), 'Altra');
    await clickIn(view, card, 'PLACES.DEVICES.CLOSE');
    await failSave(view, [
      { field: 'devices.items', issue: 'incorrect' },
      { field: 'devices.items.0.host', issue: 'incorrect' },
      { field: 'devices.items.0.type', issue: 'notAllowed' },
      { field: 'devices.items.0.printStations', issue: 'incorrect' },
      { field: 'devices.items.0.automaticCashUsername', issue: 'format' },
    ]);
    const reopened = cards(view)[0];
    expect(reopened.querySelector('input')).not.toBeNull();
    expect(box(reopened, L('HOST')).getAttribute('aria-invalid')).toBe('true');
    expect(view.root.querySelector('fieldset > [role=alert]')?.textContent).toContain(
      'FORM.ISSUE.INCORRECT',
    );
    expect(reopened.querySelectorAll('[role=alert]').length).toBe(2);
    expect(reopened.querySelector<HTMLButtonElement>('button[aria-expanded=true]')?.disabled).toBe(
      true,
    );
  });

  it('shows the refusal to remove a busy device on the list', async () => {
    const view = await renderPlace({ path: 'devices' });
    await clickIn(view, cards(view)[1], 'PLACES.DEVICES.DELETE');
    await view.click('COMMON.SAVE');
    backend()
      .expectOne(PLACE_URL)
      .flush(errorBody('CONFLICT', [{ field: 'devices.items', issue: 'busy' }]), {
        status: 409,
        statusText: 'x',
      });
    await view.view();
    expect(view.root.querySelector('fieldset > [role=alert]')?.textContent).toMatch(/FORM\.ISSUE/);
  });

  it('shows the devices read-only with a note when the stored list cannot be changed', async () => {
    const view = await renderPlace({
      path: 'devices',
      place: withDevices([DEVICE_1], 'advanced', false),
    });
    expect(view.text()).toContain(L('NOT_EDITABLE'));
    expect(view.button(L('ADD'))).toBeUndefined();
    expect(view.button('PLACES.DEVICES.COPY')).toBeUndefined();
    expect(view.button('PLACES.DEVICES.DELETE')).toBeUndefined();
    expect(view.button('PLACES.DEVICES.EDIT')).toBeUndefined();
    const card = cards(view)[0];
    await clickIn(view, card, 'PLACES.DEVICES.SHOW');
    expect(box(card, L('NAME')).disabled).toBe(true);
    expect(box(card, L('SERVER')).disabled).toBe(true);
    expect(box(card, T('DESK')).disabled).toBe(true);
    expect(box(card, 'Cucina').disabled).toBe(true);
    expect(card.querySelector('.credential button')).toBeNull();
    await clickIn(view, card, 'PLACES.DEVICES.HIDE');
    expect(cards(view)[0].querySelector('input')).toBeNull();
  });

  it('is read-only without the permission to update', async () => {
    const view = await renderPlace({ path: 'devices', permissions: READ_ONLY });
    expect(view.button(L('ADD'))).toBeUndefined();
    expect(view.button('COMMON.SAVE')).toBeUndefined();
    const card = cards(view)[0];
    await clickIn(view, card, 'PLACES.DEVICES.SHOW');
    expect(box(card, L('NAME')).disabled).toBe(true);
  });

  it('marks the fields as touched when the focus leaves them', async () => {
    const view = await renderPlace({ path: 'devices' });
    await open(view, 0);
    await view.click(L('ADD'));
    await view.blurAll();
    expect(view.text()).toContain('FORM.ISSUE.REQUIRED');
  });

  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'devices' });
    await submitTab(view);
    await view.blurAll();
  });

  describe('MultiSafepay', () => {
    const idLabel = (n: number) => L('MULTISAFEPAY_TERMINAL_ID') + ` {"number":${n}}`;
    const nameLabel = (n: number) => L('MULTISAFEPAY_TERMINAL_NAME') + ` {"number":${n}}`;
    const withTerminals = (terminals: { terminalId: string; name: string }[]) =>
      withDevices([{ ...DEVICE_1, multisafepayTerminals: terminals }, DEVICE_2]);

    it('is in the form of every device type', async () => {
      const view = await renderPlace({ path: 'devices' });
      const desk = await open(view, 0);
      expect(desk.textContent).toContain(L('MULTISAFEPAY'));
      expect(box(desk, L('MULTISAFEPAY_APP')).checked).toBe(false);
      expect(box(desk, L('MULTISAFEPAY_QR')).checked).toBe(false);
      const display = await open(view, 1);
      expect(display.textContent).toContain(L('MULTISAFEPAY'));
    });

    it('sends the switches and the terminals trimmed, replacing the whole list', async () => {
      const view = await renderPlace({ path: 'devices' });
      const card = await open(view, 0);
      await tick(view, card, L('MULTISAFEPAY_APP'), true);
      await tick(view, card, L('MULTISAFEPAY_QR'), true);
      await clickIn(view, card, L('MULTISAFEPAY_ADD_TERMINAL'));
      await typeWithin(view, card, idLabel(1), 'T-1');
      await typeWithin(view, card, nameLabel(1), ' Sala ');
      await clickIn(view, card, L('MULTISAFEPAY_ADD_TERMINAL'));
      await typeWithin(view, card, idLabel(2), 'T_2');
      await typeWithin(view, card, nameLabel(2), 'Bar');
      await savePut(view, 'devices', {
        items: [
          {
            ...stored(DEVICE_1),
            multisafepayAppStatus: true,
            multisafepayQrStatus: true,
            multisafepayTerminals: [
              { terminalId: 'T-1', name: 'Sala' },
              { terminalId: 'T_2', name: 'Bar' },
            ],
          },
          stored(DEVICE_2),
        ],
      });
    });

    it('shows the stored terminals and removes one', async () => {
      const view = await renderPlace({
        path: 'devices',
        place: withTerminals([
          { terminalId: 'A', name: 'Uno' },
          { terminalId: 'B', name: 'Due' },
        ]),
      });
      const card = await open(view, 0);
      expect(box(card, idLabel(2)).value).toBe('B');
      expect(box(card, nameLabel(1)).value).toBe('Uno');
      (
        [...card.querySelectorAll('button')].find((b) =>
          b.getAttribute('aria-label')?.startsWith(L('MULTISAFEPAY_REMOVE_TERMINAL')),
        ) as HTMLButtonElement
      ).click();
      await view.view();
      expect(box(cards(view)[0], idLabel(1)).value).toBe('B');
    });

    it('checks the id, the name and the duplicates, and stops at 20 terminals', async () => {
      const view = await renderPlace({
        path: 'devices',
        place: withTerminals([
          { terminalId: 'A', name: 'Uno' },
          { terminalId: 'A', name: 'Due' },
        ]),
      });
      const card = cards(view)[0];
      box(card, idLabel(2)).dispatchEvent(new Event('blur'));
      await view.view();
      expect(card.textContent).toContain('FORM.ISSUE.INCORRECT');
      await typeWithin(view, card, idLabel(2), 'no spaces!');
      box(card, idLabel(2)).dispatchEvent(new Event('blur'));
      await view.view();
      expect(card.textContent).toContain('FORM.ISSUE.PATTERN');
      await typeWithin(view, card, nameLabel(2), '');
      box(card, nameLabel(2)).dispatchEvent(new Event('blur'));
      await view.view();
      expect(card.textContent).toContain('FORM.ISSUE.REQUIRED');
      await typeWithin(view, card, nameLabel(2), 'x'.repeat(101));
      box(card, nameLabel(2)).dispatchEvent(new Event('blur'));
      await view.view();
      expect(card.textContent).toContain('FORM.ISSUE.MAX_LENGTH');
    });

    it('disables adding at 20 terminals', async () => {
      const many = Array.from({ length: 20 }, (_, index) => ({
        terminalId: `T${index}`,
        name: `N${index}`,
      }));
      const view = await renderPlace({ path: 'devices', place: withTerminals(many) });
      const card = await open(view, 0);
      const add = [...card.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === L('MULTISAFEPAY_ADD_TERMINAL'),
      ) as HTMLButtonElement;
      expect(add.disabled).toBe(true);
    });

    it('puts the 422 of a terminal on its field', async () => {
      const view = await renderPlace({
        path: 'devices',
        place: withTerminals([{ terminalId: 'A', name: 'Uno' }]),
      });
      const card = await open(view, 0);
      await typeWithin(view, card, nameLabel(1), 'Nuovo');
      await failSave(view, [
        { field: 'devices.items.0.multisafepayTerminals.0.terminalId', issue: 'incorrect' },
        { field: 'devices.items.0.multisafepayTerminals', issue: 'tooMany' },
      ]);
      expect(cards(view)[0].textContent).toContain('FORM.ISSUE.INCORRECT');
      expect(cards(view)[0].textContent).toContain('FORM.ISSUE.TOO_MANY');
    });

    it('does not offer to change the terminals of a device that cannot be edited', async () => {
      const view = await renderPlace({
        path: 'devices',
        place: withDevices(
          [{ ...DEVICE_1, multisafepayTerminals: [{ terminalId: 'A', name: 'Uno' }] }, DEVICE_2],
          'advanced',
          false,
        ),
      });
      await clickIn(view, cards(view)[0], 'PLACES.DEVICES.SHOW');
      const card = cards(view)[0];
      expect(
        [...card.querySelectorAll('button')].some(
          (b) => b.textContent?.trim() === L('MULTISAFEPAY_ADD_TERMINAL'),
        ),
      ).toBe(false);
      expect(box(card, idLabel(1)).disabled).toBe(true);
    });

    it('copies the terminals with the device', async () => {
      const view = await renderPlace({
        path: 'devices',
        place: withTerminals([{ terminalId: 'A', name: 'Uno' }]),
      });
      await clickIn(view, cards(view)[0], 'PLACES.DEVICES.COPY');
      const copy = cards(view)[2];
      expect(box(copy, idLabel(1)).value).toBe('A');
    });
  });
});
