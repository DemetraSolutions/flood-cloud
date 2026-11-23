import { Double, Int32, ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { integerOf, isRecord, textOf } from '../groups/catalogs/kit.ts';
import { isForEveryPlace, ownsEveryPlace, perimeterOf } from '../product-catalog/availability.ts';

/** Most places the availability of a category may name. */
export const MAX_CATEGORY_PLACES = 200;

/** Most refused ids reported in the details of one refused request. */
const MAX_REPORTED = 20;

/** One place a category is available in, in the domain form. */
export interface PlaceEntry {
  /** Id of the place, hexadecimal. */
  readonly placeId: string;
  /** Position of the category among the ones of that place, `null` for none. */
  readonly position: number | null;
  /** Id of the production center of the place the products of the category are made in, `null` for none. */
  readonly productionCenterId: string | null;
}

/** What a stored `placesAvailability` holds. */
export interface StoredPlaces {
  /** The places, in order, without repetitions. */
  readonly entries: readonly PlaceEntry[];
  /** How many elements the stored list has, anomalous ones included. */
  readonly length: number;
  /** Whether the list holds an element that is not a place (a number, a text, an object without an `ObjectId` `id`): it is kept, never shown, and makes the category read only to a company or place administrator. */
  readonly anomalous: boolean;
  /** Whether some element is in the form the oldest clients wrote (a plain `ObjectId`): saving the category rewrites the list in the current form. */
  readonly historical: boolean;
}

/** A number as `Int32`/`Double` wrapper or plain number, read as a plain one. */
const plain = (raw: unknown): unknown => (raw instanceof Int32 || raw instanceof Double ? raw.valueOf() : raw);

/**
 * Reads a stored `placesAvailability` tolerantly. The current form is a list of `{ id: ObjectId, position, productionCenterId }`; the historical one a list of `ObjectId` (read as a place with no
 * position and no production center). Anything else in the list is anomalous: it is not a place and is never shown. A place named twice counts once (the first element).
 *
 * @param raw The stored value, of any type.
 */
export function placesOf(raw: unknown): StoredPlaces {
  const list = Array.isArray(raw) ? (raw as unknown[]) : [];
  const entries: PlaceEntry[] = [];
  const seen = new Set<string>();
  let anomalous = false;
  let historical = false;
  for (const element of list) {
    let entry: PlaceEntry | null = null;
    if (element instanceof ObjectId) {
      historical = true;
      entry = { placeId: element.toHexString(), position: null, productionCenterId: null };
    } else if (isRecord(element) && element['id'] instanceof ObjectId) {
      entry = { placeId: element['id'].toHexString(), position: integerOf(plain(element['position'])), productionCenterId: textOf(element['productionCenterId']) };
    }
    if (entry === null) {
      anomalous = true;
    } else if (!seen.has(entry.placeId)) {
      seen.add(entry.placeId);
      entries.push(entry);
    }
  }
  return { entries, length: list.length, anomalous, historical };
}

/**
 * The filter of what a caller reaches: nothing is held back from the roles that are not limited to places; a company or place administrator reaches the categories with no place (every place)
 * and the ones that name a place of his perimeter, in the current form of the list or in the historical one.
 *
 * @param principal The authenticated caller.
 */
export function categoriesVisibleTo(principal: CatalogCaller): Filter<Document> {
  const allowed = perimeterOf(principal);
  if (allowed === null) {
    return {};
  }
  const ids = [...allowed].map((id) => ObjectId.createFromHexString(id));
  return { $or: [{ placesAvailability: { $exists: false } }, { placesAvailability: null }, { placesAvailability: { $size: 0 } }, { 'placesAvailability.id': { $in: ids } }, { placesAvailability: { $in: ids } }] };
}

/**
 * The places the caller is shown: all of them for the roles that are not limited to places, only the ones of the perimeter for a company or place administrator (the other ones are stored
 * and kept, never shown).
 *
 * @param principal The authenticated caller.
 * @param raw The stored `placesAvailability`.
 */
export function shownPlaces(principal: CatalogCaller, raw: unknown): PlaceEntry[] {
  const allowed = perimeterOf(principal);
  const { entries } = placesOf(raw);
  return allowed === null ? [...entries] : entries.filter((entry) => allowed.has(entry.placeId));
}

/**
 * Whether the caller may modify or delete a category: always for the roles that are not limited to places; a company or place administrator (or the server of a point of sale) only when the category names places, none of them
 * anomalous and all inside his perimeter (a category for every place, one shared with places outside it, or one with anomalous elements is read only to him), unless the group has one place only (`ownsEveryPlace`): a category for every place is then wholly his.
 *
 * @param principal The authenticated caller.
 * @param raw The stored `placesAvailability`.
 */
export function isWritableCategory(principal: CatalogCaller, raw: unknown): boolean {
  const allowed = perimeterOf(principal);
  if (allowed === null || (ownsEveryPlace(principal) && isForEveryPlace(raw))) {
    return true;
  }
  const stored = placesOf(raw);
  return stored.length > 0 && !stored.anomalous && stored.entries.every((entry) => allowed.has(entry.placeId));
}

/**
 * Refuses to a company or place administrator the modification or the deletion of a category that is not his.
 *
 * @param principal The authenticated caller.
 * @param raw The stored `placesAvailability`.
 * @throws {AppError} `FORBIDDEN`.
 */
export function assertWritableCategory(principal: CatalogCaller, raw: unknown): void {
  if (!isWritableCategory(principal, raw)) {
    throw new AppError('FORBIDDEN');
  }
}

/**
 * Refuses a company or place administrator the places outside his perimeter, and an availability with no place at all (a category for every place is not his to make, unless the group has one place only).
 *
 * @param principal The authenticated caller.
 * @param requested The places of the request.
 * @param field The field of the request the places are in, for the details.
 * @throws {AppError} `FORBIDDEN` with `<field>.<index>.placeId` `notAllowed` for each place outside the perimeter, or `<field>` `notAllowed` when the list is empty.
 */
export function assertPlacesInPerimeter(principal: CatalogCaller, requested: readonly string[], field: string): void {
  const allowed = perimeterOf(principal);
  if (allowed === null) {
    return;
  }
  const outside: ErrorDetail[] = requested.flatMap((id, index) => (allowed.has(id) ? [] : [{ field: `${field}.${String(index)}.placeId`, issue: 'notAllowed' }]));
  if (outside.length === 0 && requested.length === 0 && !ownsEveryPlace(principal)) {
    outside.push({ field, issue: 'notAllowed' });
  }
  if (outside.length > 0) {
    throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED) });
  }
}

/**
 * The stored list of a new availability: the current form, `{ id, position, productionCenterId }`; a place the category already had keeps every other key its element had.
 *
 * @param stored The stored `placesAvailability`, of any type.
 * @param requested The places of the request.
 */
export function placesDocument(stored: unknown, requested: readonly PlaceEntry[]): Document[] {
  const current = new Map<string, Document>();
  for (const element of Array.isArray(stored) ? (stored as unknown[]) : []) {
    if (isRecord(element) && element['id'] instanceof ObjectId) {
      current.set(element['id'].toHexString(), element as Document);
    }
  }
  return requested.map((entry) => ({
    ...current.get(entry.placeId),
    id: ObjectId.createFromHexString(entry.placeId),
    position: entry.position === null ? null : new Int32(entry.position),
    productionCenterId: entry.productionCenterId,
  }));
}

/**
 * The stored list a save rewrites in the current form when the category has the historical one: every `ObjectId` becomes `{ id, position: null, productionCenterId: null }`, the other elements stay.
 *
 * @param stored The stored `placesAvailability`, a list.
 */
export function modernPlaces(stored: unknown[]): unknown[] {
  return stored.map((element) => (element instanceof ObjectId ? { id: element, position: null, productionCenterId: null } : element));
}
