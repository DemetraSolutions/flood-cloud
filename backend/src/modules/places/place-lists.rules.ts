import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import { canonicalJson } from '../../shared/http/etag.ts';
import { DEVICE_TYPES, MAX_TABLES, PLACE_LISTS, isEditable, itemKey } from '../../shared/legacy-write/place-lists.ts';
import type { ItemDef, ItemFieldKind, ListDef } from '../../shared/legacy-write/place-lists.ts';
import { setValueAt, valueAt } from '../companies/company.mapper.ts';
import { newItem } from './place-lists.mapper.ts';
import type { DomainItem } from './place-lists.mapper.ts';
import type { SettingsRules } from './place-settings.rules.ts';

/** What the rules of the lists need: what the rules of the settings need, and the stored document (for what the POS keeps in it: whether a device is busy). */
export interface ListRules extends SettingsRules {
  /** The place as stored, `null` for a creation. */
  readonly document: Document | null;
}

/** The kinds of device a plan can have (the old backoffice offers only these, and only when the place is edited): the desk for every plan, the others for `basic` and `advanced`. */
const PLAN_TYPES: Readonly<Record<string, readonly string[]>> = { advanced: DEVICE_TYPES, basic: ['desk', 'waiting-list', 'external-display', 'kiosk', 'tgm'] };

/** The id of a new storage: the id of an `ObjectId`. */
const newStorageId = (): string => new ObjectId().toHexString();

const asItems = (value: unknown): DomainItem[] => (Array.isArray(value) ? (value as DomainItem[]) : []);

/**
 * Completes the items of a request: an item with an id is one the place has (any other id is `incorrect`, a repeated one too) and starts from it, a new one gets an id and the defaults;
 * the keys of the request are laid over it (an `object` key key by key, a `list` key by this same rule). The flags of the credentials are the server's: a value of the client is ignored.
 *
 * @param c The rules context.
 * @param path Where the list is in the request, for the problems.
 * @param def The definition of the items.
 * @param requested The items of the request.
 * @param stored The items the place has, in the domain form.
 * @param newId Makes the id of a new item.
 * @returns The complete items, in the order of the request.
 */
function complete(c: ListRules, path: string, def: ItemDef, requested: DomainItem[], stored: DomainItem[], newId: () => string): DomainItem[] {
  const known = new Map(stored.map((item) => [item['id'] as string, item]));
  const used = new Set<string>();
  return requested.map((raw, index) => {
    const given = raw['id'] as string | undefined;
    const old = given === undefined ? undefined : known.get(given);
    if (given !== undefined && (old === undefined || used.has(given))) {
      c.issue(`${path}.${String(index)}.id`, 'incorrect');
    }
    const id = given ?? newId();
    used.add(id);
    const base: DomainItem = old ?? newItem(def);
    const merged: DomainItem = { ...base };
    for (const [key, value] of Object.entries(raw)) {
      const kind: ItemFieldKind | undefined = def.fields[key];
      if (key === 'id' || (key.endsWith('Set') && def.fields[key.slice(0, -3)]?.t === 'secret')) {
        continue;
      }
      if (kind?.t === 'object') {
        merged[key] = { ...(base[key] as DomainItem), ...(value as DomainItem) };
      } else if (kind?.t === 'list') {
        merged[key] = complete(c, `${path}.${String(index)}.${key}`, kind.item, asItems(value), asItems(base[key]), newId);
      } else {
        merged[key] = value;
      }
    }
    merged['id'] = id;
    return merged;
  });
}

/** Whether each item is new or differs from the stored one with the same id. */
function changedOf(items: readonly DomainItem[], stored: readonly DomainItem[]): boolean[] {
  const known = new Map(stored.map((item) => [item['id'] as string, canonicalJson(item)]));
  return items.map((item) => known.get(item['id'] as string) !== canonicalJson(item));
}

/** The keys of an item that are a closed list of texts: one that changes (or is in a new item) must be one of them; the keys of an `object` key are judged the same way. */
function enumIssues(c: ListRules, path: string, fields: Readonly<Record<string, ItemFieldKind>>, item: DomainItem, old: DomainItem | undefined): void {
  for (const [key, kind] of Object.entries(fields)) {
    const value = item[key];
    const was = old?.[key];
    if (kind.t === 'enum' && typeof value === 'string' && value !== was && !kind.values.includes(value)) {
      c.issue(`${path}.${key}`, value === '' ? 'required' : 'enum');
    } else if (kind.t === 'object') {
      enumIssues(c, `${path}.${key}`, kind.fields, value as DomainItem, was as DomainItem | undefined);
    }
  }
}

