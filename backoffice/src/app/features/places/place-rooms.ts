import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { IconButton } from '../../shared/ui/icon-button/icon-button';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { withCurrent } from '../companies/company-options';
import {
  MAX_ROOMS,
  MAX_TABLES,
  MAX_TABLES_PER_ROOM,
  newRoom,
  newTable,
  RoomRow,
  TableRow,
} from './place-model';
import { PlaceState } from './place-state';
import { limitText, RoomLayoutEditor } from './room-layout-editor';

/** What the user typed to add tables to a room: one table (`name`), or a range (`from` and `to`). */
interface TableDraft {
  name: string;
  seats: string;
  userId: string;
  from: string;
  to: string;
}

const emptyDraft = (): TableDraft => ({ name: '', seats: '', userId: '', from: '', to: '' });

/** A room of the form with its tables, as fields. */
interface RoomCard {
  field: FieldTree<RoomRow>;
  tables: FieldTree<TableRow>[];
}

/** Whether the names (compared without case or surrounding spaces) have a repeated one. */
const key = (name: string): string => name.trim().toLowerCase();

function swapped<T>(list: readonly T[], a: number, b: number): T[] {
  const copy = [...list];
  [copy[a], copy[b]] = [copy[b], copy[a]];
  return copy;
}

/** `ids` with `id` in or out. */
function toggled(ids: readonly string[], id: string, on: boolean): string[] {
  return on ? [...ids, id] : ids.filter((current) => current !== id);
}

/**
 * Rooms tab of the place, as in the legacy backoffice: the form to add a room, the table of the
 * rooms with the button that opens the layout editor, and a card per room to edit its settings,
 * its print stations and its tables (add one, or a range by number; remove; reorder with the move
 * buttons: the drag and drop of the legacy is replaced by buttons that work with the keyboard and
 * announce the move). The tab edits the section `rooms` of the unique form: there is no save
 * button here.
 *
 * With the stored list not editable (an item without an id) or without the permission to update,
 * everything is read only. Limits of the API: 30 rooms, 200 tables per room, 1000 in all.
 */
@Component({
  selector: 'fc-place-rooms',
  imports: [Button, Checkbox, FormField, IconButton, RoomLayoutEditor, Select, TextField, TPipe],
  templateUrl: './place-rooms.html',
  styleUrl: './place-rooms.css',
})
export class PlaceRooms {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly maxRooms = MAX_ROOMS;
  protected readonly maxTablesPerRoom = MAX_TABLES_PER_ROOM;
  protected readonly maxTables = MAX_TABLES;

  protected readonly items = computed(() => this.state.model().rooms.items);
  /** Whether the stored list can be changed at all. */
  protected readonly editable = computed(() => this.state.model().rooms.editable);
  /** Whether the user can add, remove, reorder and draw. */
  protected readonly mutable = computed(() => this.state.canWrite() && this.editable());
  protected readonly totalTables = computed(() =>
    this.items().reduce((total, room) => total + room.tables.length, 0),
  );
  protected readonly cards = computed<RoomCard[]>(() =>
    [...this.state.form.rooms.items].map((field) => ({ field, tables: [...field.tables] })),
  );

  // Lookups.
  private readonly lists = computed<SelectOption[]>(() =>
    this.state
      .priceLists()
      .filter((priceList) => priceList.enabled)
      .map((priceList) => ({ value: priceList.id, label: priceList.name })),
  );
  private readonly taxOptions = computed<SelectOption[]>(() =>
    this.state.taxes().map((tax) => ({
      value: tax.id,
      label: [`${tax.rate}%`, tax.description].filter(Boolean).join(' '),
    })),
  );
  private readonly desks = computed<SelectOption[]>(() =>
    this.state
      .model()
      .devices.items.filter((device) => device.type === 'desk' && device.id !== '')
      .map((device) => ({ value: device.id, label: device.name })),
  );
  private readonly users = computed<SelectOption[]>(() =>
    this.state.users().map((user) => ({ value: user.id, label: user.username })),
  );
  /** The print stations of the place the rooms can use. */
  protected readonly stations = computed(() =>
    this.state
      .model()
      .printStations.stations.filter((station) => station.id !== '')
      .map((station) => ({ id: station.id, name: station.name })),
  );

  protected listOptions(current: string): SelectOption[] {
    return withCurrent(this.lists(), current, (id) => id);
  }

  protected taxesOf(current: string): SelectOption[] {
    return withCurrent(this.taxOptions(), current, (id) => id);
  }

  protected desksOf(current: string): SelectOption[] {
    return withCurrent(this.desks(), current, (id) => id);
  }

  protected usersOf(current: string): SelectOption[] {
    return withCurrent(this.users(), current, (id) => id);
  }

