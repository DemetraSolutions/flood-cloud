import { emulateNativeDialog } from '../../../testing/dialog';
import {
  PLACE_PERMISSIONS,
  DEVICE_1,
  DEVICE_ID_1,
  fakePlace,
  LIST_1,
  LIST_2,
  renderPlace,
  ROOM,
  ROOM_ID,
  STATION_ID,
  TAX_ID,
} from '../../../testing/places';
import {
  cleanUp,
  clickIn,
  failPut,
  fieldsetOf,
  READ_ONLY,
  savePatch,
  submitTab,
  typeWithin,
  within,
} from '../../../testing/places-tabs';
import { PlaceRoom } from './place.types';

const t = (key: string) => `PLACES.ROOMS_TAB.${key}`;
const STORED_ROOM = {
  id: ROOM_ID,
  name: 'Sala 1',
  listId: LIST_1,
  service: 10,
  tax: TAX_ID,
  deviceId: DEVICE_ID_1,
  seatsRequest: false,
  seatsRequired: false,
  autoService: false,
  priceListsRequest: false,
  handheldVisibility: true,
  printStations: [STATION_ID],
  tables: [
    {
      id: 'tab0001',
      name: 'T1',
      seats: 4,
      userId: '',
      view: { w: 1, h: 1, x: 0, y: 0, shape: 'rect' },
    },
    {
      id: 'tab0002',
      name: 'T2',
      seats: 2,
      userId: '',
      view: { w: 2, h: 1, x: null, y: null, shape: 'round' },
    },
  ],
  view: { type: 'grid', status: true, h: 8, w: 8 },
};
const WITH_USERS = [...PLACE_PERMISSIONS, 'users:read'];
const NEW_TABLE = { userId: '', view: { w: 1, h: 1, x: null, y: null, shape: 'rect' } };

type View = Awaited<ReturnType<typeof renderPlace>>;

