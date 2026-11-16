import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
  model,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { Icon } from '../../shared/ui/icon/icon';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { MAX_GRID, RoomRow, TableViewRow } from './place-model';
import { PlaceState } from './place-state';

/** Keeps `value` between `min` and `max` (both included). */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalises what the user types in a number field: the text is kept as typed when it is a number
 * in range, otherwise replaced by the nearest value in range; text that is not a number becomes
 * empty.
 *
 * @param text What the field holds.
 * @param min Lowest value.
 * @param max Highest value.
 * @param integer Whether decimals are dropped.
 */
export function limitText(text: string, min: number, max: number, integer: boolean): string {
  const number = Number(text);
  if (text === '' || Number.isNaN(number)) {
    return '';
  }
  const value = integer ? Math.trunc(number) : number;
  return value === number && value >= min && value <= max
    ? text
    : String(clamp(value, min, max));
}

/** A cell of the grid, in 0-based columns (`x`) and rows (`y`). */
interface Cell {
  x: number;
  y: number;
}

/** A table that is on the map. */
interface PlacedTable {
  /** Index of the table in the room. */
  index: number;
  name: string;
  view: TableViewRow & { x: number; y: number };
  overlaps: boolean;
}

/** Direction of each arrow key: columns and rows. */
const ARROWS = new Map<string, readonly [number, number]>([
  ['ArrowLeft', [-1, 0]],
  ['ArrowRight', [1, 0]],
  ['ArrowUp', [0, -1]],
  ['ArrowDown', [0, 1]],
]);

/** Grids up to this many cells per side show the coordinates in every cell. */
const COORDINATES_UP_TO = 16;

/** Whether two placed tables share at least one cell. */
function intersect(a: PlacedTable, b: PlacedTable): boolean {
  return (
    a.view.x < b.view.x + b.view.w &&
    b.view.x < a.view.x + a.view.w &&
    a.view.y < b.view.y + b.view.h &&
    b.view.y < a.view.y + a.view.h
  );
}

/**
 * The view of a table kept inside a grid: size first (at least one cell, at most the grid), then
 * position (a placed table is shifted until it fits; an unplaced one stays unplaced).
 */
function fitted(view: TableViewRow, width: number, height: number): TableViewRow {
  const w = clamp(view.w, 1, width);
  const h = clamp(view.h, 1, height);
  return {
    ...view,
    w,
    h,
    x: view.x === null ? null : clamp(view.x, 0, width - w),
    y: view.y === null ? null : clamp(view.y, 0, height - h),
  };
}

/** What a pointer is doing to a table: moving it or resizing it, from where it started. */
interface Drag {
  mode: 'move' | 'resize';
  index: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** Size of a cell in pixels. */
  cellWidth: number;
  cellHeight: number;
  origin: TableViewRow & { x: number; y: number };
  moved: boolean;
}

/**
 * Editor of the layout of the rooms, in a modal dialog: a grid of cells per room on which the
 * tables are placed, moved and resized with the mouse, the finger or the keyboard.
 *
 * It works on a copy of the rooms; "Conferma" puts the copy back in the form of the place (the
 * page's save persists it), closing in any other way discards it. Rules:
 * - a table never leaves the grid (`x + w <= width`, `y + h <= height`): moves and resizes are
 *   clamped;
 * - when the grid shrinks, the tables that no longer fit keep their place on the map: they are
 *   made smaller if larger than the grid and shifted until they fit (none is unplaced);
 * - when the editor opens, tables stored out of their grid are fitted the same way;
 * - overlapping tables are allowed and shown with a marker (the legacy had no check).
 *
 * Keyboard: a focused table moves with the arrow keys and is resized with Shift and the arrows,
 * Delete or Backspace removes it from the map, Enter or Space selects it. The cells are buttons
 * with one tab stop (arrows, Home and End move it): with a table selected, Enter on a cell puts
 * the table there. Every change is announced in a live region.
 */
