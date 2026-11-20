import { INVALID, array, boolean, enumOf, isoDate, nullable, number, object, optional, string } from '../../shared/validation/schema.ts';
import type { Schema } from '../../shared/validation/schema.ts';
import { checkAvatar } from './avatar.ts';
import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  POS_BOOLEAN_OPTIONS,
  POS_CATEGORIES_LAYOUTS,
  POS_CATEGORIES_ROWS,
  POS_COLOR_STYLES,
  POS_FLAGS,
  POS_FONT_SIZES,
  POS_GRID_ZOOMS,
  POS_HANDHELD_COLUMNS,
  POS_KEYBOARDS,
  POS_MENU_POSITIONS,
  POS_PRODUCTS_COLUMNS,
  POS_SIDES,
  POS_TABLE_COLUMNS,
  POS_TEMPLATES,
  POS_TEXT_ZOOMS,
} from './pos.catalog.ts';
import type { PosGrantsPatch, PosOptionsPatch, PosPatch } from './pos.catalog.ts';
import { MAX_SHIFT_SLOTS, MAX_SHIFT_SPECIAL_DAYS, MAX_SHIFT_WEEKS, SHIFT_DAYS, SHIFT_TIME_PATTERN } from './shift-time.ts';
import type { ShiftTimePatch, ShiftWeekInput } from './shift-time.ts';

/** Fields the schemas of the user's own data share between `/v1/users`, `/v1/groups/{groupId}/users` and `/v1/me`. */

/** Longest free text of a user. */
export const MAX_DESCRIPTION = 1000;

/** Most services a user can provide. */
export const MAX_SERVICE_IDS = 200;

/** Most price lists in the POS options of a user (a group has at most 50). */
export const MAX_POS_LISTS = 50;

/** Ids of the lists of a group (price lists, favorites): the characters the group catalogs generate. */
const LIST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A schema built by hand. */
function custom<T>(parse: Schema<T, false>['parse']): Schema<T, false> {
  return Object.freeze({ optional: false as const, parse });
}

/**
 * The picture of a user: a data URL of a PNG, JPEG or WebP image of at most 200 KB, whose real type (from its magic bytes) is the declared one.
 * A value that is not a string is a `type` problem, a picture that is too big `maximum`, anything else `format`.
 */
export function avatarSchema(): Schema<string, false> {
  return custom((value, path, context) => {
    if (typeof value !== 'string') {
      return context.report(path, 'type');
    }
    const checked = checkAvatar(value);
    return checked.ok ? value : context.report(path, checked.issue);
  });
}

/** The PIN of a user: 3 to 6 digits, kept exactly as sent. */
export function pinSchema(): Schema<string, false> {
  return string({ min: 3, max: 6, pattern: /^[0-9]{3,6}$/, normalize: false });
}

/** The free text of a user. */
export function descriptionSchema(): Schema<string, false> {
  return string({ max: MAX_DESCRIPTION, trim: true });
}

/** A number among the listed ones; any other is an `enum` problem. */
function numberOf<const T extends readonly number[]>(allowed: T): Schema<T[number], false> {
  return custom((value, path, context) => {
    if (typeof value !== 'number') {
      return context.report(path, 'type');
    }
    return (allowed as readonly number[]).includes(value) ? (value as T[number]) : context.report(path, 'enum');
  });
}

type Shape = Record<string, Schema<unknown>>;

/** An object schema built from a shape computed at run time, typed by the caller. */
function shaped<T>(shape: Shape): Schema<T, false> {
  return object(shape) as unknown as Schema<T, false>;
}

const percentage = () => optional(nullable(number({ min: 0, max: 100 })));

/** The grants of the POS: every flag optional, the two percentages and the flags of the automatic cash devices. */
function grantsSchema(): Schema<PosGrantsPatch, false> {
  const flag = () => optional(boolean());
  const automaticCash = shaped<NonNullable<PosGrantsPatch['automaticCash']>>(
    Object.fromEntries(AUTOMATIC_CASH_DEVICES.map((device) => [device, optional(shaped(Object.fromEntries(AUTOMATIC_CASH[device].map((key) => [key, flag()]))))])),
  );
  return shaped<PosGrantsPatch>({
    ...Object.fromEntries(POS_FLAGS.map((name) => [name, flag()])),
    discountMaxPercentage: percentage(),
    servicePercentage: percentage(),
    automaticCash: optional(automaticCash),
  });
}