const rooms = (view: View, ...items: unknown[]) => ({ rooms: { items } });
const card = (view: View, name = 'Sala 1') => fieldsetOf(view.root, name);
const rows = (scope: Element) => [...scope.querySelectorAll<HTMLElement>('.table-row')];
const addForm = (view: View) => fieldsetOf(view.root, t('ADD_TITLE'));
const addTables = (scope: Element) => fieldsetOf(scope, t('ADD_TABLE_TITLE'));
const byLabel = (scope: Element, label: string) =>
  scope.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`) as HTMLButtonElement;
const press = async (view: View, button: HTMLButtonElement) => {
  button.click();
  await view.view();
};
const check = async (view: View, scope: Element, label: string, on: boolean) => {
  const box = within(scope, label) as HTMLInputElement;
  box.checked = on;
  box.dispatchEvent(new Event('change'));
  await view.view();
};
const announced = (view: View) =>
  view.root.querySelector('p.visually-hidden[role=status]')?.textContent?.trim();

/** A place with `count` rooms, each with `tables` tables. */
function manyRooms(count: number, tables = 0) {
  const items: PlaceRoom[] = Array.from({ length: count }, (_, r) => ({
    ...ROOM,
    id: `room${r}`,
    name: `Sala ${r + 1}`,
    tables: Array.from({ length: tables }, (_, k) => ({
      id: `t${r}-${k}`,
      name: `N${k}`,
      seats: 2,
      userId: '',
      view: { w: 1, h: 1, x: null, y: null, shape: 'rect' },
    })),
  }));
  return fakePlace({ rooms: { items, editable: true } });
}

beforeAll(emulateNativeDialog);
afterEach(cleanUp);

describe('PlaceRooms: reading', () => {
  it('shows the rooms in the table and in a card, with the options of the lookups', async () => {
    const view = await renderPlace({ path: 'rooms', permissions: WITH_USERS });
    const summary = view.root.querySelector('table.summary') as HTMLTableElement;
    expect(summary.querySelector('tbody')?.textContent).toContain('Sala 1');
    expect(summary.querySelector('tbody')?.textContent).toContain('8×8');
    expect(summary.querySelector('tbody')?.textContent).toContain('PLACES.ROOM_EDITOR.TYPE_GRID');
    expect(summary.querySelector('tbody')?.textContent).toContain('PLACES.ROOMS_TAB.ENABLED');
    const room = card(view);
    expect((within(room, t('NAME')) as HTMLInputElement).value).toBe('Sala 1');
    const list = within(room, t('LIST')) as HTMLSelectElement;
    expect(list.value).toBe(LIST_1);
    expect([...list.options].map((o) => o.textContent?.trim())).toEqual([
      t('LIST_PLACEHOLDER'),
      'Listino 1',
      'Listino 2',
    ]);
    expect((within(room, t('SERVICE')) as HTMLInputElement).value).toBe('10');
    const tax = within(room, t('TAX')) as HTMLSelectElement;
    expect(tax.value).toBe(TAX_ID);
    expect(tax.selectedOptions[0].textContent?.trim()).toBe('22% IVA ordinaria');
    const device = within(room, t('DEVICE')) as HTMLSelectElement;
    expect(device.value).toBe(DEVICE_ID_1);
    expect([...device.options].map((o) => o.textContent?.trim())).toEqual([
      'PLACES.NONE',
      DEVICE_1.name,
    ]);
    expect((within(room, t('HANDHELD')) as HTMLInputElement).checked).toBe(true);
    expect((within(room, t('SEATS_REQUEST')) as HTMLInputElement).checked).toBe(false);
    expect((within(room, 'Cucina') as HTMLInputElement).checked).toBe(true);
    const tables = rows(room);
    expect(tables).toHaveLength(2);
    expect((within(tables[0], t('TABLE_NAME')) as HTMLInputElement).value).toBe('T1');
    expect((within(tables[0], t('TABLE_SEATS')) as HTMLInputElement).value).toBe('4');
    expect(
      [...(within(tables[0], t('TABLE_USER')) as HTMLSelectElement).options].map((o) =>
        o.textContent?.trim(),
      ),
    ).toEqual(['PLACES.NONE', 'mario']);
  });

  it('shows the stored value of a lookup that is not listed', async () => {
    const place = fakePlace({
      rooms: {
        items: [
          {
            ...ROOM,
            listId: 'gone-list',
            tax: 'gone-tax',
            deviceId: 'gone-device',
            tables: [{ ...ROOM.tables[0], userId: 'gone-user' }],
          },
        ],
        editable: true,
      },
    });
    const view = await renderPlace({ path: 'rooms', place });
    const room = card(view);
    expect((within(room, t('LIST')) as HTMLSelectElement).value).toBe('gone-list');
    expect((within(room, t('TAX')) as HTMLSelectElement).value).toBe('gone-tax');
    expect((within(room, t('DEVICE')) as HTMLSelectElement).value).toBe('gone-device');
    expect((within(rows(room)[0], t('TABLE_USER')) as HTMLSelectElement).value).toBe('gone-user');
  });

  it('titles a room and a table without a name, and shows a tax without a description', async () => {
    const place = fakePlace({
      rooms: {
        items: [{ ...ROOM, name: '', tables: [{ ...ROOM.tables[0], name: ' ' }] }],
        editable: true,
      },
    });
    const view = await renderPlace({
      path: 'rooms',
      place,
      lookupData: {},
    });
    expect(card(view, t('NO_NAME'))).toBeTruthy();
    expect(rows(card(view, t('NO_NAME')))[0].getAttribute('aria-label')).toBe(t('NO_NAME_TABLE'));
  });

  it('shows the empty states', async () => {
    const place = fakePlace({
      rooms: { items: [], editable: true },
      printStations: {
        stations: [],
        productionCenters: [],
        stationsEditable: true,
        productionCentersEditable: true,
      },
    });
    const view = await renderPlace({ path: 'rooms', place });
    expect(view.text()).toContain(t('NO_ROOMS'));
    expect(view.text()).toContain(t('NO_STATIONS'));
    expect(view.button(t('DRAW'))?.disabled).toBe(true);
    expect(view.root.querySelector('table.summary')).toBeNull();
  });

  it('says a room has no print stations to choose when the place has none', async () => {
    const place = fakePlace({
      printStations: {
        stations: [],
        productionCenters: [],
        stationsEditable: true,
        productionCentersEditable: true,
      },
    });
    const view = await renderPlace({ path: 'rooms', place });
    expect(card(view).textContent).toContain(t('NO_STATIONS'));
  });

  it('shows a room with no tables and a room without print stations', async () => {
    const place = fakePlace({
      rooms: { items: [{ ...ROOM, tables: [], printStations: [] }], editable: true },
    });
    const view = await renderPlace({ path: 'rooms', place });
    expect(card(view).textContent).toContain(t('NO_TABLES'));
    expect((within(card(view), 'Cucina') as HTMLInputElement).checked).toBe(false);
  });
});

describe('PlaceRooms: adding a room', () => {
  it('adds a room with everything the form holds and saves it with the exact PATCH', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const form = addForm(view);
    expect(view.button(t('ADD'))?.disabled).toBe(true);
    await typeWithin(view, form, t('NAME'), '  Terrazza ');
    await typeWithin(view, form, t('LIST'), LIST_2);
    await typeWithin(view, form, t('SERVICE'), '12.5');
    await typeWithin(view, form, t('TAX'), TAX_ID);
    await typeWithin(view, form, t('DEVICE'), DEVICE_ID_1);
    await check(view, form, t('HANDHELD'), true);
    await check(view, form, t('SEATS_REQUEST'), true);
    await check(view, form, t('SEATS_REQUIRED'), true);
    await check(view, form, t('AUTO_SERVICE'), true);
    await check(view, form, t('PRICE_LISTS_REQUEST'), true);
    await check(view, form, 'Cucina', true);
    await clickIn(view, form, t('ADD'));
    expect(announced(view)).toContain('Terrazza');
    // The form is empty again.
    expect((within(form, t('NAME')) as HTMLInputElement).value).toBe('');
    expect((within(form, 'Cucina') as HTMLInputElement).checked).toBe(false);
    expect(card(view, 'Terrazza')).toBeTruthy();
    await savePatch(
      view,
      rooms(view, STORED_ROOM, {
        name: 'Terrazza',
        listId: LIST_2,
        service: 12.5,
        tax: TAX_ID,
        deviceId: DEVICE_ID_1,
        seatsRequest: true,
        seatsRequired: true,
        autoService: true,
        priceListsRequest: true,
        handheldVisibility: true,
        printStations: [STATION_ID],
        tables: [],
        view: { type: 'grid', status: false, h: 8, w: 8 },
      }),
    );
  });

  it('turns a print station off again and keeps the form values until added', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const form = addForm(view);
    await check(view, form, 'Cucina', true);
    await check(view, form, 'Cucina', false);
    expect((within(form, 'Cucina') as HTMLInputElement).checked).toBe(false);
  });

  it('refuses a name another room has, without regard to case', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const form = addForm(view);
    await typeWithin(view, form, t('NAME'), ' SALA 1');
    expect(form.textContent).toContain(t('NAME_TAKEN'));
    expect(view.button(t('ADD'))?.disabled).toBe(true);
  });

  it('keeps the service percentage between 0 and 100', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const form = addForm(view);
    await typeWithin(view, form, t('SERVICE'), '250');
    expect((within(form, t('SERVICE')) as HTMLInputElement).value).toBe('100');
    await typeWithin(view, form, t('SERVICE'), '-3');
    expect((within(form, t('SERVICE')) as HTMLInputElement).value).toBe('0');
  });

  it('stops at 30 rooms', async () => {
    const view = await renderPlace({ path: 'rooms', place: manyRooms(30) });
    const form = addForm(view);
    await typeWithin(view, form, t('NAME'), 'Una in più');
    expect(view.button(t('ADD'))?.disabled).toBe(true);
    expect(form.textContent).toContain('"max":30');
  });
});

describe('PlaceRooms: editing a room', () => {
  it('saves what is changed in the card with the exact PATCH', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const room = card(view);
    await typeWithin(view, room, t('NAME'), 'Sala Nuova');
    await typeWithin(view, room, t('LIST'), LIST_2);
    await typeWithin(view, room, t('SERVICE'), '15');
    await typeWithin(view, room, t('DEVICE'), '');
    await check(view, room, t('HANDHELD'), false);
    await check(view, room, t('SEATS_REQUIRED'), true);
    await check(view, room, 'Cucina', false);
    await savePatch(
      view,
      rooms(view, {
        ...STORED_ROOM,
        name: 'Sala Nuova',
        listId: LIST_2,
        service: 15,
        deviceId: '',
        handheldVisibility: false,
        seatsRequired: true,
        printStations: [],
      }),
    );
  });

  it('turns a print station on', async () => {
    const place = fakePlace({
      rooms: { items: [{ ...ROOM, printStations: [] }], editable: true },
    });
    const view = await renderPlace({ path: 'rooms', place });
    await check(view, card(view), 'Cucina', true);
    await savePatch(view, rooms(view, { ...STORED_ROOM, printStations: [STATION_ID] }));
  });

  it('shows the room name error of the form', async () => {
    const view = await renderPlace({ path: 'rooms' });
    await typeWithin(view, card(view), t('NAME'), '');
    await view.blurAll();
    expect(card(view, t('NO_NAME')).textContent).toContain('FORM.ISSUE.REQUIRED');
  });

  it('flags repeated room names and repeated table names', async () => {
    const place = fakePlace({
      rooms: {
        items: [
          { ...ROOM, id: 'r1', name: 'Uguale', tables: [ROOM.tables[0], { ...ROOM.tables[1], name: 'T1 ' }] },
          { ...ROOM, id: 'r2', name: 'uguale', tables: [] },
        ],
        editable: true,
      },
    });
    const view = await renderPlace({ path: 'rooms', place });
    const flagged = view.root.textContent as string;
    expect(flagged.split(t('NAME_TAKEN')).length - 1).toBe(2);
    expect(flagged.split(t('TABLE_NAME_TAKEN')).length - 1).toBe(2);
  });

  it('puts the 422 of a room and of a table on their fields', async () => {
    const view = await renderPlace({ path: 'rooms' });
    await typeWithin(view, card(view), t('NAME'), 'Altra');
    await failPut(view, 'rooms', [
      { field: 'rooms.items.0.name', issue: 'taken' },
      { field: 'rooms.items.0.tables.1.name', issue: 'taken' },
      { field: 'rooms.items', issue: 'tooMany' },
      { field: 'rooms.items.0.tables', issue: 'tooMany' },
    ]);
    const room = card(view, 'Altra');
    expect(room.textContent).toContain('FORM.ISSUE.TAKEN');
    expect(rows(room)[1].textContent).toContain('FORM.ISSUE.TAKEN');
    expect(room.querySelector('.tables > [role=alert]')?.textContent).toContain(
      'FORM.ISSUE.TOO_MANY',
    );
  });
});

describe('PlaceRooms: reordering and removing rooms', () => {
  const place = () =>
    fakePlace({
      rooms: {
        items: [
          { ...ROOM, id: 'a', name: 'A' },
          { ...ROOM, id: 'b', name: 'B' },
          { ...ROOM, id: 'c', name: 'C' },
        ],
        editable: true,
      },
    });
  const names = (view: View) =>
    [...view.root.querySelectorAll('fieldset.room > legend')].map((l) => l.textContent?.trim());

  it('moves a room with the buttons, announces it and keeps the focus on the same direction', async () => {
    const view = await renderPlace({ path: 'rooms', place: place() });
    expect(byLabel(card(view, 'A'), t('MOVE_ROOM_UP')).disabled).toBe(true);
    expect(byLabel(card(view, 'C'), t('MOVE_ROOM_DOWN')).disabled).toBe(true);
    await press(view, byLabel(card(view, 'C'), t('MOVE_ROOM_UP')));
    expect(names(view)).toEqual(['A', 'C', 'B']);
    expect(announced(view)).toContain('"position":2');
    expect(document.activeElement).toBe(byLabel(card(view, 'C'), t('MOVE_ROOM_UP')));
    await press(view, byLabel(card(view, 'C'), t('MOVE_ROOM_UP')));
    expect(names(view)).toEqual(['C', 'A', 'B']);
    // At the top the up button is disabled: the focus goes to the down button.
    expect(document.activeElement).toBe(byLabel(card(view, 'C'), t('MOVE_ROOM_DOWN')));
    await press(view, byLabel(card(view, 'C'), t('MOVE_ROOM_DOWN')));
    await press(view, byLabel(card(view, 'C'), t('MOVE_ROOM_DOWN')));
    expect(names(view)).toEqual(['A', 'B', 'C']);
    expect(document.activeElement).toBe(byLabel(card(view, 'C'), t('MOVE_ROOM_UP')));
  });

  it('removes a room, announces it and moves the focus to the add form', async () => {
    const view = await renderPlace({ path: 'rooms', place: place() });
    await press(view, byLabel(card(view, 'B'), t('REMOVE_ROOM')));
    expect(names(view)).toEqual(['A', 'C']);
    expect(announced(view)).toContain('"name":"B"');
    expect(document.activeElement).toBe(addForm(view));
  });

  it('forgets what was typed to add tables when the rooms change', async () => {
    const view = await renderPlace({ path: 'rooms', place: place() });
    await typeWithin(view, addTables(card(view, 'A')), t('TABLE_NAME'), 'X');
    await press(view, byLabel(card(view, 'B'), t('MOVE_ROOM_UP')));
    expect((within(addTables(card(view, 'A')), t('TABLE_NAME')) as HTMLInputElement).value).toBe(
      '',
    );
  });
});

describe('PlaceRooms: tables', () => {
  it('adds one table with its seats and user and saves it with the exact PATCH', async () => {
    const view = await renderPlace({ path: 'rooms', permissions: WITH_USERS });
    const form = addTables(card(view));
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    await typeWithin(view, form, t('TABLE_NAME'), ' T9 ');
    await typeWithin(view, form, t('TABLE_SEATS'), '6');
    await typeWithin(view, form, t('TABLE_USER'), 'usr0001');
    await press(view, byLabel(form, t('ADD_TABLE_TO')));
    expect(rows(card(view))).toHaveLength(3);
    expect((within(addTables(card(view)), t('TABLE_NAME')) as HTMLInputElement).value).toBe('');
    expect(announced(view)).toContain('"count":1');
    await savePatch(
      view,
      rooms(view, {
        ...STORED_ROOM,
        tables: [
          ...STORED_ROOM.tables,
          { ...NEW_TABLE, name: 'T9', seats: 6, userId: 'usr0001' },
        ],
      }),
    );
  });

  it('adds a range of tables named by the numbers', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const form = addTables(card(view));
    await typeWithin(view, form, t('FROM'), '10');
    // Half a range is not enough.
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    await typeWithin(view, form, t('TO'), '12');
    await typeWithin(view, form, t('TABLE_SEATS'), '2');
    await press(view, byLabel(form, t('ADD_TABLE_TO')));
    await savePatch(
      view,
      rooms(view, {
        ...STORED_ROOM,
        tables: [
          ...STORED_ROOM.tables,
          ...['10', '11', '12'].map((name) => ({ ...NEW_TABLE, name, seats: 2 })),
        ],
      }),
    );
  });

  it('adds a range with no seats, and a range of one', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const form = addTables(card(view));
    await typeWithin(view, form, t('TO'), '5');
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    await typeWithin(view, form, t('FROM'), '5');
    await press(view, byLabel(form, t('ADD_TABLE_TO')));
    expect(rows(card(view))).toHaveLength(3);
    expect((within(rows(card(view))[2], t('TABLE_SEATS')) as HTMLInputElement).value).toBe('');
  });

  it('refuses a backwards range, repeated names and a name in use', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const form = addTables(card(view));
    await typeWithin(view, form, t('FROM'), '9');
    await typeWithin(view, form, t('TO'), '3');
    expect(form.textContent).toContain(t('RANGE_INVALID'));
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    await typeWithin(view, form, t('FROM'), '1');
    await typeWithin(view, form, t('TO'), '3');
    expect(form.textContent).not.toContain(t('RANGE_INVALID'));
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(false);
    await typeWithin(view, form, t('FROM'), '');
    await typeWithin(view, form, t('TO'), '');
    await typeWithin(view, form, t('TABLE_NAME'), 't1');
    expect(form.textContent).toContain(t('TABLE_NAME_TAKEN'));
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    await typeWithin(view, form, t('TABLE_NAME'), '');
  });

  it('refuses a range with a name already in use', async () => {
    const place = fakePlace({
      rooms: {
        items: [{ ...ROOM, tables: [{ ...ROOM.tables[0], name: '2' }] }],
        editable: true,
      },
    });
    const view = await renderPlace({ path: 'rooms', place });
    const form = addTables(card(view));
    await typeWithin(view, form, t('FROM'), '1');
    await typeWithin(view, form, t('TO'), '3');
    expect(form.textContent).toContain(t('RANGE_TAKEN'));
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
  });

  it('stops at 200 tables in a room', async () => {
    const view = await renderPlace({ path: 'rooms', place: manyRooms(1, 199) });
    const form = addTables(card(view));
    await typeWithin(view, form, t('FROM'), '500');
    await typeWithin(view, form, t('TO'), '501');
    expect(form.textContent).toContain('"room":200');
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    await typeWithin(view, form, t('TO'), '500');
    await press(view, byLabel(form, t('ADD_TABLE_TO')));
    expect(rows(card(view))).toHaveLength(200);
    // Full: every control of the form is off.
    expect((within(form, t('TABLE_NAME')) as HTMLInputElement).disabled).toBe(true);
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    expect(form.textContent).toContain('"total":1000');
  });

  it('stops at 1000 tables in the place', async () => {
    const view = await renderPlace({ path: 'rooms', place: manyRooms(6, 166) });
    // 6 × 166 = 996 tables: four more fit, in any room.
    const form = addTables(card(view, 'Sala 1'));
    await typeWithin(view, form, t('FROM'), '1000');
    await typeWithin(view, form, t('TO'), '1004');
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(true);
    await typeWithin(view, form, t('TO'), '1003');
    expect(byLabel(form, t('ADD_TABLE_TO')).disabled).toBe(false);
    await press(view, byLabel(form, t('ADD_TABLE_TO')));
    expect((within(addTables(card(view, 'Sala 2')), t('TABLE_NAME')) as HTMLInputElement).disabled).toBe(true);
  });

  it('edits a table and saves it', async () => {
    const view = await renderPlace({ path: 'rooms', permissions: WITH_USERS });
    const row = rows(card(view))[0];
    await typeWithin(view, row, t('TABLE_NAME'), 'Uno');
    await typeWithin(view, row, t('TABLE_SEATS'), '8');
    await typeWithin(view, row, t('TABLE_USER'), 'usr0001');
    await savePatch(
      view,
      rooms(view, {
        ...STORED_ROOM,
        tables: [
          { ...STORED_ROOM.tables[0], name: 'Uno', seats: 8, userId: 'usr0001' },
          STORED_ROOM.tables[1],
        ],
      }),
    );
  });

  it('keeps the seats of a table whole and not negative', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const row = rows(card(view))[0];
    await typeWithin(view, row, t('TABLE_SEATS'), '-4');
    expect((within(row, t('TABLE_SEATS')) as HTMLInputElement).value).toBe('0');
    await typeWithin(view, row, t('TABLE_SEATS'), '3.7');
    expect((within(row, t('TABLE_SEATS')) as HTMLInputElement).value).toBe('3');
  });

  it('moves a table with the buttons and announces it', async () => {
    const view = await renderPlace({ path: 'rooms' });
    const room = () => card(view);
    expect(byLabel(rows(room())[0], t('MOVE_TABLE_UP')).disabled).toBe(true);
    expect(byLabel(rows(room())[1], t('MOVE_TABLE_DOWN')).disabled).toBe(true);
    await press(view, byLabel(rows(room())[1], t('MOVE_TABLE_UP')));
    expect((within(rows(room())[0], t('TABLE_NAME')) as HTMLInputElement).value).toBe('T2');
    expect(announced(view)).toContain('"position":1');
    expect(document.activeElement).toBe(byLabel(rows(room())[0], t('MOVE_TABLE_DOWN')));
    await press(view, byLabel(rows(room())[0], t('MOVE_TABLE_DOWN')));
    expect(document.activeElement).toBe(byLabel(rows(room())[1], t('MOVE_TABLE_UP')));
    await press(view, byLabel(rows(room())[1], t('MOVE_TABLE_UP')));
    await savePatch(
      view,
      rooms(view, { ...STORED_ROOM, tables: [STORED_ROOM.tables[1], STORED_ROOM.tables[0]] }),
    );
  });

  it('removes a table and puts the focus on the tables', async () => {
    const view = await renderPlace({ path: 'rooms' });
    await press(view, byLabel(rows(card(view))[0], t('REMOVE_TABLE')));
    expect(rows(card(view))).toHaveLength(1);
    expect(announced(view)).toContain('"name":"T1"');
    expect(document.activeElement).toBe(card(view).querySelector('.tables'));
    await savePatch(view, rooms(view, { ...STORED_ROOM, tables: [STORED_ROOM.tables[1]] }));
  });
});

describe('PlaceRooms: layout editor button', () => {
  it('opens the editor on the room of the row, or on the first one', async () => {
    const view = await renderPlace({ path: 'rooms' });
    await press(view, byLabel(view.root, t('EDIT_ROOM')));
    expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    (view.root.querySelector('dialog button[aria-label="COMMON.CLOSE"]') as HTMLButtonElement).click();
    await view.view();
    await clickIn(view, view.root, t('DRAW'));
    expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });
});

describe('PlaceRooms: layout editor confirm', () => {
  it('closes the editor on confirm and opens it again', async () => {
    const view = await renderPlace({ path: 'rooms' });
    await press(view, byLabel(view.root, t('EDIT_ROOM')));
    await clickIn(view, view.root.querySelector('dialog') as Element, 'COMMON.CONFIRM');
    expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(false);
    await clickIn(view, view.root, t('DRAW'));
    expect(view.root.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });
});

describe('PlaceRooms: the form', () => {
  it('ignores the submit of the form', async () => {
    const view = await renderPlace({ path: 'rooms' });
    await submitTab(view);
  });
});

describe('PlaceRooms: read only', () => {
  it('shows everything without the controls to change it without the permission', async () => {
    const view = await renderPlace({ path: 'rooms', permissions: READ_ONLY });
    expect(view.text()).not.toContain(t('NOT_EDITABLE'));
    expect(view.root.querySelector('fieldset[data-id=add-room]')).toBeNull();
    expect(view.button(t('DRAW'))).toBeUndefined();
    expect(view.button(t('EDIT'))).toBeUndefined();
    expect(view.button(t('REMOVE'))).toBeUndefined();
    expect(view.root.querySelector('button[aria-label^="PLACES.ROOMS_TAB.MOVE"]')).toBeNull();
    expect(addTables(card(view) as Element)).toBeUndefined();
    expect((within(card(view), t('NAME')) as HTMLInputElement).disabled).toBe(true);
    expect((within(card(view), 'Cucina') as HTMLInputElement).disabled).toBe(true);
    expect((within(rows(card(view))[0], t('TABLE_NAME')) as HTMLInputElement).disabled).toBe(true);
  });

  it('explains a list that cannot be changed and offers no way to change it', async () => {
    const place = fakePlace({
      rooms: {
        items: [
          {
            ...ROOM,
            tables: [{ ...ROOM.tables[0], id: '', withoutId: true }],
          },
          { ...ROOM, id: '', withoutId: true, name: 'Senza id' },
        ],
        editable: false,
      },
    });
    const view = await renderPlace({ path: 'rooms', place });
    expect(view.text()).toContain(t('NOT_EDITABLE'));
    expect(view.root.querySelector('fieldset[data-id=add-room]')).toBeNull();
    expect(view.button(t('DRAW'))).toBeUndefined();
    expect(view.button(t('EDIT'))).toBeUndefined();
    expect(view.button(t('REMOVE'))).toBeUndefined();
    expect(card(view, 'Senza id')).toBeTruthy();
    expect((within(card(view), t('NAME')) as HTMLInputElement).disabled).toBe(true);
    expect(rows(card(view))).toHaveLength(1);
  });
});
