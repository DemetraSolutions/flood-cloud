import { listQueryShape } from '../../shared/http/list.ts';
import { MAX_DAY_SLOTS, MAX_SPECIAL_DAYS } from '../../shared/legacy-write/fields.ts';
import { WEEK_DAYS } from '../../shared/legacy-write/place-paths.ts';
import { array, boolean, email, enumOf, isoDate, nullable, object, objectId, optional, record, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';
import { addressSchema, emptyAsNull, partial, required } from '../companies/companies.schemas.ts';
import type { Part } from '../companies/companies.schemas.ts';
import { lookupIds } from '../group-lookup/lookup.schemas.ts';
import { settingsSchema } from './place-settings.schemas.ts';
import { SETTING_BLOCKS } from '../../shared/legacy-write/place-settings.ts';
import { PLACES_LIST } from './places.list.ts';
import type { PlaceCreation, PlacePatch } from './place.types.ts';

/**
 * Body limit of every write of a place: the hours of the week and of the delivery with their special days (at most {@link MAX_SPECIAL_DAYS} each, {@link MAX_DAY_SLOTS} slots a day) are
 * the largest part of the document the step 7A writes.
 */
export const PLACES_BODY_LIMIT = '256kb';

/** Most price lists a place can enable (a group has at most {@link MAX_PRICE_LISTS_PER_PLACE}). */
export const MAX_PRICE_LISTS_PER_PLACE = 50;

/** The five plans a license can be given; a place may also hold a historical one, which is read and sent back as it is. */
export const PLANS = Object.freeze(['basic', 'advanced', 'enterprice', 'tgm-secondary', 'desk-secondary'] as const);

/** The id of a price list: what a path segment can carry. */
const listId = () => emptyAsNull(nullable(string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ })));

/**
 * The invoice series of a place: the name of a series of the company, `null` (or `''`) for none, or `false`, which a place has where the legacy stored it so (the service accepts it
 * only unchanged). A text is trimmed.
 */
function invoiceSeriesSchema(): Schema<string | false | null, true> {
  const name = emptyAsNull(nullable(string({ max: 50, trim: true })));
  return optional({ optional: false, parse: (value, path, context, depth) => (value === false ? false : name.parse(value, path, context, depth)) });
}

/** A price list of the place in a request: the id, and the all-you-can-eat settings (`false` and `null` when left out). */
const placePriceList = () =>
  object({
    id: string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ }),
    allYouCanEat: optional(boolean()),
    ayceCode1: optional(emptyAsNull(nullable(string({ max: 30, trim: true })))),
    ayceCode2: optional(emptyAsNull(nullable(string({ max: 30, trim: true })))),
  });

/** The enabled price lists of a place: unique ids, at most {@link MAX_PRICE_LISTS_PER_PLACE}; the service completes the elements. */
function priceListsSchema() {
  return refine(
    transform(
      array(placePriceList(), { max: MAX_PRICE_LISTS_PER_PLACE }),
      (items) => items.map((item) => ({ id: item.id, allYouCanEat: item.allYouCanEat ?? false, ayceCode1: item.ayceCode1 ?? null, ayceCode2: item.ayceCode2 ?? null })),
      'incorrect',
    ),
    (items) => items.flatMap((item, index) => (items.findIndex((other) => other.id === item.id) === index ? [] : [`${String(index)}.id`])),
    'incorrect',
  );
}

/** A time of a slot: a text of at most five characters. That it is a time (`HH:mm`) is checked by the service, and only where it changes. */
const slotTime = () => string({ max: 5, trim: true });

/** The time slots of a day: at most {@link MAX_DAY_SLOTS}, each a start and an end. */
const slots = () => array(object({ start: slotTime(), end: slotTime() }), { max: MAX_DAY_SLOTS });

/** The hours of the week: the seven days `0` to `6`, each with its flag and its slots, all of them required (the week is replaced whole). */
const weekSchema = () =>
  object(Object.fromEntries(WEEK_DAYS.map((day) => [day, object({ active: boolean(), values: slots() })])) as Record<(typeof WEEK_DAYS)[number], Schema<{ active: boolean; values: Array<{ start: string; end: string }> }>>);

/** The special days by date (`YYYY-MM-DD`; that the date exists is checked by the service, where it changes): at most {@link MAX_SPECIAL_DAYS}. */
const specialSchema = () => record(object({ closed: boolean(), values: slots() }), { max: MAX_SPECIAL_DAYS, key: /^\d{4}-\d{2}-\d{2}$/ });