/**
 * The interface preferences of the POS (`options`). With `personal` set, the schema is the one a user has on himself (`/v1/me`): the price lists
 * he can use are decided by the administrators, so `priceLists` and `defaultPriceListId` are not accepted.
 *
 * @param personal Whether the schema is for the user's own preferences.
 */
export function posOptionsSchema(personal = false): Schema<PosOptionsPatch, false> {
  const listId = () => string({ min: 1, max: 64, pattern: LIST_ID, normalize: false });
  const shape: Shape = {
    ...Object.fromEntries(POS_BOOLEAN_OPTIONS.map((name) => [name, optional(boolean())])),
    favoritesId: optional(nullable(listId())),
    side: optional(enumOf(POS_SIDES)),
    sideRooms: optional(enumOf(POS_SIDES)),
    virtualKeyboard: optional(enumOf(POS_KEYBOARDS)),
    template: optional(nullable(enumOf(POS_TEMPLATES))),
    productsFontSize: optional(enumOf(POS_FONT_SIZES)),
    productsShortNameFontSize: optional(enumOf(POS_FONT_SIZES)),
    roomsTablesColumns: optional(nullable(numberOf(POS_TABLE_COLUMNS))),
    roomsTablesColumnsHandheld: optional(nullable(numberOf(POS_HANDHELD_COLUMNS))),
    roomsGridZoomHandheld: optional(numberOf(POS_GRID_ZOOMS)),
    productsColorStyle: optional(enumOf(POS_COLOR_STYLES)),
    handheldTextZoom: optional(numberOf(POS_TEXT_ZOOMS)),
    handheldCategoriesLayout: optional(enumOf(POS_CATEGORIES_LAYOUTS)),
    handheldCategoriesRows: optional(numberOf(POS_CATEGORIES_ROWS)),
    handheldProductsColumns: optional(numberOf(POS_PRODUCTS_COLUMNS)),
    handheldMenuPosition: optional(enumOf(POS_MENU_POSITIONS)),
    quickDiscount: percentage(),
    ...(personal
      ? {}
      : {
          defaultPriceListId: optional(nullable(listId())),
          priceLists: optional(array(object({ priceListId: listId(), enabled: boolean(), isDefault: boolean() }), { max: MAX_POS_LISTS })),
        }),
  };
  return shaped<PosOptionsPatch>(shape);
}

/** The POS part of a creation or a modification: the app switch, the grants (permissions) and the preferences. */
export function posSchema(): Schema<PosPatch, false> {
  return shaped<PosPatch>({ enabled: optional(boolean()), grants: optional(grantsSchema()), options: optional(posOptionsSchema()) });
}

/** The POS part a user may change on himself: the preferences only. */
export function personalPosSchema(): Schema<{ options?: PosOptionsPatch }, false> {
  return shaped<{ options?: PosOptionsPatch }>({ options: optional(posOptionsSchema(true)) });
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date, `YYYY-MM-DD`, that exists (a date with a time, or an impossible day, is a `format` problem). */
function dateSchema(): Schema<string, false> {
  const iso = isoDate();
  return custom((value, path, context, depth) => {
    if (typeof value !== 'string') {
      return context.report(path, 'type');
    }
    if (!CALENDAR_DATE.test(value)) {
      return context.report(path, 'format');
    }
    return iso.parse(value, path, context, depth) === INVALID ? INVALID : value;
  });
}

const slotsSchema = () =>
  array(object({ start: string({ max: 5, pattern: SHIFT_TIME_PATTERN, normalize: false }), end: string({ max: 5, pattern: SHIFT_TIME_PATTERN, normalize: false }) }), { max: MAX_SHIFT_SLOTS });

const daySchema = () => object({ active: boolean(), slots: slotsSchema() });

/**
 * The shifts of a user: the switch, the list of week blocks and the list of special days, the last two replaced as a whole when sent.
 * The consistency between the values (slot order, overlaps) is checked by `shiftTimeIssues`.
 */
export function shiftTimeSchema(): Schema<ShiftTimePatch, false> {
  const week = object({
    from: optional(nullable(isoDate())),
    to: optional(nullable(isoDate())),
    days: shaped<ShiftWeekInput['days']>(Object.fromEntries(SHIFT_DAYS.map((key) => [key, optional(daySchema())]))),
  });
  return shaped<ShiftTimePatch>({
    enabled: optional(boolean()),
    weeks: optional(array(week, { max: MAX_SHIFT_WEEKS })),
    specialDays: optional(array(object({ date: dateSchema(), dayOff: boolean(), slots: slotsSchema() }), { max: MAX_SHIFT_SPECIAL_DAYS })),
  });
}