/** The problems every item of a list can have: a name (`name`) that is missing, a name another item of the list has (compared without the case), a key that is not one of its values. */
function itemIssues(c: ListRules, path: string, def: ItemDef, items: readonly DomainItem[], stored: readonly DomainItem[], changed: readonly boolean[], named: boolean): void {
  const known = new Map(stored.map((item) => [item['id'] as string, item]));
  items.forEach((item, index) => {
    if (!changed[index]) {
      return;
    }
    enumIssues(c, `${path}.${String(index)}`, def.fields, item, known.get(item['id'] as string));
    if (named) {
      const name = String(item['name']).trim();
      if (name === '') {
        c.issue(`${path}.${String(index)}.name`, 'required');
      } else if (items.some((other, otherIndex) => otherIndex !== index && String(other['name']).trim().toLowerCase() === name.toLowerCase())) {
        c.issue(`${path}.${String(index)}.name`, 'taken');
      }
    }
  });
}

/**
 * The rules of the lists of items (`doc/Tasks.md` area 7, step 7F), applied to the lists a request carries: the items are completed (`next` gets them whole, with the ids), and only what
 * changes is judged, so a place with legacy data that does not satisfy a rule can still be saved where the rule does not touch. The rules are the ones the old backoffice has (unique names
 * without the case, one server device, one cash storage, at most one e-commerce storage, the kinds of device a plan has, the references between the lists), and the references to the data of the group
 * (price lists, tax rates, favorites, product categories). A reference to an item that is removed in the same save is dangling, as in the legacy: the readers ignore it.
 *
 * @param c The rules context: the request, the copy of it the rules complete, the place as it is.
 * @returns The conflict to answer when the request is valid but would remove a device that is busy (the POS says so), or `null`: the caller throws it after the problems of the request.
 */
export async function applyListRules(c: ListRules): Promise<AppError | null> {
  const { request, current, next, issue } = c;
  if (current === null) {
    return null;
  }
  const requested = (path: string): DomainItem[] | undefined => (valueAt(request, path) === undefined ? undefined : asItems(valueAt(request, path)));
  const stored = (path: string): DomainItem[] => asItems(valueAt(current, path));
  const resolved = new Map<string, DomainItem[]>();
  /** Completes a list of the request and puts it in `next`; `undefined` when the request does not carry it. */
  const take = (path: string, def: ListDef, newId: () => string): DomainItem[] | undefined => {
    const items = requested(path);
    if (items === undefined) {
      return undefined;
    }
    // A list with an item that has no id is not writable (a write would lose the item): sent back as it is, it is nothing; any change is a conflict and nothing is written.
    if (!isEditable(def, (c.document as Document)[def.path])) {
      if (canonicalJson(items) !== canonicalJson(stored(path))) {
        throw new AppError('CONFLICT', { message: 'The stored list has an item without an id and cannot be changed', details: [{ field: path.split('.')[0] as string, issue: 'incorrect' }] });
      }
      return undefined;
    }
    const done = complete(c, path, def, items, stored(path), newId);
    setValueAt(next, path, done);
    resolved.set(path, done);
    return done;
  };
  const now = (path: string): DomainItem[] => resolved.get(path) ?? stored(path);

  const devices = take('devices.items', PLACE_LISTS.devices, c.newId);
  const stations = take('printStations.stations', PLACE_LISTS.printStations, c.newId);
  const centers = take('printStations.productionCenters', PLACE_LISTS.productionCenter, c.newId);
  const rooms = take('rooms.items', PLACE_LISTS.rooms, c.newId);
  const storages = take('storages.items', PLACE_LISTS.storages, newStorageId);
  const stationIds = new Set(now('printStations.stations').map((station) => station['id'] as string));

  let conflict: AppError | null = null;
  if (devices !== undefined) {
    conflict = await deviceRules(c, devices, now('devices.items'), stationIds);
  }
  if (stations !== undefined) {
    await stationRules(c, stations);
  }
  if (centers !== undefined) {
    itemIssues(c, 'printStations.productionCenters', PLACE_LISTS.productionCenter, centers, stored('printStations.productionCenters'), changedOf(centers, stored('printStations.productionCenters')), true);
  }
  if (rooms !== undefined) {
    await roomRules(c, rooms, now('devices.items'), stationIds);
  }
  if (storages !== undefined) {
    const before = stored('storages.items');
    const changed = changedOf(storages, before);
    itemIssues(c, 'storages.items', PLACE_LISTS.storages, storages, before, changed, true);
    if (changed.some(Boolean) || storages.length !== before.length) {
      if (storages.length === 0) {
        issue('storages.items', 'required');
      } else if (storages.filter((storage) => storage['cash'] === true).length !== 1) {
        // The storage of the cash desks is one, as the switch of the old backoffice (turning one on turns the other off).
        issue('storages.items', 'incorrect');
      }
      storages.forEach((storage, index) => storage['ecommerce'] === true && storages.findIndex((other) => other['ecommerce'] === true) !== index && issue(`storages.items.${String(index)}.ecommerce`, 'incorrect'));
    }
  }
  return conflict;
}

