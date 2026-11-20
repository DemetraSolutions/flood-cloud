/**
 * The lists of items of a place (`doc/Tasks.md` area 7, step 7F): `devices`, `printStations`, `productionCenter`, `rooms` (with their `tables`) and `storages`. Every list is written as a
 * whole array, but never by replacing the stored items: the items the caller sends are fragments (the keys that changed, and the id) that {@link mergeList} lays over the stored item with
 * the same id inside the transaction of the write. So every key the backend does not own (the `info` and `status` the POS writes on a device, the `view.subtables` of a room, the
 * `__index` and `__listName` artifacts of the old backoffice, any key a later release adds) survives, and a stored value that did not change keeps its exact BSON type.
 *
 * The module is data and pure functions only: the codecs, the schemas and the rules of the places module are built from the definitions below.
 */

import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/** How a key of an item is read, validated and written. `def` is the value of a key the request leaves out of a new item. */
export type ItemFieldKind =
  /** A text, `''` for none. */
  | { readonly t: 'text'; readonly max: number }
  /** A switch. */
  | { readonly t: 'flag' }
  /** One of a closed list of texts (checked by the service where the value changes, so a historical value is read and sent back as it is). */
  | { readonly t: 'enum'; readonly values: readonly string[]; readonly def: string }
  /** A whole number, `null` for none. */
  | { readonly t: 'int'; readonly min: number; readonly max: number; readonly def: number | null }
  /** A number, `null` for none. */
  | { readonly t: 'num'; readonly min: number; readonly max: number }
  /** The id of another item or of a catalog element of the group, `''` for none (checked by the service where it changes). */
  | { readonly t: 'ref' }
  /** A list of such ids. */
  | { readonly t: 'refs'; readonly max: number }
  /** A credential: write-only, `null` clears it, an absent key keeps it; the representation has `<key>Set` instead of the value. */
  | { readonly t: 'secret'; readonly max: number }
  /** An object of keys written one by one; every key the document has besides them is kept. */
  | { readonly t: 'object'; readonly fields: Readonly<Record<string, ItemFieldKind>> }
  /** The terminals of a MultiSafepay device: a list of `{ terminalId, name }` without ids, written as a whole (the legacy shape); at most `max`, `terminalId` unique in the list. */
  | { readonly t: 'terminals'; readonly max: number }
  /** A list of items with their own id. */
  | { readonly t: 'list'; readonly item: ItemDef; readonly max: number };

/** An item of a list: the keys the backend owns, in the order a new item has them (after its id). */
export interface ItemDef {
  readonly fields: Readonly<Record<string, ItemFieldKind>>;
}

/** A list of the place: where it is stored and how its items look. */
export interface ListDef extends ItemDef {
  /** The key of the document that holds the list. */
  readonly path: string;
  /** The key that identifies an item (`id`). */
  readonly idKey: 'id';
  /** What the id is in the document: a text of the form of the old backoffice (`dBJs.createId`) or an `ObjectId`. */
  readonly idKind: 'text' | 'objectId';
  /** Most items the list can have. */
  readonly max: number;
  /**
   * What goes in the version: `owned` is the id and the keys of the definition only (the keys a POS writes, as `devices[].info`, do not change the version); `whole` is the stored list
   * as it is (a write of the POS to the rooms changes the version, so a save made on a stale copy is refused).
   */
  readonly version: 'owned' | 'whole';
  /** Keys given to a new item once, never written again (the `status` of a new device, which the POS keeps from then on). */
  readonly init?: () => Document;
}

const text = (max: number): ItemFieldKind => ({ t: 'text', max });
const FLAG: ItemFieldKind = { t: 'flag' };
const REF: ItemFieldKind = { t: 'ref' };
const enumOf = (values: readonly string[], def = ''): ItemFieldKind => ({ t: 'enum', values, def });
const int = (min: number, max: number, def: number | null = null): ItemFieldKind => ({ t: 'int', min, max, def });
const secret = (max: number): ItemFieldKind => ({ t: 'secret', max });

/** Most MultiSafepay terminals of a device. */
export const MAX_MULTISAFEPAY_TERMINALS = 20;

/** The kinds of device of the old backoffice (`name="device-type"`). */
export const DEVICE_TYPES = Object.freeze(['desk', 'handheld', 'ordering', 'room-handheld', 'selfordering', 'waiting-list', 'external-display', 'kiosk', 'tgm'] as const);

