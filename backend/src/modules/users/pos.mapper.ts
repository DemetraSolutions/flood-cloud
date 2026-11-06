import { isDeepStrictEqual } from 'node:util';
import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  DISCOUNT_CAP_KEY,
  POS_BOOLEAN_OPTIONS,
  POS_FLAGS,
  POS_FONT_SIZES,
  POS_GRID_ZOOMS,
  POS_HANDHELD_COLUMNS,
  POS_KEYBOARDS,
  POS_LEGACY_KEY,
  POS_PRICE_LISTS_PATH,
  POS_ROOT,
  POS_SIDES,
  POS_TABLE_COLUMNS,
  POS_TEMPLATES,
  SERVICE_PERCENTAGE_KEY,
  defaultOptions,
  emptyPos,
  isOneOf,
} from './pos.catalog.ts';
import type { AutomaticCash, Pos, PosGrants, PosGrantsPatch, PosOptions, PosOptionsPatch, PosPatch, PosPriceList } from './pos.catalog.ts';
import type { UserAnomaly } from './user.types.ts';

/** Most price lists read from the map of a user (a group has at most 50). */
export const MAX_POS_PRICE_LISTS = 200;

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const child = (raw: unknown, key: string): unknown => (isRecord(raw) ? raw[key] : undefined);

/** Reads a stored value of the POS and remembers what is wrong with it. */
class PosReader {
  readonly anomalies: UserAnomaly[];

  constructor(anomalies: UserAnomaly[]) {
    this.anomalies = anomalies;
  }

  private wrong(field: string): void {
    this.anomalies.push({ kind: 'invalidType', field });
  }

  /** A boolean: only `true` is true; absent and `null` are false without a remark, any other non-boolean is false and reported. */
  flag(raw: unknown, field: string): boolean {
    if (raw !== undefined && raw !== null && typeof raw !== 'boolean') {
      this.wrong(field);
    }
    return raw === true;
  }

  /** A percentage from 0 to 100; absent and `null` mean none, anything else out of range is reported and read as none. */
  percentage(raw: unknown, field: string): number | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100) {
      return raw;
    }
    this.wrong(field);
    return null;
  }

  /** A string; absent and `null` mean none. */
  text(raw: unknown, field: string): string | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw === 'string' && raw !== '') {
      return raw;
    }
    this.wrong(field);
    return null;
  }

  /** One of a list of values, compared as they are; an absent value gives the fallback without a remark, an unknown one with. */
  choice<const T extends readonly unknown[]>(list: T, raw: unknown, fallback: T[number], field: string): T[number] {
    if (raw === undefined || raw === null) {
      return fallback;
    }
    if (isOneOf(list, raw)) {
      return raw;
    }
    this.wrong(field);
    return fallback;
  }

  /** The sizes of the legacy select: lower case, but the legacy also left the upper case `'S'` as a fallback. */
  fontSize(raw: unknown, field: string): (typeof POS_FONT_SIZES)[number] {
    return this.choice(POS_FONT_SIZES, typeof raw === 'string' ? raw.toLowerCase() : raw, 's', field);
  }

  /** A number of columns: a number, or a string of digits (322 documents in production), among the allowed ones; `null` otherwise. */
  columns<const T extends readonly number[]>(list: T, raw: unknown, field: string): T[number] | null {
    const value = typeof raw === 'string' && /^\d{1,2}$/.test(raw) ? Number(raw) : raw;
    const allowed: readonly (number | null)[] = [...list, null];
    return this.choice(allowed, value, null, field) as T[number] | null;
  }
}

function readAutomaticCash(sub: unknown, reader: PosReader): AutomaticCash {
  const stored = child(sub, 'automaticCash');
  return Object.fromEntries(
    AUTOMATIC_CASH_DEVICES.map((device) => [
      device,
      Object.fromEntries(AUTOMATIC_CASH[device].map((key) => [key, reader.flag(child(child(stored, device), key), `${POS_ROOT}.sub.automaticCash.${device}.${key}`)])),
    ]),
  ) as AutomaticCash;
}

function readGrants(sub: unknown, reader: PosReader): PosGrants {
  const flags = Object.fromEntries(POS_FLAGS.map((flag) => [flag, reader.flag(child(sub, POS_LEGACY_KEY[flag]), `${POS_ROOT}.sub.${POS_LEGACY_KEY[flag]}`)])) as { [K in (typeof POS_FLAGS)[number]]: boolean };
  return {
    ...flags,
    discountMaxPercentage: reader.percentage(child(sub, DISCOUNT_CAP_KEY), `${POS_ROOT}.sub.${DISCOUNT_CAP_KEY}`),
    servicePercentage: reader.percentage(child(sub, SERVICE_PERCENTAGE_KEY), `${POS_ROOT}.sub.${SERVICE_PERCENTAGE_KEY}`),
    automaticCash: readAutomaticCash(sub, reader),
  };
}

