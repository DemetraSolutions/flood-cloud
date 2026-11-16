import { emulateNativeDialog } from '../../../testing/dialog';
import { fakePlace, renderPlace, ROOM, ROOM_ID } from '../../../testing/places';
import { cleanUp, savePatch, within } from '../../../testing/places-tabs';
import { clamp, limitText } from './room-layout-editor';
import { PlaceRoom } from './place.types';

const t = (key: string) => `PLACES.ROOM_EDITOR.${key}`;

type View = Awaited<ReturnType<typeof renderPlace>>;

const dialog = (view: View) => view.root.querySelector('dialog') as HTMLDialogElement;
const cell = (view: View, x: number, y: number) =>
  dialog(view).querySelector(`.cell[data-x="${x}"][data-y="${y}"]`) as HTMLButtonElement;
const tableEl = (view: View, name: string) =>
  [...dialog(view).querySelectorAll<HTMLElement>('.layer .table')].find(
    (el) => el.querySelector('.name')?.textContent === name,
  ) as HTMLElement;
const placedNames = (view: View) =>
  [...dialog(view).querySelectorAll('.layer .table .name')].map((el) => el.textContent);
const unplacedNames = (view: View) =>
  [...dialog(view).querySelectorAll('.unplaced button')].map((el) => el.textContent?.trim());
const announced = (view: View) =>
  dialog(view).querySelector('p.visually-hidden[role=status]')?.textContent?.trim();
const field = (view: View, label: string) => within(dialog(view), label);
const dlgButton = (view: View, text: string) =>
  [...dialog(view).querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement;

const open = async (view: View, roomLabel = 'PLACES.ROOMS_TAB.DRAW') => {
  (view.button(roomLabel) as HTMLButtonElement).click();
  await view.view();
};
const press = async (view: View, el: Element) => {
  (el as HTMLElement).click();
  await view.view();
};
const key = async (view: View, el: Element, name: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  await view.view();
  return event;
};
const pointer = async (view: View, el: Element, type: string, init: PointerEventInit = {}) => {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      ...init,
    }),
  );
  await view.view();
};
const set = async (view: View, label: string, value: string) => {
  const control = field(view, label);
  control.value = value;
  control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input'));
  await view.view();
  return control;
};
const confirm = (view: View) => press(view, dlgButton(view, 'COMMON.CONFIRM'));

/** The stored room as the body of the save sends it, with the changes of the test. */
const saved = (tables: object[], view: object = { type: 'grid', status: true, h: 8, w: 8 }) => ({
  rooms: {
    items: [
      {
        id: ROOM_ID,
        name: 'Sala 1',
        listId: ROOM.listId,
        service: 10,
        tax: ROOM.tax,
        deviceId: ROOM.deviceId,
        seatsRequest: false,
        seatsRequired: false,
        autoService: false,
        priceListsRequest: false,
        handheldVisibility: true,
        printStations: ROOM.printStations,
        tables,
        view,
      },
    ],
  },
});
const T1 = { id: 'tab0001', name: 'T1', seats: 4, userId: '' };
const T2 = { id: 'tab0002', name: 'T2', seats: 2, userId: '' };
const v = (x: number | null, y: number | null, w = 1, h = 1, shape = 'rect') => ({
  view: { w, h, x, y, shape },
});

function withRoom(room: Partial<PlaceRoom>, ...others: PlaceRoom[]) {
  return fakePlace({
    rooms: { items: [{ ...ROOM, ...room }, ...others], editable: true },
  });
}

beforeAll(() => {
  emulateNativeDialog();
  HTMLElement.prototype.setPointerCapture = () => undefined;
});

describe('helpers', () => {
  it('clamps', () => {
    expect(clamp(5, 1, 3)).toBe(3);
    expect(clamp(0, 1, 3)).toBe(1);
    expect(clamp(2, 1, 3)).toBe(2);
  });

  it('limits what a number field holds', () => {
    expect(limitText('', 1, 5, true)).toBe('');
    expect(limitText('x', 1, 5, true)).toBe('');
    expect(limitText('3', 1, 5, true)).toBe('3');
    expect(limitText('9', 1, 5, true)).toBe('5');
    expect(limitText('0', 1, 5, true)).toBe('1');
    expect(limitText('2.6', 1, 5, true)).toBe('2');
    expect(limitText('2.6', 1, 5, false)).toBe('2.6');
    expect(limitText('7.5', 1, 5, false)).toBe('5');
  });
});