/** The hours of a schedule: the week and the special days. */
function scheduleSchema(part: Part) {
  return object({ week: part(weekSchema()), special: part(specialSchema()) });
}

/**
 * The license block: the plan (any text: which values may be set depends on the role and is decided by the service; a historical one is sent back as it is), the end of the license,
 * the state and the Sentry switch. As a whole block (PUT) every key is required, so what a GET returns can be sent back.
 */
export function licenseSchema(part: Part): Schema<NonNullable<PlacePatch['license']>> {
  return object({
    plan: part(nullable(string({ max: 30, trim: true }))),
    expirationDate: part(nullable(transform(isoDate(), (date) => date.toISOString(), 'format'))),
    status: part(enumOf(['active', 'disabled'] as const)),
    sentry: part(boolean()),
  }) as unknown as Schema<NonNullable<PlacePatch['license']>>;
}

/** The opening hours block: the time zone (checked by the service where it changes), the hours of the week and of the delivery. As a whole block (PUT) every key is required. */
export function openingHoursSchema(part: Part): Schema<NonNullable<PlacePatch['openingHours']>> {
  return object({
    timezone: part(string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_+\-/]+$/ })),
    week: part(weekSchema()),
    special: part(specialSchema()),
    deliveryTime: part(scheduleSchema(part)),
  }) as unknown as Schema<NonNullable<PlacePatch['openingHours']>>;
}

/** The general fields and the blocks of a place, each as required (`part` is {@link required}) or optional ({@link partial}). */
function placeShape(part: Part, creation: boolean) {
  return {
    name: part(string({ min: 1, max: 150, trim: true })),
    companyId: part(objectIdText()),
    address: creation ? addressSchema(required) : optional(addressSchema(partial)),
    contactName: optional(emptyAsNull(nullable(string({ max: 100, trim: true })))),
    email: optional(emptyAsNull(nullable(email()))),
    phone: optional(emptyAsNull(nullable(string({ max: 30, trim: true })))),
    priceListId: optional(listId()),
    ecommercePriceListId: optional(listId()),
    invoiceSeries: invoiceSeriesSchema(),
    priceLists: optional(priceListsSchema()),
    license: optional(licenseSchema(partial)),
    openingHours: optional(openingHoursSchema(partial)),
    ...Object.fromEntries(Object.keys(SETTING_BLOCKS).map((name) => [name, optional(settingsSchema(name, partial))])),
  };
}

/** The id of a company as a request carries it: the 24 hexadecimal characters of an id (that it is a company of the group is checked by the service). */
const objectIdText = () => string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ });

/** Body of `POST /v1/groups/{groupId}/places`: the name, the company and the address and, optionally, any other field or block (a block with only some of its keys keeps the defaults of the rest). */
export const createPlaceBody = object(placeShape(required, true)) as unknown as Schema<PlaceCreation>;

/** Body of `PATCH /v1/groups/{groupId}/places/{placeId}`: any subset of the fields and of the blocks, each block any subset of its fields (the lists and the weeks are replaced whole). */
export const patchPlaceBody = object(placeShape(partial, false)) as unknown as Schema<PlacePatch>;

/** Body of `PUT …/license`: the whole block. */
export const putLicenseBody = licenseSchema(required);

/** Body of `PUT …/opening-hours`: the whole block. */
export const putOpeningHoursBody = openingHoursSchema(required);

const trashed = () => optional(enumOf(['true', 'false'] as const));

/**
 * Query of `GET /v1/groups/{groupId}/places`: the standard list parameters (the search `q` looks in the name and the city), the `trashed` filter, `companyId`, `ids` (1-100
 * comma-separated ObjectIds), `status`, `plan` (the plan as stored), `country` (ISO alpha-2) and `province`.
 */
export const placesQuery = object({
  ...listQueryShape(PLACES_LIST),
  trashed: trashed(),
  companyId: optional(objectId()),
  ids: lookupIds,
  status: optional(enumOf(['active', 'disabled'] as const)),
  plan: optional(string({ min: 1, max: 30, trim: true, pattern: /^[A-Za-z0-9_-]+$/ })),
  country: optional(string({ min: 2, max: 2, pattern: /^[A-Z]{2}$/ })),
  province: optional(string({ min: 1, max: 10, trim: true })),
});

/** Validated query of the place list. */
export type PlacesQuery = Infer<typeof placesQuery>;

/** Path parameters of the routes on one place; the group was already verified by the route. */
export const placeParams = object({ placeId: objectId() }, { allowUnknown: true });