@Component({
  selector: 'fc-room-layout-editor',
  imports: [Button, Checkbox, Dialog, Icon, Select, TextField, TPipe],
  templateUrl: './room-layout-editor.html',
  styleUrl: './room-layout-editor.css',
})
export class RoomLayoutEditor {
  private readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  /** Whether the dialog is open (two-way). */
  readonly open = model(false);
  /** Index of the room the editor shows when it opens. */
  readonly roomIndex = input(0);

  private readonly surface = viewChild<ElementRef<HTMLElement>>('surface');

  /** The copy of the rooms the editor changes: a fresh one every time it opens. */
  protected readonly draft = linkedSignal<boolean, RoomRow[]>({
    source: () => this.open(),
    computation: (open) =>
      open
        ? structuredClone(untracked(() => this.state.model().rooms.items)).map((room) => ({
            ...room,
            tables: room.tables.map((table) => ({
              ...table,
              view: fitted(table.view, room.view.w, room.view.h),
            })),
          }))
        : [],
  });
  /** Index of the room being drawn. */
  protected readonly current = linkedSignal<boolean, number>({
    source: () => this.open(),
    computation: () => untracked(() => this.roomIndex()),
  });
  /** Index of the selected table of the room. */
  protected readonly selected = linkedSignal<unknown, number | null>({
    source: () => [this.open(), this.current()],
    computation: () => null,
  });
  private readonly focused = signal<Cell>({ x: 0, y: 0 });
  /** The last announcement for assistive technology. */
  protected readonly announcement = signal('');
  private flip = false;
  private drag: Drag | null = null;

  protected readonly room = computed(() => this.draft()[this.current()] as RoomRow);
  protected readonly width = computed(() => this.room().view.w);
  protected readonly height = computed(() => this.room().view.h);
  protected readonly showCoordinates = computed(
    () => this.width() <= COORDINATES_UP_TO && this.height() <= COORDINATES_UP_TO,
  );
  protected readonly cells = computed<Cell[]>(() =>
    Array.from({ length: this.width() * this.height() }, (_, k) => ({
      x: k % this.width(),
      y: Math.floor(k / this.width()),
    })),
  );
  /** The cell with the tab stop, kept inside the grid. */
  protected readonly stop = computed<Cell>(() => ({
    x: Math.min(this.focused().x, this.width() - 1),
    y: Math.min(this.focused().y, this.height() - 1),
  }));
  protected readonly roomOptions = computed(() =>
    this.draft().map((room, index) => ({
      value: String(index),
      label: room.name === '' ? this.i18n.t('PLACES.ROOM_EDITOR.NO_NAME') : room.name,
    })),
  );
  protected readonly typeOptions = computed(() => [
    { value: '', label: this.i18n.t('PLACES.ROOM_EDITOR.TYPE_DEFAULT') },
    { value: 'grid', label: this.i18n.t('PLACES.ROOM_EDITOR.TYPE_GRID') },
  ]);
  protected readonly shapeOptions = computed(() => [
    { value: 'rect', label: this.i18n.t('PLACES.ROOM_EDITOR.SHAPE_RECT') },
    { value: 'round', label: this.i18n.t('PLACES.ROOM_EDITOR.SHAPE_ROUND') },
  ]);
  /** The tables on the map, with whether each overlaps another. */
  protected readonly placed = computed<PlacedTable[]>(() => {
    const tables = this.room()
      .tables.map((table, index) => ({
        index,
        name: table.name,
        view: table.view as PlacedTable['view'],
        overlaps: false,
      }))
      .filter(({ view }) => view.x !== null && view.y !== null);
    return tables.map((table) => ({
      ...table,
      overlaps: tables.some((other) => other !== table && intersect(table, other)),
    }));
  });
  protected readonly anyOverlap = computed(() => this.placed().some((table) => table.overlaps));
  /** The tables not on the map yet. */
  protected readonly unplaced = computed(() =>
    this.room()
      .tables.map((table, index) => ({ index, name: table.name }))
      .filter(({ index }) => !this.placed().some((table) => table.index === index)),
  );
  /** The selected table. */
  protected readonly table = computed(() => {
    const index = this.selected();
    return index === null ? null : { index, ...this.room().tables[index] };
  });
  /** Highest values of the size and position of the selected table. */
  protected readonly maxWidth = computed(() => {
    const view = this.table()!.view;
    return view.x === null ? this.width() : this.width() - view.x;
  });
  protected readonly maxHeight = computed(() => {
    const view = this.table()!.view;
    return view.y === null ? this.height() : this.height() - view.y;
  });
  protected readonly maxX = computed(() => this.width() - this.table()!.view.w);
  protected readonly maxY = computed(() => this.height() - this.table()!.view.h);