/** The drivers of the fiscal printer, of the secondary printer and of the automatic cash, and of a print station (the options of the old backoffice; `''` is none). */
export const FISCAL_DRIVERS = Object.freeze(['', 'EPSON-FP-81-II-RT', 'CUSTOM-K3-Q3X-KUBEX', 'EPSON-EPOS-PRINT', 'ESCPOS'] as const);
export const SECONDARY_DRIVERS = Object.freeze(['', 'EPSON-EPOS-PRINT', 'ESCPOS'] as const);
export const AUTOMATIC_CASH_DRIVERS = Object.freeze([
  '',
  'GLORY-CI5',
  'GLORY-CI10',
  'GLORY-CI10X',
  'CASHMATIC-SELFPAY-460',
  'CASHMATIC-SELFPAY-660',
  'CASHMATIC-SELFPAY-1060',
  'CASHLOGY-POS1500X',
  'VNE-AUTOMATIC-CASH',
  'CASH-SYSTEM',
  'CASHSPEED-SMARTTILL',
  'CASHDRO-7',
  'GLORY-CI5-XCASH',
  'GLORY-CI10-XCASH',
] as const);
export const STATION_DRIVERS = Object.freeze(['EPSON-EPOS-PRINT', 'ESCPOS'] as const);

/** Most tables of a room, rooms of a place, tables of a place, and the largest grid of a room. */
export const MAX_ROOMS = 30;
export const MAX_TABLES_PER_ROOM = 200;
export const MAX_TABLES = 1000;
export const MAX_GRID = 50;

const TABLE: ItemDef = {
  fields: {
    roomId: text(64),
    name: text(100),
    seats: int(0, 1000),
    userId: REF,
    view: {
      t: 'object',
      fields: {
        w: int(1, MAX_GRID, 1),
        h: int(1, MAX_GRID, 1),
        x: int(0, MAX_GRID - 1),
        y: int(0, MAX_GRID - 1),
        shape: enumOf(['rect', 'round'], 'rect'),
      },
    },
  },
};

/** The five lists, by the key of the document that holds them. */
export const PLACE_LISTS = Object.freeze({
  devices: {
    path: 'devices',
    idKey: 'id',
    idKind: 'text',
    max: 100,
    version: 'owned',
    init: () => ({ status: { busy: false, userName: '' } }),
    fields: {
      server: FLAG,
      type: enumOf(DEVICE_TYPES, 'desk'),
      name: text(100),
      driver: enumOf(FISCAL_DRIVERS),
      host: text(255),
      serialNumber: text(100),
      epsonProtocol17: FLAG,
      epsonEreceipt: FLAG,
      DLN502017Rounding: FLAG,
      secondaryDriver: enumOf(SECONDARY_DRIVERS),
      secondaryHost: text(255),
      automaticCashDriver: enumOf(AUTOMATIC_CASH_DRIVERS),
      automaticCashHost: text(255),
      automaticCashUsername: secret(100),
      automaticCashPassword: secret(100),
      posProtocol17ip: text(64),
      posProtocol17port: text(10),
      posProtocol17terminalId: text(64),
      posDojoTerminalId: text(64),
      multisafepayAppStatus: FLAG,
      multisafepayQrStatus: FLAG,
      multisafepayTerminals: { t: 'terminals', max: MAX_MULTISAFEPAY_TERMINALS },
      externalDisplayId: REF,
      secondaryCompanyPrinterId: REF,
      favoritesId: REF,
      scaleDialog0204Ip: text(64),
      scaleDialog0204Port: text(10),
      scaleDialog0204SendPrice: FLAG,
      barcodePriceRule: text(100),
      orderingPrintSingleProduct: FLAG,
      orderingPrintSingleProductTables: FLAG,
      printStations: { t: 'refs', max: 100 },
      // The names the old backoffice keeps next to the references (the server computes them: a value of the client is ignored).
      externalDisplayName: text(100),
      secondaryCompanyPrinterName: text(100),
      favoritesGroupName: text(100),
    },
  },
  printStations: {
    path: 'printStations',
    idKey: 'id',
    idKind: 'text',
    max: 100,
    version: 'owned',
    fields: {
      name: text(100),
      driver: enumOf(STATION_DRIVERS),
      host: text(255),
      pulseNumber: int(0, 2_147_483_647),
      pulseNumberSecondary: int(0, 2_147_483_647),
      upsideDown: FLAG,
      exitsCut: FLAG,
      summaryCategoriesIds: { t: 'refs', max: 500 },
      summaryPrintStationsIds: { t: 'refs', max: 100 },
    },
  },
  productionCenter: {
    path: 'productionCenter',
    idKey: 'id',
    idKind: 'text',
    max: 100,
    version: 'owned',
    fields: { name: text(100), capacity: int(0, 1_000_000, 0) },
  },
  rooms: {
    path: 'rooms',
    idKey: 'id',
    idKind: 'text',
    max: MAX_ROOMS,
    // The POS rewrites the whole array: the version is the whole stored list, so a save on a stale copy is a `412`.
    version: 'whole',
    fields: {
      name: text(100),
      listId: REF,
      service: { t: 'num', min: 0, max: 100 },
      tax: REF,
      deviceId: REF,
      seatsRequest: FLAG,
      seatsRequired: FLAG,
      autoService: FLAG,
      priceListsRequest: FLAG,
      handheldVisibility: FLAG,
      printStations: { t: 'refs', max: 100 },
      tables: { t: 'list', item: TABLE, max: MAX_TABLES_PER_ROOM },
      view: {
        t: 'object',
        fields: { type: enumOf(['grid', ''], 'grid'), status: FLAG, h: int(1, MAX_GRID, 8), w: int(1, MAX_GRID, 8) },
      },
    },
  },
  storages: {
    path: 'storages',
    idKey: 'id',
    idKind: 'objectId',
    max: 20,
    version: 'whole',
    fields: { name: text(100), cash: FLAG, ecommerce: FLAG },
  },
} as const satisfies Readonly<Record<string, ListDef>>);