function readPriceLists(raw: unknown, reader: PosReader): PosPriceList[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!isRecord(raw)) {
    reader.anomalies.push({ kind: 'invalidType', field: POS_PRICE_LISTS_PATH });
    return [];
  }
  const lists: PosPriceList[] = [];
  for (const [priceListId, entry] of Object.entries(raw)) {
    if (isRecord(entry)) {
      lists.push({ priceListId, enabled: entry['status'] === true, isDefault: entry['selected'] === true });
    } else {
      reader.anomalies.push({ kind: 'invalidType', field: `${POS_PRICE_LISTS_PATH}.${priceListId}` });
    }
  }
  if (lists.length > MAX_POS_PRICE_LISTS) {
    reader.anomalies.push({ kind: 'invalidType', field: POS_PRICE_LISTS_PATH });
  }
  return lists.slice(0, MAX_POS_PRICE_LISTS);
}

function readOptions(options: unknown, reader: PosReader): PosOptions {
  const at = (key: string): string => `${POS_ROOT}.options.${key}`;
  const flags = Object.fromEntries(POS_BOOLEAN_OPTIONS.map((option) => [option, reader.flag(child(options, option), at(option))])) as { [K in (typeof POS_BOOLEAN_OPTIONS)[number]]: boolean };
  const defaults = defaultOptions();
  return {
    ...flags,
    favoritesId: reader.text(child(options, 'favoritesId'), at('favoritesId')),
    side: reader.choice(POS_SIDES, child(options, 'side'), defaults.side, at('side')),
    sideRooms: reader.choice(POS_SIDES, child(options, 'sideRooms'), defaults.sideRooms, at('sideRooms')),
    virtualKeyboard: reader.choice(POS_KEYBOARDS, child(options, 'virtualKeyboard'), defaults.virtualKeyboard, at('virtualKeyboard')),
    // The old profiles have `null`, not a template.
    template: reader.choice([...POS_TEMPLATES, null] as const, child(options, 'template'), null, at('template')),
    productsFontSize: reader.fontSize(child(options, 'productsFontSize'), at('productsFontSize')),
    productsShortNameFontSize: reader.fontSize(child(options, 'productsShortNameFontSize'), at('productsShortNameFontSize')),
    roomsTablesColumns: reader.columns(POS_TABLE_COLUMNS, child(options, 'roomsTablesColumns'), at('roomsTablesColumns')),
    roomsTablesColumnsHandheld: reader.columns(POS_HANDHELD_COLUMNS, child(options, 'roomsTablesColumnsHandheld'), at('roomsTablesColumnsHandheld')),
    roomsGridZoomHandheld: reader.choice(POS_GRID_ZOOMS, child(options, 'roomsGridZoomHandheld'), defaults.roomsGridZoomHandheld, at('roomsGridZoomHandheld')),
    quickDiscount: reader.percentage(child(options, 'quickDiscount'), at('quickDiscount')),
    defaultPriceListId: reader.text(child(options, 'defaultPriceListId'), at('defaultPriceListId')),
    priceLists: readPriceLists(child(options, 'priceLists'), reader),
  };
}

/**
 * Reads the POS data of a user out of the stored `permissions` value, tolerantly: whatever is missing or irregular takes the default (everything
 * off), and what was wrong is reported in `anomalies`. The keys the domain does not show (`sub.productsStatus`, `sub.deleteTableProductReason`,
 * `options.service`) are not read and are never written, so they stay in the document.
 *
 * @param permissions The stored `permissions` value, of unknown shape.
 * @param anomalies Receives what is wrong with the stored value.
 * @returns The POS data.
 */
export function readPos(permissions: unknown, anomalies: UserAnomaly[]): Pos {
  const cash = child(child(permissions, 'apps'), 'cash');
  if (cash === undefined || cash === null) {
    return emptyPos();
  }
  if (!isRecord(cash)) {
    anomalies.push({ kind: 'invalidType', field: POS_ROOT });
    return emptyPos();
  }
  const reader = new PosReader(anomalies);
  return {
    enabled: reader.flag(cash['status'], `${POS_ROOT}.status`),
    grants: readGrants(cash['sub'], reader),
    options: readOptions(cash['options'], reader),
  };
}

function mergeAutomaticCash(base: AutomaticCash, patch: PosGrantsPatch['automaticCash']): AutomaticCash {
  return Object.fromEntries(AUTOMATIC_CASH_DEVICES.map((device) => [device, { ...base[device], ...patch?.[device] }])) as AutomaticCash;
}