  // Number fields: what they accept.
  protected readonly gridWidthFormat = (text: string) => limitText(text, 1, MAX_GRID, true);
  protected readonly sizeWidthFormat = (text: string) =>
    limitText(text, 1, this.maxWidth(), true);
  protected readonly sizeHeightFormat = (text: string) =>
    limitText(text, 1, this.maxHeight(), true);
  protected readonly positionXFormat = (text: string) => limitText(text, 0, this.maxX(), true);
  protected readonly positionYFormat = (text: string) => limitText(text, 0, this.maxY(), true);

  // Texts.

  protected tableLabel(table: PlacedTable): string {
    return this.i18n.t(
      table.overlaps
        ? 'PLACES.ROOM_EDITOR.TABLE_ARIA_OVERLAP'
        : 'PLACES.ROOM_EDITOR.TABLE_ARIA',
      { name: table.name, x: table.view.x, y: table.view.y, w: table.view.w, h: table.view.h },
    );
  }

  protected cellLabel(cell: Cell): string {
    return this.i18n.t('PLACES.ROOM_EDITOR.CELL', cell as unknown as Record<string, number>);
  }

  protected coordinates(cell: Cell): string {
    return `${cell.x},${cell.y}`;
  }

  protected isStop(cell: Cell): boolean {
    return cell.x === this.stop().x && cell.y === this.stop().y;
  }

  private say(key: string, params?: Record<string, string | number>): void {
    this.flip = !this.flip;
    this.announcement.set(this.i18n.t(key, params) + (this.flip ? ' ' : ''));
  }

  private nameOf(index: number): string {
    return this.room().tables[index].name;
  }

  // Changes to the draft.

  private patchRoom(change: (room: RoomRow) => RoomRow): void {
    this.draft.update((rooms) =>
      rooms.map((room, index) => (index === this.current() ? change(room) : room)),
    );
  }

  private setView(index: number, view: TableViewRow): void {
    this.patchRoom((room) => ({
      ...room,
      tables: room.tables.map((table, at) => (at === index ? { ...table, view } : table)),
    }));
  }

  private viewOf(index: number): TableViewRow {
    return this.room().tables[index].view;
  }

  protected chooseRoom(value: string): void {
    this.current.set(Number(value));
  }

  protected setType(type: string): void {
    this.patchRoom((room) => ({ ...room, view: { ...room.view, type } }));
  }

  protected setStatus(status: boolean): void {
    this.patchRoom((room) => ({ ...room, view: { ...room.view, status } }));
  }

  /** Changes the width or the height of the grid and fits the tables to the new size. */
  protected setGrid(side: 'w' | 'h', text: string): void {
    if (text === '') {
      return;
    }
    const view = { ...this.room().view, [side]: Number(text) };
    let adjusted = 0;
    this.patchRoom((room) => ({
      ...room,
      view,
      tables: room.tables.map((table) => {
        const next = fitted(table.view, view.w, view.h);
        adjusted += JSON.stringify(next) === JSON.stringify(table.view) ? 0 : 1;
        return { ...table, view: next };
      }),
    }));
    this.say(
      adjusted === 0 ? 'PLACES.ROOM_EDITOR.GRID_RESIZED' : 'PLACES.ROOM_EDITOR.GRID_ADJUSTED',
      { w: view.w, h: view.h, count: adjusted },
    );
  }