/** The rules of the devices. */
async function deviceRules(c: ListRules, devices: readonly DomainItem[], all: readonly DomainItem[], stationIds: ReadonlySet<string>): Promise<AppError | null> {
  const { current, issue } = c;
  const before = asItems(valueAt(current, 'devices.items'));
  const changed = changedOf(devices, before);
  itemIssues(c, 'devices.items', PLACE_LISTS.devices, devices, before, changed, true);
  if (!changed.some(Boolean) && devices.length === before.length) {
    return null;
  }
  // A device the POS says is busy is not removed (the old backoffice does not offer the button).
  const kept = new Set(devices.map((device) => device['id'] as string));
  const stored = (c.document as Document)['devices'];
  const busy = (Array.isArray(stored) ? (stored as Document[]) : []).some((device) => !kept.has(itemKey(device) as string) && (device['status'] as Document | undefined)?.['busy'] === true);
  const knownById = new Map(before.map((device) => [device['id'] as string, device]));
  const allowed = PLAN_TYPES[String(current!.license.plan)] ?? ['desk'];
  const lists = (): ReturnType<SettingsRules['lists']> => c.lists();
  let servers = 0;
  for (const [index, device] of devices.entries()) {
    const path = `devices.items.${String(index)}`;
    const old = knownById.get(device['id'] as string);
    if (device['server'] === true && ++servers > 1) {
      issue(`${path}.server`, 'incorrect');
    }
    if (!changed[index]) {
      continue;
    }
    // The kind of device the plan has (the types of the other plans stay as they are, as the legacy).
    if (device['type'] !== old?.['type'] && !allowed.includes(device['type'] as string)) {
      issue(`${path}.type`, 'incorrect');
    }
    for (const [key, type] of [['externalDisplayId', 'external-display'], ['secondaryCompanyPrinterId', 'tgm']] as const) {
      const target = device[key] as string;
      if (target !== '' && target !== old?.[key] && !all.some((other) => other['id'] === target && other['type'] === type)) {
        issue(`${path}.${key}`, 'incorrect');
      }
    }
    const namesBy = (key: 'externalDisplayId' | 'secondaryCompanyPrinterId'): string => {
      const target = all.find((other) => other['id'] === device[key]);
      return target === undefined ? '' : String(target['name']);
    };
    if (old === undefined || device['externalDisplayId'] !== old['externalDisplayId']) {
      device['externalDisplayName'] = namesBy('externalDisplayId');
    }
    if (old === undefined || device['secondaryCompanyPrinterId'] !== old['secondaryCompanyPrinterId']) {
      device['secondaryCompanyPrinterName'] = namesBy('secondaryCompanyPrinterId');
    }
    if (old === undefined || device['favoritesId'] !== old['favoritesId']) {
      const favorites = device['favoritesId'] === '' ? new Map<string, string>() : (await lists()).favorites;
      if (device['favoritesId'] !== '' && !favorites.has(device['favoritesId'] as string)) {
        issue(`${path}.favoritesId`, 'incorrect');
      }
      device['favoritesGroupName'] = favorites.get(device['favoritesId'] as string) ?? '';
    }
    const known = new Set(asStrings(old?.['printStations']));
    asStrings(device['printStations']).forEach((station, position) => !known.has(station) && !stationIds.has(station) && issue(`${path}.printStations.${String(position)}`, 'incorrect'));
  }
  return busy ? new AppError('CONFLICT', { details: [{ field: 'devices.items', issue: 'busy' }] }) : null;
}

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

/** The rules of the print stations: a name, a driver and a host, categories of the group and stations of the place. */
async function stationRules(c: ListRules, stations: readonly DomainItem[]): Promise<void> {
  const before = asItems(valueAt(c.current, 'printStations.stations'));
  const changed = changedOf(stations, before);
  itemIssues(c, 'printStations.stations', PLACE_LISTS.printStations, stations, before, changed, true);
  const knownById = new Map(before.map((station) => [station['id'] as string, station]));
  const categories: Array<{ field: string; id: string }> = [];
  const ids = new Set(stations.map((station) => station['id'] as string));
  for (const [index, station] of stations.entries()) {
    if (!changed[index]) {
      continue;
    }
    const path = `printStations.stations.${String(index)}`;
    const old = knownById.get(station['id'] as string);
    if (String(station['host']).trim() === '') {
      c.issue(`${path}.host`, 'required');
    }
    const knownCategories = new Set(asStrings(old?.['summaryCategoriesIds']));
    asStrings(station['summaryCategoriesIds']).forEach((id, position) => !knownCategories.has(id) && categories.push({ field: `${path}.summaryCategoriesIds.${String(position)}`, id }));
    const knownStations = new Set(asStrings(old?.['summaryPrintStationsIds']));
    asStrings(station['summaryPrintStationsIds']).forEach((id, position) => !knownStations.has(id) && (id === station['id'] || !ids.has(id)) && c.issue(`${path}.summaryPrintStationsIds.${String(position)}`, 'incorrect'));
  }
  if (categories.length > 0) {
    const missing = await c.references.missing(c.principal, c.access, { field: 'summaryCategoriesIds', collection: 'categories', ids: categories.map((category) => category.id) });
    missing.forEach((index) => c.issue(categories[index]!.field, 'incorrect'));
  }
}