/** The paths of the document that hold a list. */
export const LIST_PATHS: readonly string[] = Object.freeze(Object.values(PLACE_LISTS).map((list) => list.path));

/** The definition of the list stored at a path, `undefined` for any other path. */
export function listAt(path: string): ListDef | undefined {
  return (Object.values(PLACE_LISTS) as ListDef[]).find((list) => list.path === path);
}

const isPlain = (value: unknown): value is Document => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** The id of a stored item as text (the hexadecimal form of an `ObjectId`, or the text the id is), `undefined` when the item has none. */
export function itemKey(item: unknown, idKey = 'id'): string | undefined {
  if (!isPlain(item)) {
    return undefined;
  }
  const id = item[idKey];
  return id instanceof ObjectId ? id.toHexString() : typeof id === 'string' ? id : undefined;
}

/**
 * Lays the fragments the caller sends over the stored items, in the order of the fragments: an item that exists keeps every key it has (a key of the fragment replaces it, an `object`
 * key is merged key by key, a `list` key is merged item by item, and the id is never touched), an item that does not exist is the fragment as it is. A stored item the fragments do not name is
 * removed.
 *
 * @param stored The list as stored (anything: what is not a list of items with an id is taken as empty).
 * @param fragments The fragments of the items, in the order the list must have.
 * @param def The definition of the items.
 * @param idKey The key of the id.
 * @returns The new list.
 */
export function mergeList(stored: unknown, fragments: readonly Document[], def: ItemDef, idKey = 'id'): Document[] {
  const before = new Map<string, Document>();
  for (const item of Array.isArray(stored) ? (stored as unknown[]) : []) {
    const key = itemKey(item, idKey);
    if (key !== undefined) {
      before.set(key, item as Document);
    }
  }
  return fragments.map((fragment) => {
    const old = before.get(itemKey(fragment, idKey) as string);
    if (old === undefined) {
      return fragment;
    }
    const merged: Document = { ...old };
    for (const [key, value] of Object.entries(fragment)) {
      const kind = def.fields[key];
      if (key === idKey) {
        continue;
      }
      if (kind?.t === 'object' && isPlain(value) && isPlain(old[key])) {
        merged[key] = { ...old[key], ...value };
      } else if (kind?.t === 'list') {
        merged[key] = mergeList(old[key], value as Document[], kind.item, idKey);
      } else {
        merged[key] = value;
      }
    }
    return merged;
  });
}

/**
 * What of a stored list goes in the version of the place: the list as it is for a `whole` one, for an `owned` one every item cut to its id and the keys of the definition (so what the POS
 * writes to an item is not part of the version).
 *
 * @param list The definition.
 * @param stored The stored value.
 * @returns The value the version hashes.
 */
export function listForVersion(list: ListDef, stored: unknown): unknown {
  if (list.version === 'whole' || !Array.isArray(stored)) {
    return stored;
  }
  const owned = [list.idKey, ...Object.keys(list.fields)];
  return (stored as unknown[]).map((item) => (isPlain(item) ? Object.fromEntries(owned.filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]])) : item));
}

/**
 * Whether a stored list can be written: every item is an object with a usable id, no two items of a list have the same id, and the same holds for every list inside the items (the tables of
 * a room). An item without an id cannot be addressed and a repeated id cannot be told apart, so a write of the list would drop or merge items: the list is then not writable at all, and
 * the callers refuse it instead of losing data. A list that is missing is writable.
 *
 * @param def The definition of the items.
 * @param stored The stored value of the list.
 * @param idKey The key of the id.
 */
export function isEditable(def: ItemDef, stored: unknown, idKey = 'id'): boolean {
  if (!Array.isArray(stored)) {
    return true;
  }
  const seen = new Set<string>();
  return (stored as unknown[]).every((item) => {
    const key = itemKey(item, idKey);
    if (key === undefined || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return Object.entries(def.fields).every(([name, kind]) => kind.t !== 'list' || isEditable(kind.item, (item as Document)[name], idKey));
  });
}
