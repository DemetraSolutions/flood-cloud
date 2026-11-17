import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { WEEK_DAYS } from '../../shared/legacy-write/place-paths.ts';
import { flag, instant, isPlain, nonEmptyOrNull, optionalText, readLeaves, status, stringOrNull, text } from '../companies/company.mapper.ts';
import type { Codec, Leaf } from '../companies/company.mapper.ts';
import { LIST_LEAVES } from './place-lists.mapper.ts';
import { SETTING_LEAVES } from './place-settings.mapper.ts';
import type { Place, PlacePriceList, PlaceSummary, SpecialDays, WeekHours } from './place.types.ts';

/** A key of the special days of the document: `YYYY-MM-DD`. Any other key of the stored map is one the backend keeps untouched and never returns. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The id of a document as the 24 characters of its hexadecimal form, `null` when the stored value is not an `ObjectId`. */
const idOrNull = (value: unknown): string | null => (value instanceof ObjectId ? value.toHexString() : null);

/** The id of a company: read as its hexadecimal form (`null` when the document holds anything but an `ObjectId`), written as an `ObjectId`. */
const companyRef: Codec = { read: idOrNull, write: (value) => ObjectId.createFromHexString(value as string) };

/**
 * The invoice series of the place (`invoicePS`): the name as it is, `false` where the legacy stored it so, `null` for none (`null`, `''` or any other value). A write is
 * the value as it is: the service has checked it.
 */
const invoiceSeries: Codec = { read: (value) => (value === false ? false : nonEmptyOrNull(value)), write: (value) => value };

/** The time slots of a day, read item by item: what is not an object with a start and an end of text is left out. */
const slotsOf = (value: unknown): Array<{ start: string; end: string }> =>
  (Array.isArray(value) ? (value as unknown[]) : []).filter(isPlain).flatMap((slot) => (typeof slot['start'] === 'string' && typeof slot['end'] === 'string' ? [{ start: slot['start'], end: slot['end'] }] : []));

/** The slots of a day in the form the document holds them. */
const storedSlots = (slots: ReadonlyArray<{ readonly start: string; readonly end: string }>): Array<{ start: string; end: string }> => slots.map(({ start, end }) => ({ start, end }));

/**
 * The opening hours of the week (`weekGeneric`): the seven days `0` (Sunday) to `6`, each `{ active, values }`; a day the document lacks, or holds with the wrong shape, is
 * closed with no slot. A write sets the seven days and keeps any other key the stored object has.
 */
const week: Codec = {
  read: (value) =>
    Object.fromEntries(
      WEEK_DAYS.map((day) => {
        const entry = isPlain(value) ? value[day] : undefined;
        return [day, { active: isPlain(entry) && entry['active'] === true, values: isPlain(entry) ? slotsOf(entry['values']) : [] }];
      }),
    ),
  write: (value, stored) => ({
    ...(isPlain(stored) ? stored : {}),
    ...Object.fromEntries(WEEK_DAYS.map((day) => [day, { active: (value as WeekHours)[day].active, values: storedSlots((value as WeekHours)[day].values) }])),
  }),
};

/**
 * The special days (`daySpecial`) by date: `{ closed, values }` of every entry whose key is a date and whose value is an object. A write sets the days of the value and drops the
 * dates it does not have (that is how a day is removed), but keeps every entry of the stored map whose key is not a date.
 */
const special: Codec = {
  read: (value) =>
    Object.fromEntries(
      Object.entries(isPlain(value) ? value : {}).flatMap(([date, entry]) => (DAY_KEY.test(date) && isPlain(entry) ? [[date, { closed: entry['closed'] === true, values: slotsOf(entry['values']) }]] : [])),
    ),
  write: (value, stored) => ({
    ...Object.fromEntries(Object.entries(isPlain(stored) ? stored : {}).filter(([key]) => !DAY_KEY.test(key))),
    ...Object.fromEntries(Object.entries(value as SpecialDays).map(([date, day]) => [date, { closed: day.closed, values: storedSlots(day.values) }])),
  }),
};

/** The price lists of the place (`general.priceLists`): `{ id, allYouCanEat, ayceCode1, ayceCode2 }` of every element that is an object with an id of text; the others are left out. */
const priceLists: Codec = {
  read: (value) =>
    (Array.isArray(value) ? (value as unknown[]) : [])
      .filter(isPlain)
      .flatMap((item) =>
        typeof item['id'] === 'string' ? [{ id: item['id'], allYouCanEat: item['allYouCanEat'] === true, ayceCode1: nonEmptyOrNull(item['ayceCode1']), ayceCode2: nonEmptyOrNull(item['ayceCode2']) }] : [],
      ),
  write: (value) => (value as PlacePriceList[]).map((item) => ({ id: item.id, allYouCanEat: item.allYouCanEat, ayceCode1: item.ayceCode1, ayceCode2: item.ayceCode2 })),
};