/** The rules of the rooms and their tables: names, the references to price lists, tax rates, desk devices and print stations, the layout and the limits. */
async function roomRules(c: ListRules, rooms: readonly DomainItem[], devices: readonly DomainItem[], stationIds: ReadonlySet<string>): Promise<void> {
  const before = asItems(valueAt(c.current, 'rooms.items'));
  const changed = changedOf(rooms, before);
  itemIssues(c, 'rooms.items', PLACE_LISTS.rooms, rooms, before, changed, true);
  const knownById = new Map(before.map((room) => [room['id'] as string, room]));
  let tables = 0;
  const users: Array<{ field: string; id: ObjectId }> = [];
  for (const [index, room] of rooms.entries()) {
    const path = `rooms.items.${String(index)}`;
    const roomTables = asItems(room['tables']);
    tables += roomTables.length;
    if (!changed[index]) {
      continue;
    }
    const old = knownById.get(room['id'] as string);
    const oldTables = asItems(old?.['tables']);
    const tablesChanged = changedOf(roomTables, oldTables);
    // The id of the room is the one of its tables: the server sets it, on the tables that are new or change.
    roomTables.forEach((table, position) => tablesChanged[position] && (table['roomId'] = room['id']));
    itemIssues(c, `${path}.tables`, (PLACE_LISTS.rooms.fields['tables'] as { item: ItemDef }).item, roomTables, oldTables, tablesChanged, true);
    const view = room['view'] as { w: number; h: number };
    const viewChanged = canonicalJson(view) !== canonicalJson(old?.['view']);
    roomTables.forEach((table, position) => {
      const place = table['view'] as { x: number | null; y: number | null; w: number; h: number };
      if ((tablesChanged[position] || viewChanged) && place.x !== null && place.y !== null && (place.x + place.w > view.w || place.y + place.h > view.h)) {
        c.issue(`${path}.tables.${String(position)}.view`, 'incorrect');
      }
    });
    const lists = (): ReturnType<SettingsRules['lists']> => c.lists();
    if (room['listId'] !== '' && room['listId'] !== old?.['listId'] && !(await lists()).priceLists.has(room['listId'] as string)) {
      c.issue(`${path}.listId`, 'incorrect');
    }
    if (room['tax'] !== '' && room['tax'] !== old?.['tax'] && !(await lists()).taxes.has(room['tax'] as string)) {
      c.issue(`${path}.tax`, 'incorrect');
    }
    if (room['deviceId'] !== '' && room['deviceId'] !== old?.['deviceId'] && !devices.some((device) => device['id'] === room['deviceId'] && device['type'] === 'desk')) {
      c.issue(`${path}.deviceId`, 'incorrect');
    }
    const known = new Set(asStrings(old?.['printStations']));
    asStrings(room['printStations']).forEach((station, position) => !known.has(station) && !stationIds.has(station) && c.issue(`${path}.printStations.${String(position)}`, 'incorrect'));
    // The user a table is assigned to (where it changes) is a user of the group, not in the trash, who has this place.
    const knownUsers = new Map(oldTables.map((table) => [table['id'] as string, table['userId']]));
    roomTables.forEach((table, position) => {
      const userId = table['userId'] as string;
      if (userId !== '' && knownUsers.get(table['id'] as string) !== userId) {
        if (/^[0-9a-f]{24}$/.test(userId)) {
          users.push({ field: `${path}.tables.${String(position)}.userId`, id: ObjectId.createFromHexString(userId) });
        } else {
          c.issue(`${path}.tables.${String(position)}.userId`, 'incorrect');
        }
      }
    });
  }
  if (users.length > 0) {
    const missing = await c.repository.missingUsers(c.access.groupId, ObjectId.createFromHexString(c.current!.id), c.companyId === null ? null : ObjectId.createFromHexString(c.companyId), users.map((user) => user.id));
    missing.forEach((index) => c.issue(users[index]!.field, 'incorrect'));
  }
  if (tables > MAX_TABLES) {
    c.issue('rooms.items', 'tooMany');
  }
}