  /** Takes every table of the room off the map. */
  protected clear(): void {
    this.patchRoom((room) => ({
      ...room,
      tables: room.tables.map((table) => ({ ...table, view: { ...table.view, x: null, y: null } })),
    }));
    this.say('PLACES.ROOM_EDITOR.CLEARED');
  }

  protected select(index: number): void {
    this.selected.set(index);
    this.say('PLACES.ROOM_EDITOR.SELECTED', { name: this.nameOf(index) });
  }

  protected setShape(shape: string): void {
    const index = this.selected() as number;
    this.setView(index, { ...this.viewOf(index), shape: shape === 'round' ? 'round' : 'rect' });
  }

  protected setSize(side: 'w' | 'h', text: string): void {
    if (text !== '') {
      const index = this.selected() as number;
      this.setView(index, { ...this.viewOf(index), [side]: Number(text) });
    }
  }

  protected setPosition(axis: 'x' | 'y', text: string): void {
    if (text !== '') {
      const index = this.selected() as number;
      const view = this.viewOf(index);
      const x = axis === 'x' ? Number(text) : (view.x ?? 0);
      const y = axis === 'y' ? Number(text) : (view.y ?? 0);
      this.setView(index, {
        ...view,
        x: clamp(x, 0, this.width() - view.w),
        y: clamp(y, 0, this.height() - view.h),
      });
    }
  }

  /** Takes a table off the map; `focusCell` moves the focus to the cell it was in. */
  protected unplace(index: number, focusCell = false): void {
    const view = this.viewOf(index);
    this.setView(index, { ...view, x: null, y: null });
    this.say('PLACES.ROOM_EDITOR.REMOVED', { name: this.nameOf(index) });
    if (focusCell) {
      this.focusAt({ x: view.x as number, y: view.y as number });
    }
  }

  // The cells.

  private focusAt(cell: Cell): void {
    this.focused.set(cell);
    this.surface()!
      .nativeElement.querySelector<HTMLElement>(`[data-x="${cell.x}"][data-y="${cell.y}"]`)!
      .focus();
  }

  private cellOf(event: Event): Cell {
    const data = (event.target as HTMLElement).dataset;
    return { x: Number(data['x']), y: Number(data['y']) };
  }

  /** The cell that has the focus is the one with the tab stop. */
  protected onCellFocus(event: Event): void {
    this.focused.set(this.cellOf(event));
  }

  /** Puts the selected table on the clicked cell (its top-left cell). */
  protected onCellClick(event: Event): void {
    const index = this.selected();
    if (index === null) {
      return;
    }
    const cell = this.cellOf(event);
    const view = this.viewOf(index);
    const placed = view.x !== null;
    const x = clamp(cell.x, 0, this.width() - view.w);
    const y = clamp(cell.y, 0, this.height() - view.h);
    this.setView(index, { ...view, x, y });
    this.say(placed ? 'PLACES.ROOM_EDITOR.MOVED' : 'PLACES.ROOM_EDITOR.PLACED', {
      name: this.nameOf(index),
      x,
      y,
    });
  }

  /** Moves the tab stop with the arrows, Home and End. */
  protected onCellKey(event: KeyboardEvent): void {
    const cell = this.cellOf(event);
    const arrow = ARROWS.get(event.key);
    if (arrow !== undefined) {
      event.preventDefault();
      this.focusAt({
        x: clamp(cell.x + arrow[0], 0, this.width() - 1),
        y: clamp(cell.y + arrow[1], 0, this.height() - 1),
      });
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      this.focusAt({ x: event.key === 'Home' ? 0 : this.width() - 1, y: cell.y });
    }
  }

  // The tables on the map.