describe('RoomLayoutEditor', () => {
  beforeEach(() => {
    // The surface of the 8 × 8 room: 32 px per cell.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 256,
      height: 256,
    } as DOMRect);
  });
  afterEach(cleanUp);

  describe('RoomLayoutEditor: showing the room', () => {
    it('draws the grid, the placed tables and the tables to place', async () => {
      const view = await renderPlace({ path: 'rooms' });
      expect(dialog(view).hasAttribute('open')).toBe(false);
      await open(view);
      expect(dialog(view).hasAttribute('open')).toBe(true);
      expect(dialog(view).querySelectorAll('.cell')).toHaveLength(64);
      expect(cell(view, 3, 2).textContent?.trim()).toBe('3,2');
      expect(cell(view, 3, 2).getAttribute('aria-label')).toContain('"x":3');
      expect(placedNames(view)).toEqual(['T1']);
      expect(unplacedNames(view)).toEqual(['T2']);
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"name":"T1"');
      expect(tableEl(view, 'T1').getAttribute('aria-pressed')).toBe('false');
      expect(dialog(view).textContent).toContain(t('NONE_SELECTED'));
      expect(dialog(view).textContent).not.toContain(t('OVERLAP_WARNING'));
      expect((field(view, t('ROOM')) as HTMLSelectElement).value).toBe('0');
      expect((field(view, t('TYPE')) as HTMLSelectElement).value).toBe('grid');
      expect((field(view, t('STATUS')) as HTMLInputElement).checked).toBe(true);
      expect((field(view, t('WIDTH')) as HTMLInputElement).value).toBe('8');
      expect((field(view, t('HEIGHT')) as HTMLInputElement).value).toBe('8');
    });

    it('has a single tab stop on the grid', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const stops = [...dialog(view).querySelectorAll('.cell')].filter(
        (c) => c.getAttribute('tabindex') === '0',
      );
      expect(stops).toEqual([cell(view, 0, 0)]);
    });

    it('shows the coordinates only up to 16 × 16 cells', async () => {
      const wide = withRoom({ view: { type: 'grid', status: true, w: 17, h: 4 }, tables: [] });
      const view = await renderPlace({ path: 'rooms', place: wide });
      await open(view);
      expect(cell(view, 1, 1).textContent?.trim()).toBe('');
      expect(dialog(view).querySelector('.cells')?.getAttribute('aria-label')).toContain('"w":17');
    });

    it('shows the coordinates of a grid of 16 × 16 cells', async () => {
      const square = withRoom({ view: { type: 'grid', status: true, w: 16, h: 16 }, tables: [] });
      const view = await renderPlace({ path: 'rooms', place: square });
      await open(view);
      expect(cell(view, 15, 15).textContent?.trim()).toBe('15,15');
    });

    it('opens on the room of the row and changes room, forgetting the selection', async () => {
      const second: PlaceRoom = {
        ...ROOM,
        id: 'room002',
        name: 'Sala 2',
        tables: [{ ...ROOM.tables[0], id: 'x1', name: 'Z1' }],
      };
      const view = await renderPlace({ path: 'rooms', place: withRoom({}, second) });
      const edits = [...view.root.querySelectorAll('button[aria-label^="PLACES.ROOMS_TAB.EDIT_ROOM"]')];
      await press(view, edits[1]);
      expect((field(view, t('ROOM')) as HTMLSelectElement).value).toBe('1');
      expect(placedNames(view)).toEqual(['Z1']);
      await press(view, tableEl(view, 'Z1'));
      await pointer(view, tableEl(view, 'Z1'), 'pointerdown');
      expect(dialog(view).textContent).toContain('"name":"Z1"');
      await set(view, t('ROOM'), '0');
      expect(placedNames(view)).toEqual(['T1']);
      expect(dialog(view).textContent).toContain(t('NONE_SELECTED'));
    });

    it('titles a room without a name in the list of rooms', async () => {
      const view = await renderPlace({ path: 'rooms', place: withRoom({ name: '' }) });
      await open(view);
      expect(
        [...(field(view, t('ROOM')) as HTMLSelectElement).options].map((o) => o.textContent?.trim()),
      ).toEqual([t('NO_NAME')]);
    });

    it('fits a table stored out of its grid when the editor opens', async () => {
      const place = withRoom({
        tables: [{ ...ROOM.tables[0], view: { w: 3, h: 1, x: 7, y: 9, shape: 'rect' } }],
      });
      const view = await renderPlace({ path: 'rooms', place });
      await open(view);
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"x":5,"y":7');
    });

    it('flags overlapping tables with a message, an icon and the label', async () => {
      const place = withRoom({
        tables: [ROOM.tables[0], { ...ROOM.tables[1], view: { w: 2, h: 1, x: 0, y: 0, shape: 'rect' } }],
      });
      const view = await renderPlace({ path: 'rooms', place });
      await open(view);
      expect(dialog(view).textContent).toContain(t('OVERLAP_WARNING'));
      for (const name of ['T1', 'T2']) {
        expect(tableEl(view, name).classList.contains('overlap')).toBe(true);
        expect(tableEl(view, name).querySelector('fc-icon')).not.toBeNull();
        expect(tableEl(view, name).getAttribute('aria-label')).toContain('TABLE_ARIA_OVERLAP');
      }
    });

    it('changes the shape of a table', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, dialog(view).querySelector('.unplaced button') as Element);
      expect(announced(view)).toContain('"name":"T2"');
      await press(view, cell(view, 4, 4));
      expect(tableEl(view, 'T2').classList.contains('round')).toBe(true);
      await set(view, t('SHAPE'), 'rect');
      expect(tableEl(view, 'T2').classList.contains('round')).toBe(false);
      await set(view, t('SHAPE'), 'round');
      expect(tableEl(view, 'T2').classList.contains('round')).toBe(true);
      await set(view, t('SHAPE'), 'whatever');
      expect(tableEl(view, 'T2').classList.contains('round')).toBe(false);
    });
  });

  describe('RoomLayoutEditor: confirm and cancel', () => {
    it('writes the layout to the form only on confirm, and the page saves it', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, dialog(view).querySelector('.unplaced button') as Element);
      await press(view, cell(view, 3, 2));
      expect(announced(view)).toContain('"x":3,"y":2');
      expect(unplacedNames(view)).toEqual([]);
      expect(dialog(view).textContent).toContain(t('NO_UNPLACED'));
      await confirm(view);
      expect(dialog(view).hasAttribute('open')).toBe(false);
      await savePatch(view, saved([{ ...T1, ...v(0, 0) }, { ...T2, ...v(3, 2, 2, 1, 'round') }]));
    });

    it('discards the changes on cancel and on close, and starts again from the form', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, dlgButton(view, t('CLEAR')));
      expect(placedNames(view)).toEqual([]);
      await press(view, dlgButton(view, 'COMMON.CANCEL'));
      expect(dialog(view).hasAttribute('open')).toBe(false);
      await open(view);
      expect(placedNames(view)).toEqual(['T1']);
      await press(view, dlgButton(view, t('CLEAR')));
      await press(view, dialog(view).querySelector('button[aria-label="COMMON.CLOSE"]') as Element);
      await open(view);
      expect(placedNames(view)).toEqual(['T1']);
      // Nothing changed in the form: the page has nothing to save.
      await press(view, dlgButton(view, 'COMMON.CANCEL'));
      expect(view.button('COMMON.SAVE')?.disabled).toBe(true);
    });
  });

  describe('RoomLayoutEditor: the room', () => {
    it('changes type, status and size of the grid and saves them', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await set(view, t('TYPE'), '');
      await press(view, field(view, t('STATUS')));
      await set(view, t('WIDTH'), '10');
      await set(view, t('HEIGHT'), '6');
      expect(announced(view)).toContain('"w":10,"h":6');
      expect(dialog(view).querySelectorAll('.cell')).toHaveLength(60);
      await confirm(view);
      await savePatch(
        view,
        saved([{ ...T1, ...v(0, 0) }, { ...T2, ...v(null, null, 2, 1, 'round') }], {
          type: '',
          status: false,
          h: 6,
          w: 10,
        }),
      );
    });

    it('keeps the grid between 1 and 50 cells and ignores an empty field', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      expect((await set(view, t('WIDTH'), '70')).getAttribute('type')).toBe('number');
      expect((field(view, t('WIDTH')) as HTMLInputElement).value).toBe('50');
      await set(view, t('HEIGHT'), '0');
      expect((field(view, t('HEIGHT')) as HTMLInputElement).value).toBe('1');
      await set(view, t('WIDTH'), '');
      expect(dialog(view).querySelectorAll('.cell')).toHaveLength(50);
    });

    it('fits the tables when the grid shrinks: smaller if larger, shifted until they fit', async () => {
      const place = withRoom({
        tables: [
          { ...ROOM.tables[0], view: { w: 1, h: 1, x: 7, y: 7, shape: 'rect' } },
          { ...ROOM.tables[1], view: { w: 6, h: 6, x: 0, y: 0, shape: 'rect' } },
        ],
      });
      const view = await renderPlace({ path: 'rooms', place });
      await open(view);
      await set(view, t('WIDTH'), '4');
      expect(announced(view)).toContain('"count":2');
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"x":3,"y":7');
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"w":4,"h":6');
      await set(view, t('HEIGHT'), '3');
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"x":3,"y":2,"w":1,"h":1');
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"w":4,"h":3');
      // The tab stop stays on a cell of the smaller grid.
      expect(
        [...dialog(view).querySelectorAll('.cell')].filter((c) => c.getAttribute('tabindex') === '0'),
      ).toHaveLength(1);
    });

    it('takes the tab stop back into a smaller grid', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      cell(view, 7, 7).focus();
      await view.view();
      await set(view, t('WIDTH'), '3');
      await set(view, t('HEIGHT'), '3');
      expect(cell(view, 2, 2).getAttribute('tabindex')).toBe('0');
    });

    it('clears the tables of the room', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, dlgButton(view, t('CLEAR')));
      expect(announced(view)).toContain('CLEARED');
      expect(placedNames(view)).toEqual([]);
      expect(unplacedNames(view)).toEqual(['T1', 'T2']);
      await confirm(view);
      await savePatch(
        view,
        saved([{ ...T1, ...v(null, null) }, { ...T2, ...v(null, null, 2, 1, 'round') }]),
      );
    });
  });

  describe('RoomLayoutEditor: the table panel', () => {
    it('edits the row of a table that is not on the map before its column', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, dialog(view).querySelector('.unplaced button') as Element);
      await set(view, t('POSITION_Y'), '3');
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"x":0,"y":3');
    });

    it('changes only the room being drawn and leaves the others as they are', async () => {
      const second: PlaceRoom = { ...ROOM, id: 'room002', name: 'Sala 2' };
      const view = await renderPlace({ path: 'rooms', place: withRoom({}, second) });
      await open(view);
      await set(view, t('TYPE'), '');
      await set(view, t('ROOM'), '1');
      expect((field(view, t('TYPE')) as HTMLSelectElement).value).toBe('grid');
    });

    it('edits the shape, the size and the position of a table', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, dialog(view).querySelector('.unplaced button') as Element);
      expect(dialog(view).textContent).toContain(t('PLACE_HINT'));
      expect(dialog(view).textContent).toContain('"name":"T2"');
      expect(dlgButton(view, t('REMOVE_FROM_MAP')).disabled).toBe(true);
      expect((field(view, t('POSITION_X')) as HTMLInputElement).value).toBe('');
      // Typing the column of a table that is not on the map puts it on the first row.
      await set(view, t('POSITION_X'), '5');
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"x":5,"y":0');
      expect((field(view, t('POSITION_Y')) as HTMLInputElement).value).toBe('0');
      await set(view, t('POSITION_Y'), '4');
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"x":5,"y":4');
      // A position the table does not fit in is clamped (the table is 2 cells wide).
      await set(view, t('POSITION_X'), '9');
      expect((field(view, t('POSITION_X')) as HTMLInputElement).value).toBe('6');
      await set(view, t('POSITION_Y'), '');
      await set(view, t('TABLE_WIDTH'), '5');
      expect((field(view, t('TABLE_WIDTH')) as HTMLInputElement).value).toBe('2');
      await set(view, t('TABLE_HEIGHT'), '9');
      expect((field(view, t('TABLE_HEIGHT')) as HTMLInputElement).value).toBe('4');
      await set(view, t('TABLE_HEIGHT'), '2');
      await set(view, t('TABLE_WIDTH'), '');
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"x":6,"y":4,"w":2,"h":2');
      await press(view, dlgButton(view, t('REMOVE_FROM_MAP')));
      expect(placedNames(view)).toEqual(['T1']);
      expect(announced(view)).toContain('REMOVED');
      expect((field(view, t('POSITION_X')) as HTMLInputElement).value).toBe('');
      // The size of a table not on the map is limited by the whole grid.
      await set(view, t('TABLE_WIDTH'), '20');
      expect((field(view, t('TABLE_WIDTH')) as HTMLInputElement).value).toBe('8');
      await set(view, t('TABLE_HEIGHT'), '20');
      expect((field(view, t('TABLE_HEIGHT')) as HTMLInputElement).value).toBe('8');
    });
  });

  describe('RoomLayoutEditor: the cells', () => {
    it('moves the tab stop with the arrows, Home and End and stops at the borders', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await key(view, cell(view, 0, 0), 'ArrowRight');
      expect(document.activeElement).toBe(cell(view, 1, 0));
      expect(cell(view, 1, 0).getAttribute('tabindex')).toBe('0');
      expect(cell(view, 0, 0).getAttribute('tabindex')).toBe('-1');
      await key(view, cell(view, 1, 0), 'ArrowDown');
      expect(document.activeElement).toBe(cell(view, 1, 1));
      await key(view, cell(view, 1, 1), 'ArrowLeft');
      await key(view, cell(view, 0, 1), 'ArrowLeft');
      expect(document.activeElement).toBe(cell(view, 0, 1));
      await key(view, cell(view, 0, 1), 'ArrowUp');
      await key(view, cell(view, 0, 0), 'ArrowUp');
      expect(document.activeElement).toBe(cell(view, 0, 0));
      await key(view, cell(view, 0, 0), 'End');
      expect(document.activeElement).toBe(cell(view, 7, 0));
      await key(view, cell(view, 7, 0), 'Home');
      expect(document.activeElement).toBe(cell(view, 0, 0));
      const other = await key(view, cell(view, 0, 0), 'a');
      expect(other.defaultPrevented).toBe(false);
    });

    it('does nothing when a cell is activated without a selected table', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, cell(view, 2, 2));
      expect(placedNames(view)).toEqual(['T1']);
      expect(announced(view)).toBe('');
    });

    it('puts a table placed on the map somewhere else and keeps it inside the grid', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await pointer(view, tableEl(view, 'T1'), 'pointerdown');
      await press(view, cell(view, 5, 6));
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"x":5,"y":6');
      expect(announced(view)).toContain('MOVED');
      await press(view, dialog(view).querySelector('.unplaced button') as Element);
      await press(view, cell(view, 7, 7));
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"x":6,"y":7');
    });

    it('places a table from the keyboard: select it, move to a cell, Enter', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await press(view, dialog(view).querySelector('.unplaced button') as Element);
      await key(view, cell(view, 0, 0), 'ArrowRight');
      await key(view, cell(view, 1, 0), 'ArrowDown');
      // A native button turns Enter into a click.
      await press(view, cell(view, 1, 1));
      expect(tableEl(view, 'T2').getAttribute('aria-label')).toContain('"x":1,"y":1');
    });
  });

  describe('RoomLayoutEditor: the keyboard on a table', () => {
    it('moves a table with the arrows and says when it reaches the border', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const name = () => tableEl(view, 'T1').getAttribute('aria-label') as string;
      expect((await key(view, tableEl(view, 'T1'), 'ArrowRight')).defaultPrevented).toBe(true);
      expect(name()).toContain('"x":1,"y":0');
      expect(announced(view)).toContain('MOVED');
      await key(view, tableEl(view, 'T1'), 'ArrowDown');
      expect(name()).toContain('"x":1,"y":1');
      await key(view, tableEl(view, 'T1'), 'ArrowLeft');
      await key(view, tableEl(view, 'T1'), 'ArrowUp');
      expect(name()).toContain('"x":0,"y":0');
      await key(view, tableEl(view, 'T1'), 'ArrowLeft');
      expect(name()).toContain('"x":0,"y":0');
      expect(announced(view)).toContain('EDGE');
      // The same message again is still announced (the text changes).
      const raw = () =>
        dialog(view).querySelector('p.visually-hidden[role=status]')?.textContent;
      const first = raw();
      await key(view, tableEl(view, 'T1'), 'ArrowUp');
      expect(raw()).not.toBe(first);
    });

    it('resizes a table with Shift and the arrows, never beyond the grid or below one cell', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const name = () => tableEl(view, 'T1').getAttribute('aria-label') as string;
      await key(view, tableEl(view, 'T1'), 'ArrowRight', { shiftKey: true });
      await key(view, tableEl(view, 'T1'), 'ArrowDown', { shiftKey: true });
      expect(name()).toContain('"w":2,"h":2');
      expect(announced(view)).toContain('RESIZED');
      await key(view, tableEl(view, 'T1'), 'ArrowLeft', { shiftKey: true });
      await key(view, tableEl(view, 'T1'), 'ArrowUp', { shiftKey: true });
      expect(name()).toContain('"w":1,"h":1');
      await key(view, tableEl(view, 'T1'), 'ArrowLeft', { shiftKey: true });
      expect(announced(view)).toContain('EDGE');
      for (let i = 0; i < 9; i++) {
        await key(view, tableEl(view, 'T1'), 'ArrowRight', { shiftKey: true });
      }
      expect(name()).toContain('"w":8');
    });

    it('takes a table off the map with Delete or Backspace and focuses the cell it was on', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      await key(view, tableEl(view, 'T1'), 'Delete');
      expect(placedNames(view)).toEqual([]);
      expect(unplacedNames(view)).toEqual(['T1', 'T2']);
      expect(document.activeElement).toBe(cell(view, 0, 0));
      await press(view, dlgButton(view, 'T1'));
      await press(view, cell(view, 2, 3));
      await key(view, tableEl(view, 'T1'), 'Backspace');
      expect(document.activeElement).toBe(cell(view, 2, 3));
    });

    it('selects a table with Enter or Space and ignores other keys', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      expect((await key(view, tableEl(view, 'T1'), 'Enter')).defaultPrevented).toBe(true);
      expect(tableEl(view, 'T1').getAttribute('aria-pressed')).toBe('true');
      expect(tableEl(view, 'T1').classList.contains('selected')).toBe(true);
      expect(dialog(view).textContent).toContain('"name":"T1"');
      await set(view, t('POSITION_X'), '2');
      await key(view, tableEl(view, 'T1'), ' ');
      expect((await key(view, tableEl(view, 'T1'), 'a')).defaultPrevented).toBe(false);
    });
  });

  describe('RoomLayoutEditor: the pointer', () => {
    it('moves a table by dragging it with the mouse, a cell per 32 pixels', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const table = tableEl(view, 'T1');
      await pointer(view, table, 'pointerdown', { clientX: 10, clientY: 10 });
      expect(tableEl(view, 'T1').classList.contains('selected')).toBe(true);
      await pointer(view, table, 'pointermove', { clientX: 10 + 64, clientY: 10 + 33 });
      expect(table.getAttribute('aria-label')).toContain('"x":2,"y":1');
      // Dragging out of the grid stops at the border.
      await pointer(view, table, 'pointermove', { clientX: 10 + 3000, clientY: 10 - 3000 });
      expect(table.getAttribute('aria-label')).toContain('"x":7,"y":0');
      await pointer(view, table, 'pointermove', { clientX: 10 + 32, clientY: 10 + 32 });
      await pointer(view, table, 'pointerup', { clientX: 42, clientY: 42 });
      expect(announced(view)).toContain('"x":1,"y":1');
      await confirm(view);
      await savePatch(
        view,
        saved([{ ...T1, ...v(1, 1) }, { ...T2, ...v(null, null, 2, 1, 'round') }]),
      );
    });

    it('moves a table with a finger', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const table = tableEl(view, 'T1');
      await pointer(view, table, 'pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 0, clientY: 0 });
      await pointer(view, table, 'pointermove', { pointerType: 'touch', pointerId: 7, clientX: 96, clientY: 0 });
      await pointer(view, table, 'pointerup', { pointerType: 'touch', pointerId: 7 });
      expect(table.getAttribute('aria-label')).toContain('"x":3,"y":0');
    });

    it('resizes a table by its handle', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const handle = tableEl(view, 'T1').querySelector('.handle') as HTMLElement;
      await pointer(view, handle, 'pointerdown', { clientX: 20, clientY: 20 });
      expect(tableEl(view, 'T1').classList.contains('selected')).toBe(true);
      await pointer(view, handle, 'pointermove', { clientX: 20 + 64, clientY: 20 + 32 });
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"x":0,"y":0,"w":3,"h":2');
      // Never smaller than one cell, never beyond the grid.
      await pointer(view, handle, 'pointermove', { clientX: 20 - 500, clientY: 20 - 500 });
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"w":1,"h":1');
      await pointer(view, handle, 'pointermove', { clientX: 20 + 5000, clientY: 20 + 5000 });
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"w":8,"h":8');
      await pointer(view, handle, 'pointerup');
      expect(announced(view)).toContain('"w":8,"h":8');
    });

    it('resizes with a finger on the handle', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const handle = tableEl(view, 'T1').querySelector('.handle') as HTMLElement;
      await pointer(view, handle, 'pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 });
      await pointer(view, handle, 'pointermove', { pointerType: 'touch', clientX: 32, clientY: 0 });
      await pointer(view, handle, 'pointerup', { pointerType: 'touch' });
      expect(tableEl(view, 'T1').getAttribute('aria-label')).toContain('"w":2,"h":1');
    });

    it('goes back when the system cancels the gesture', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const table = tableEl(view, 'T1');
      await pointer(view, table, 'pointerdown', { clientX: 0, clientY: 0 });
      await pointer(view, table, 'pointermove', { clientX: 96, clientY: 96 });
      expect(table.getAttribute('aria-label')).toContain('"x":3,"y":3');
      await pointer(view, table, 'pointercancel', { pointerId: 99 });
      expect(table.getAttribute('aria-label')).toContain('"x":3,"y":3');
      await pointer(view, table, 'pointercancel');
      expect(table.getAttribute('aria-label')).toContain('"x":0,"y":0');
      // Nothing is being dragged any more.
      await pointer(view, table, 'pointermove', { clientX: 200, clientY: 200 });
      await pointer(view, table, 'pointercancel');
      expect(table.getAttribute('aria-label')).toContain('"x":0,"y":0');
    });

    it('keeps a drag marked as moved while it moves along one axis only', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const table = tableEl(view, 'T1');
      await pointer(view, table, 'pointerdown', { clientX: 0, clientY: 0 });
      await pointer(view, table, 'pointermove', { clientX: 0, clientY: 32 });
      await pointer(view, table, 'pointermove', { clientX: 32, clientY: 32 });
      await pointer(view, table, 'pointerup', { clientX: 32, clientY: 32 });
      expect(table.getAttribute('aria-label')).toContain('"x":1,"y":1');
    });

    it('ignores another pointer, a click without moving and the secondary button', async () => {
      const view = await renderPlace({ path: 'rooms' });
      await open(view);
      const table = tableEl(view, 'T1');
      await pointer(view, table, 'pointerdown', { button: 2 });
      expect(table.classList.contains('selected')).toBe(false);
      await pointer(view, table, 'pointermove', { clientX: 90, clientY: 0 });
      expect(table.getAttribute('aria-label')).toContain('"x":0,"y":0');
      await pointer(view, table, 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
      await pointer(view, table, 'pointermove', { pointerId: 2, clientX: 90, clientY: 0 });
      expect(table.getAttribute('aria-label')).toContain('"x":0,"y":0');
      await pointer(view, table, 'pointerup', { pointerId: 2 });
      await pointer(view, table, 'pointerup', { pointerId: 1 });
      expect(announced(view)).toBe('');
      // A pointer up with no drag in progress does nothing.
      await pointer(view, table, 'pointerup', { pointerId: 1 });
    });
  });
});