/** Copies the properties of a patch that are present (a value of `undefined` is "not sent"). */
function definedOf<T extends object>(patch: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/**
 * Applies a POS patch to the current data: only the values the patch carries change; `priceLists`, when present, is the whole list.
 *
 * @param base The data before.
 * @param patch The patch, if any.
 * @returns The data after.
 */
export function applyPosPatch(base: Pos, patch: PosPatch | undefined): Pos {
  const grants = definedOf<PosGrantsPatch>(patch?.grants);
  return {
    enabled: patch?.enabled ?? base.enabled,
    grants: { ...base.grants, ...grants, automaticCash: mergeAutomaticCash(base.grants.automaticCash, grants.automaticCash) } as PosGrants,
    options: { ...base.options, ...definedOf<PosOptionsPatch>(patch?.options) } as PosOptions,
  };
}

/**
 * The values that differ between two states of the POS data, as a patch (empty parts are left out).
 *
 * @param before The data before.
 * @param after The data after.
 * @returns The differences, or `undefined` when the data are the same.
 */
export function diffPos(before: Pos, after: Pos): PosPatch | undefined {
  const grants: Record<string, unknown> = {};
  for (const flag of POS_FLAGS) {
    if (before.grants[flag] !== after.grants[flag]) {
      grants[flag] = after.grants[flag];
    }
  }
  for (const key of ['discountMaxPercentage', 'servicePercentage'] as const) {
    if (before.grants[key] !== after.grants[key]) {
      grants[key] = after.grants[key];
    }
  }
  const automaticCash: Record<string, Record<string, boolean>> = {};
  for (const device of AUTOMATIC_CASH_DEVICES) {
    for (const key of AUTOMATIC_CASH[device]) {
      const now = (after.grants.automaticCash[device] as Record<string, boolean>)[key]!;
      if ((before.grants.automaticCash[device] as Record<string, boolean>)[key] !== now) {
        (automaticCash[device] ??= {})[key] = now;
      }
    }
  }
  if (Object.keys(automaticCash).length > 0) {
    grants['automaticCash'] = automaticCash;
  }
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after.options)) {
    if (!isDeepStrictEqual((before.options as Record<string, unknown>)[key], value)) {
      options[key] = value;
    }
  }
  const patch: { enabled?: boolean; grants?: PosGrantsPatch; options?: PosOptionsPatch } = {};
  if (before.enabled !== after.enabled) {
    patch.enabled = after.enabled;
  }
  if (Object.keys(grants).length > 0) {
    patch.grants = grants as PosGrantsPatch;
  }
  if (Object.keys(options).length > 0) {
    patch.options = options as PosOptionsPatch;
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/**
 * The legacy map of the price lists of a user.
 *
 * @param lists The price lists of the user.
 * @returns The legacy map keyed by price list id.
 */
export function legacyPriceLists(lists: readonly PosPriceList[]): Record<string, { status: boolean; selected: boolean }> {
  return Object.fromEntries(lists.map((list) => [list.priceListId, { status: list.enabled, selected: list.isDefault }]));
}

/**
 * The `$set` paths of a POS patch: one path for each value that changes (`permissions.apps.cash.sub.discount`…), so the keys of the document that the
 * backend does not manage are never touched. The price lists are written as the whole map.
 *
 * @param patch What changes.
 * @returns Stored path to value.
 */
export function posSetPaths(patch: PosPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.enabled !== undefined) {
    set[`${POS_ROOT}.status`] = patch.enabled;
  }
  const grants = definedOf<PosGrantsPatch>(patch.grants);
  for (const [name, value] of Object.entries(grants)) {
    if (name === 'automaticCash') {
      for (const [device, keys] of Object.entries(value as object)) {
        for (const [key, flag] of Object.entries(keys as object)) {
          set[`${POS_ROOT}.sub.automaticCash.${device}.${key}`] = flag;
        }
      }
    } else {
      const legacy = name === 'discountMaxPercentage' ? DISCOUNT_CAP_KEY : name === 'servicePercentage' ? SERVICE_PERCENTAGE_KEY : POS_LEGACY_KEY[name as (typeof POS_FLAGS)[number]];
      set[`${POS_ROOT}.sub.${legacy}`] = value;
    }
  }
  for (const [name, value] of Object.entries(definedOf<PosOptionsPatch>(patch.options))) {
    set[`${POS_ROOT}.options.${name}`] = name === 'priceLists' ? legacyPriceLists(value as PosPriceList[]) : value;
  }
  return set;
}

/**
 * The complete `permissions.apps.cash` object of a new user, with every key the legacy form emits (all grants and all device flags present, off or
 * `null`) so that the legacy backoffice and the POS find what they expect.
 *
 * @param pos The POS data of the new user.
 */
export function posDocument(pos: Pos): Record<string, unknown> {
  const { priceLists, defaultPriceListId, ...options } = pos.options;
  return {
    status: pos.enabled,
    sub: {
      ...Object.fromEntries(POS_FLAGS.map((flag) => [POS_LEGACY_KEY[flag], pos.grants[flag]])),
      [DISCOUNT_CAP_KEY]: pos.grants.discountMaxPercentage,
      [SERVICE_PERCENTAGE_KEY]: pos.grants.servicePercentage,
      automaticCash: Object.fromEntries(AUTOMATIC_CASH_DEVICES.map((device) => [device, { ...pos.grants.automaticCash[device] }])),
    },
    // The price list the POS started with is a trace the POS writes, never part of a new document.
    options: { ...options, ...(defaultPriceListId === null ? {} : { defaultPriceListId }), priceLists: legacyPriceLists(priceLists) },
  };
}