  /** Keyboard: arrows move, Shift and arrows resize, Delete removes, Enter and Space select. */
  protected onTableKey(event: KeyboardEvent, index: number): void {
    const arrow = ARROWS.get(event.key);
    if (arrow !== undefined) {
      event.preventDefault();
      if (event.shiftKey) {
        this.resizeBy(index, arrow);
      } else {
        this.moveBy(index, arrow);
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.unplace(index, true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.select(index);
    }
  }

  private moveBy(index: number, [dx, dy]: readonly [number, number]): void {
    const view = this.viewOf(index) as Drag['origin'];
    const x = clamp(view.x + dx, 0, this.width() - view.w);
    const y = clamp(view.y + dy, 0, this.height() - view.h);
    if (x === view.x && y === view.y) {
      this.say('PLACES.ROOM_EDITOR.EDGE', { name: this.nameOf(index) });
    } else {
      this.setView(index, { ...view, x, y });
      this.say('PLACES.ROOM_EDITOR.MOVED', { name: this.nameOf(index), x, y });
    }
  }

  private resizeBy(index: number, [dx, dy]: readonly [number, number]): void {
    const view = this.viewOf(index) as Drag['origin'];
    const w = clamp(view.w + dx, 1, this.width() - view.x);
    const h = clamp(view.h + dy, 1, this.height() - view.y);
    if (w === view.w && h === view.h) {
      this.say('PLACES.ROOM_EDITOR.EDGE', { name: this.nameOf(index) });
    } else {
      this.setView(index, { ...view, w, h });
      this.say('PLACES.ROOM_EDITOR.RESIZED', { name: this.nameOf(index), w, h });
    }
  }

  // Pointer (mouse, pen and touch): move the table, or resize it by its handle.

  /** Starts moving the table (or resizing it, from its handle) and selects it. */
  protected onPointerDown(event: PointerEvent, index: number, mode: 'move' | 'resize'): void {
    if (event.button > 0) {
      return;
    }
    event.stopPropagation();
    this.selected.set(index);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const bounds = this.surface()!.nativeElement.getBoundingClientRect();
    this.drag = {
      mode,
      index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cellWidth: bounds.width / this.width(),
      cellHeight: bounds.height / this.height(),
      origin: this.viewOf(index) as Drag['origin'],
      moved: false,
    };
  }

  protected onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointerId) {
      return;
    }
    const dx = Math.round((event.clientX - drag.startX) / drag.cellWidth);
    const dy = Math.round((event.clientY - drag.startY) / drag.cellHeight);
    const { origin } = drag;
    drag.moved = drag.moved || dx !== 0 || dy !== 0;
    this.setView(
      drag.index,
      drag.mode === 'move'
        ? {
            ...origin,
            x: clamp(origin.x + dx, 0, this.width() - origin.w),
            y: clamp(origin.y + dy, 0, this.height() - origin.h),
          }
        : {
            ...origin,
            w: clamp(origin.w + dx, 1, this.width() - origin.x),
            h: clamp(origin.h + dy, 1, this.height() - origin.y),
          },
    );
  }

  protected onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointerId) {
      return;
    }
    this.drag = null;
    if (drag.moved) {
      const view = this.viewOf(drag.index) as Drag['origin'];
      this.say(
        drag.mode === 'move' ? 'PLACES.ROOM_EDITOR.MOVED' : 'PLACES.ROOM_EDITOR.RESIZED',
        { name: this.nameOf(drag.index), x: view.x, y: view.y, w: view.w, h: view.h },
      );
    }
  }

  /** The system took the pointer away (a scroll, a call): the table goes back. */
  protected onPointerCancel(event: PointerEvent): void {
    const drag = this.drag;
    if (drag !== null && event.pointerId === drag.pointerId) {
      this.drag = null;
      this.setView(drag.index, drag.origin);
    }
  }

  // Closing.

  /** Puts the copy back in the form of the place. */
  protected confirm(): void {
    const rooms = this.draft();
    this.state.edit('rooms', (block) => ({ ...block, items: rooms }));
    this.open.set(false);
  }
}