  // Number fields.
  protected readonly serviceFormat = (text: string) => limitText(text, 0, 100, false);
  protected readonly wholeFormat = (text: string) => limitText(text, 0, Infinity, true);

  // The form to add a room.
  protected readonly draft = signal<RoomRow>(newRoom());
  /** What the user typed to add tables, by index of the room. */
  protected readonly drafts = signal<Record<number, TableDraft>>({});
  /** The last move or change, announced to assistive technology. */
  protected readonly announcement = signal('');
  private flip = false;

  /** The layout editor. */
  protected readonly editorOpen = signal(false);
  protected readonly editorRoom = signal(0);

  constructor() {
    this.state.need('priceLists');
    this.state.need('taxes');
    this.state.need('users');
  }

  // Names.

  protected roomTitle(name: string): string {
    return name.trim() === '' ? this.i18n.t('PLACES.ROOMS_TAB.NO_NAME') : name;
  }

  protected tableTitle(name: string): string {
    return name.trim() === '' ? this.i18n.t('PLACES.ROOMS_TAB.NO_NAME_TABLE') : name;
  }

  protected typeLabel(type: string): string {
    return this.i18n.t(
      type === '' ? 'PLACES.ROOM_EDITOR.TYPE_DEFAULT' : 'PLACES.ROOM_EDITOR.TYPE_GRID',
    );
  }

  protected size(room: RoomRow): string {
    return `${room.view.w}×${room.view.h}`;
  }

  /** Indexes of the rooms whose name another room has too. */
  private readonly repeatedRooms = computed(() => {
    const names = this.items().map((room) => key(room.name));
    return new Set(
      names.flatMap((name, index) =>
        name !== '' && names.indexOf(name) !== names.lastIndexOf(name) ? [index] : [],
      ),
    );
  });

  /** The error of the name of a room: the form's, or a name another room has. */
  protected roomNameError(index: number, field: FieldTree<string>): string | null {
    return (
      this.state.fieldError(field) ??
      (this.repeatedRooms().has(index) ? this.i18n.t('PLACES.ROOMS_TAB.NAME_TAKEN') : null)
    );
  }

  /** The error of the name of a table: the form's, or a name another table of the room has. */
  protected tableNameError(room: number, table: number, field: FieldTree<string>): string | null {
    const names = this.items()[room].tables.map((candidate) => key(candidate.name));
    const name = names[table];
    return (
      this.state.fieldError(field) ??
      (name !== '' && names.indexOf(name) !== names.lastIndexOf(name)
        ? this.i18n.t('PLACES.ROOMS_TAB.TABLE_NAME_TAKEN')
        : null)
    );
  }

  // Announcements and focus.

  private say(text: string): void {
    this.flip = !this.flip;
    this.announcement.set(text + (this.flip ? ' ' : ''));
  }

  /** Moves the focus to the element with this `data-id` once the view is updated. */
  private focusLater(id: string): void {
    afterNextRender(
      () => this.host.nativeElement.querySelector<HTMLElement>(`[data-id="${id}"]`)!.focus(),
      { injector: this.injector },
    );
  }

  // The room to add.

  protected setDraft<K extends keyof RoomRow>(name: K, value: RoomRow[K]): void {
    this.draft.update((draft) => ({ ...draft, [name]: value }));
  }

  protected readonly draftNameError = computed(() => {
    const name = key(this.draft().name);
    return name !== '' && this.items().some((room) => key(room.name) === name)
      ? this.i18n.t('PLACES.ROOMS_TAB.NAME_TAKEN')
      : null;
  });

  protected readonly canAddRoom = computed(
    () =>
      this.draft().name.trim() !== '' &&
      this.draftNameError() === null &&
      this.items().length < MAX_ROOMS,
  );

  protected addRoom(): void {
    const room = { ...this.draft(), name: this.draft().name.trim() };
    this.state.edit('rooms', (block) => ({ ...block, items: [...block.items, room] }));
    this.draft.set(newRoom());
    this.say(this.i18n.t('PLACES.ROOMS_TAB.ROOM_ADDED', { name: room.name }));
  }

  // Rooms.

  protected moveRoom(index: number, step: -1 | 1): void {
    const target = index + step;
    const last = this.items().length - 1;
    this.state.edit('rooms', (block) => ({ ...block, items: swapped(block.items, index, target) }));
    this.drafts.set({});
    this.say(
      this.i18n.t('PLACES.ROOMS_TAB.ROOM_MOVED', { position: target + 1, total: last + 1 }),
    );
    // The button that moved the room may now be disabled: the focus goes where it can continue.
    const same = step === -1 ? target > 0 : target < last;
    this.focusLater(`room-${same === (step === -1) ? 'up' : 'down'}-${target}`);
  }