/**
 * Every key of the place, domain and stored, in the order the representation is built: the general data, the license and the opening hours. It is the only table of the mapping:
 * the read, the comparison with a request and the choice of the keys to write all follow it. The settings blocks of step 7B are added here, with their schemas and their `PUT` routes.
 */
export const PLACE_LEAVES: readonly Leaf[] = Object.freeze([
  { domain: 'name', legacy: 'name', codec: text },
  { domain: 'companyId', legacy: 'companyId', codec: companyRef },
  { domain: 'address.street', legacy: 'address', codec: text },
  { domain: 'address.postcode', legacy: 'postcode', codec: text },
  { domain: 'address.city', legacy: 'city', codec: text },
  { domain: 'address.province', legacy: 'countryAreaCode', codec: text },
  { domain: 'address.country', legacy: 'countryCode', codec: text },
  { domain: 'contactName', legacy: 'contact', codec: optionalText },
  { domain: 'email', legacy: 'email', codec: optionalText },
  { domain: 'phone', legacy: 'telephone', codec: optionalText },
  { domain: 'priceListId', legacy: 'listId', codec: optionalText },
  { domain: 'ecommercePriceListId', legacy: 'ecommerceListId', codec: optionalText },
  { domain: 'invoiceSeries', legacy: 'invoicePS', codec: invoiceSeries },
  { domain: 'priceLists', legacy: 'general.priceLists', codec: priceLists },
  { domain: 'trashed', legacy: 'trash', codec: flag, readOnly: true },
  { domain: 'trashedAt', legacy: 'trashDate', codec: instant, readOnly: true },
  { domain: 'createdAt', legacy: 'insertDate', codec: instant, readOnly: true },
  { domain: 'updatedAt', legacy: 'updateDate', codec: instant, readOnly: true },
  { domain: 'license.plan', legacy: 'plan', codec: text },
  { domain: 'license.expirationDate', legacy: 'expirationDate', codec: instant },
  { domain: 'license.status', legacy: 'status', codec: status },
  { domain: 'openingHours.timezone', legacy: 'timezone', codec: text },
  { domain: 'openingHours.week', legacy: 'openingTime.weekGeneric', codec: week },
  { domain: 'openingHours.special', legacy: 'openingTime.daySpecial', codec: special },
  { domain: 'openingHours.deliveryTime.week', legacy: 'delivery.time.weekGeneric', codec: week },
  { domain: 'openingHours.deliveryTime.special', legacy: 'delivery.time.daySpecial', codec: special },
  // The settings blocks (step 7B), the integrations and the dealer settings (step 7F), from the table of `place-settings.ts`.
  ...SETTING_LEAVES,
  // The lists of items (step 7F): the devices, the print stations and production centers, the rooms and the storages.
  ...LIST_LEAVES,
]);

/**
 * Maps a stored place to its representation: every key by its codec, so a value that is missing or has the wrong type is `null` (or the neutral value of its kind: `false`, `[]`, a
 * closed week) and the read never fails, not even on the null registry data the legacy leaves on a place it trashed. Keys the backend does not know, and everything that is not
 * in the representation (the `info` and `status` of a device, the `subtables` of a room, a credential, whatever a later release adds), are not in the result.
 *
 * @param document The place as stored, read with the exact types (`Int32` and `Double` wrappers are tolerated).
 * @param groupId The group the place was read from (the verified one, not the stored `groupId`).
 * @returns The place.
 */
export function toPlace(document: Document, groupId: ObjectId): Place {
  const place: Record<string, unknown> = { id: idOrNull(document['_id']) ?? '', groupId: groupId.toHexString() };
  readLeaves(PLACE_LEAVES, document, place);
  return place as unknown as Place;
}

/** The fields the list reads from the copies, the only ones ever loaded for it. */
export const PLACE_SUMMARY_PROJECTION = Object.freeze({ name: 1, trash: 1, trashDate: 1, companyId: 1, plan: 1, status: 1, city: 1, countryAreaCode: 1, countryCode: 1, expirationDate: 1 } as const);

/**
 * Maps a document of the copies (read with the list projection) to a compact list item. A value that is missing or has the wrong type is `null` (the name `''`, the status
 * `disabled` unless it is exactly `true`).
 *
 * @param document The projected place.
 */
export function toPlaceSummary(document: Document): PlaceSummary {
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    name: stringOrNull(document['name']) ?? '',
    companyId: idOrNull(document['companyId']),
    trashed: document['trash'] === true,
    trashedAt: instant.read(document['trashDate']) as string | null,
    plan: stringOrNull(document['plan']),
    status: document['status'] === true ? 'active' : 'disabled',
    city: stringOrNull(document['city']),
    province: stringOrNull(document['countryAreaCode']),
    country: stringOrNull(document['countryCode']),
    expirationDate: instant.read(document['expirationDate']) as string | null,
  };
}