  protected removeRoom(index: number): void {
    const name = this.items()[index].name;
    this.state.edit('rooms', (block) => ({
      ...block,
      items: block.items.filter((_, at) => at !== index),
    }));
    this.drafts.set({});
    this.say(this.i18n.t('PLACES.ROOMS_TAB.ROOM_REMOVED', { name }));
    this.focusLater('add-room');
  }

  protected toggledStations(ids: readonly string[], id: string, on: boolean): string[] {
    return toggled(ids, id, on);
  }

  protected toggleStation(field: FieldTree<RoomRow>, id: string, on: boolean): void {
    field.printStations().value.update((ids) => toggled(ids, id, on));
  }

  protected hasStation(field: FieldTree<RoomRow>, id: string): boolean {
    return field.printStations().value().includes(id);
  }

  protected openEditor(index: number): void {
    this.editorRoom.set(index);
    this.editorOpen.set(true);
  }

  // Tables.

  private editTables(room: number, change: (tables: TableRow[]) => TableRow[]): void {
    this.state.edit('rooms', (block) => ({
      ...block,
      items: block.items.map((row, at) =>
        at === room ? { ...row, tables: change(row.tables) } : row,
      ),
    }));
  }

  protected moveTable(room: number, index: number, step: -1 | 1): void {
    const target = index + step;
    const last = this.items()[room].tables.length - 1;
    this.editTables(room, (tables) => swapped(tables, index, target));
    this.say(
      this.i18n.t('PLACES.ROOMS_TAB.TABLE_MOVED', { position: target + 1, total: last + 1 }),
    );
    const same = step === -1 ? target > 0 : target < last;
    this.focusLater(`table-${same === (step === -1) ? 'up' : 'down'}-${room}-${target}`);
  }

  protected removeTable(room: number, index: number): void {
    const name = this.items()[room].tables[index].name;
    this.editTables(room, (tables) => tables.filter((_, at) => at !== index));
    this.say(this.i18n.t('PLACES.ROOMS_TAB.TABLE_REMOVED', { name }));
    this.focusLater(`tables-${room}`);
  }

  protected draftOf(room: number): TableDraft {
    return this.drafts()[room] ?? emptyDraft();
  }

  protected setTableDraft(room: number, name: keyof TableDraft, value: string): void {
    this.drafts.update((all) => ({ ...all, [room]: { ...this.draftOf(room), [name]: value } }));
  }

  /** How many tables the room can still take (its own limit and the place's). */
  protected capacity(room: number): number {
    return Math.min(
      MAX_TABLES_PER_ROOM - this.items()[room].tables.length,
      MAX_TABLES - this.totalTables(),
    );
  }

  /**
   * The tables the draft of a room would add (none while it is incomplete) and what is wrong
   * with it: a name in use, a range that is backwards, or the limits.
   */
  protected plan(room: number): { names: string[]; error: string | null } {
    const draft = this.draftOf(room);
    let names: string[];
    if (draft.from === '' && draft.to === '') {
      names = draft.name.trim() === '' ? [] : [draft.name.trim()];
    } else if (draft.from === '' || draft.to === '') {
      names = [];
    } else {
      const start = Number(draft.from);
      names = Array.from({ length: Math.max(Number(draft.to) - start + 1, 0) }, (_, k) =>
        String(start + k),
      );
      if (names.length === 0) {
        return { names, error: this.i18n.t('PLACES.ROOMS_TAB.RANGE_INVALID') };
      }
    }
    const taken = new Set(this.items()[room].tables.map((table) => key(table.name)));
    if (names.some((name) => taken.has(key(name)))) {
      return {
        names: [],
        error: this.i18n.t(
          names.length === 1
            ? 'PLACES.ROOMS_TAB.TABLE_NAME_TAKEN'
            : 'PLACES.ROOMS_TAB.RANGE_TAKEN',
        ),
      };
    }
    if (names.length > this.capacity(room)) {
      return {
        names: [],
        error: this.i18n.t('PLACES.ROOMS_TAB.TABLES_LIMIT', {
          room: MAX_TABLES_PER_ROOM,
          total: MAX_TABLES,
        }),
      };
    }
    return { names, error: null };
  }

  protected addTables(room: number): void {
    const draft = this.draftOf(room);
    const { names } = this.plan(room);
    this.editTables(room, (tables) => [
      ...tables,
      ...names.map((name) => ({ ...newTable(name, draft.seats), userId: draft.userId })),
    ]);
    this.drafts.update((all) => ({ ...all, [room]: emptyDraft() }));
    this.say(this.i18n.t('PLACES.ROOMS_TAB.TABLES_ADDED', { count: names.length }));
  }
}
