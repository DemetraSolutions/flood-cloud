import { Int32, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { flagOf, integerOf, isRecord, textOf } from '../groups/catalogs/kit.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { plainOf } from '../product-categories/categories.mapper.ts';

/** Most places the availability of a product may name (the places of a group). */
export const MAX_PRODUCT_PLACES = 200;

/** Most refused ids reported in the details of one refused request. */
const MAX_REPORTED = 20;

/** One place a product is available in, in the domain form. */
export interface ProductPlace {
  /** Id of the place, hexadecimal. */
  readonly placeId: string;
  /** The product is a favorite of the cash register of the place. */
  readonly favorite: boolean;
  /** The product is a favorite of the handheld terminals of the place. */
  readonly favoriteHandheld: boolean;
  /** Position of the product among the ones of that place, `null` for none. */
  readonly position: number | null;
  /** Id of the production center of the place the product is made in, `null` for none. */
  readonly productionCenterId: string | null;
}

/** What a stored `placesAvailability` holds. */
export interface StoredProductPlaces {
  /** The places, in order, without repetitions. */
  readonly entries: readonly ProductPlace[];
  /** How many elements the stored list has, anomalous ones included. */
  readonly length: number;
  /** Whether the list holds an element that is not a place (a number, a text, an object without an `ObjectId` `id`): it is kept, never shown, and makes the product read only to a company or place administrator. */
  readonly anomalous: boolean;
  /** Whether some element is in the form the oldest clients wrote (a plain `ObjectId`): writing the places rewrites the list in the current form. */
  readonly historical: boolean;
}

/** The id of the place an element of a stored list names (`ObjectId` itself or an object with an `ObjectId` `id`), `null` for anything else. */
function placeIdOfElement(element: unknown): string | null {
  if (element instanceof ObjectId) {
    return element.toHexString();
  }
  return isRecord(element) && element['id'] instanceof ObjectId ? element['id'].toHexString() : null;
}

/**
 * Reads a stored `placesAvailability` tolerantly. The current form is a list of `{ id, favorite, favoriteHandheld, position, productionCenterId }`; the historical one a list of `ObjectId` (read as a place that is
 * not a favorite, with no position and no production center). Anything else in the list is anomalous: it is not a place and is never shown. A place named twice counts once (the first element).
 *
 * @param raw The stored value, of any type.
 */
export function productPlacesOf(raw: unknown): StoredProductPlaces {
  const list = Array.isArray(raw) ? (raw as unknown[]) : [];
  const entries: ProductPlace[] = [];
  const seen = new Set<string>();
  let anomalous = false;
  let historical = false;
  for (const element of list) {
    const placeId = placeIdOfElement(element);
    if (placeId === null) {
      anomalous = true;
    } else if (!seen.has(placeId)) {
      seen.add(placeId);
      if (element instanceof ObjectId) {
        historical = true;
        entries.push({ placeId, favorite: false, favoriteHandheld: false, position: null, productionCenterId: null });
      } else {
        const record = element as Document;
        entries.push({ placeId, favorite: flagOf(record['favorite']), favoriteHandheld: flagOf(record['favoriteHandheld']), position: integerOf(plainOf(record['position'])), productionCenterId: textOf(record['productionCenterId']) });
      }
    }
  }
  return { entries, length: list.length, anomalous, historical };
}

/**
 * The places the caller is shown: all of them for the roles that are not limited to places, only the ones of the perimeter for a company or place administrator (the other ones are stored and kept, never shown).
 *
 * @param principal The authenticated caller.
 * @param raw The stored `placesAvailability`.
 */
export function shownProductPlaces(principal: AuthPrincipal, raw: unknown): ProductPlace[] {
  const allowed = perimeterOf(principal);
  const { entries } = productPlacesOf(raw);
  return allowed === null ? [...entries] : entries.filter((entry) => allowed.has(entry.placeId));
}

/**
 * Whether a company or place administrator reaches a product: the product is for every place (no list, `null`, an empty list) or names a place of his perimeter, in either form of the list. The other roles reach every product.
 *
 * @param principal The authenticated caller.
 * @param raw The stored `placesAvailability`.
 */
export function isVisibleProduct(principal: AuthPrincipal, raw: unknown): boolean {
  const allowed = perimeterOf(principal);
  if (allowed === null) {
    return true;
  }
  // For every place only when the list is missing, `null` or empty (the filter of the database says the same): anything else that is not a list is not "for every place".
  if (raw === undefined || raw === null) {
    return true;
  }
  if (!Array.isArray(raw)) {
    return false;
  }
  const list = raw as unknown[];
  return list.length === 0 || list.some((element) => {
    const placeId = placeIdOfElement(element);
    return placeId !== null && allowed.has(placeId);
  });
}

/**
 * Whether the caller may modify, trash and delete a product as a whole: always for the roles that are not limited to places; a company or place administrator only when the product names places, none of them
 * anomalous and all inside his perimeter (a product for every place, one shared with places outside it, or one with anomalous elements) gives him only his own place data).
 *
 * @param principal The authenticated caller.
 * @param raw The stored `placesAvailability`.
 */
export function isEditableProduct(principal: AuthPrincipal, raw: unknown): boolean {
  const allowed = perimeterOf(principal);
  if (allowed === null) {
    return true;
  }
  const stored = productPlacesOf(raw);
  return stored.length > 0 && !stored.anomalous && stored.entries.every((entry) => allowed.has(entry.placeId));
}

/**
 * The stored list of a new availability. The roles that are not limited to places replace the list with the requested places; a company or place administrator replaces only the places of his perimeter and the
 * elements outside it (and the anomalous ones) stay. An element of a place the product already had keeps every other key it had.
 *
 * @param principal The authenticated caller.
 * @param stored The stored `placesAvailability`, of any type.
 * @param requested The places of the request.
 * @returns The list to store.
 */
export function productPlacesDocument(principal: AuthPrincipal, stored: unknown, requested: readonly ProductPlace[]): Document[] {
  const allowed = perimeterOf(principal);
  const raw = Array.isArray(stored) ? (stored as unknown[]) : [];
  const current = new Map<string, Document>();
  for (const element of raw) {
    if (isRecord(element) && element['id'] instanceof ObjectId) {
      current.set(element['id'].toHexString(), element as Document);
    }
  }
  const kept = allowed === null ? [] : (raw.filter((element) => {
    const placeId = placeIdOfElement(element);
    return placeId === null || !allowed.has(placeId);
  }) as Document[]);
  const replaced = requested.map((entry) => ({
    ...current.get(entry.placeId),
    id: ObjectId.createFromHexString(entry.placeId),
    favorite: entry.favorite,
    favoriteHandheld: entry.favoriteHandheld,
    position: entry.position === null ? null : new Int32(entry.position),
    productionCenterId: entry.productionCenterId,
  }));
  return [...kept, ...replaced];
}

/**
 * Refuses a company or place administrator the places outside his perimeter, and an availability that ends up with no place at all (a product for every place is not his to make).
 *
 * @param principal The authenticated caller.
 * @param requested The places of the request.
 * @param resulting How many places the product has afterwards (the ones outside his perimeter that stay included).
 * @throws {AppError} `FORBIDDEN` with `places.<index>.placeId` `notAllowed` for each place outside the perimeter, or `places` `notAllowed` when the list would be empty.
 */
export function assertPlacesInPerimeter(principal: AuthPrincipal, requested: readonly string[], resulting: number): void {
  const allowed = perimeterOf(principal);
  if (allowed === null) {
    return;
  }
  const outside: ErrorDetail[] = requested.flatMap((id, index) => (allowed.has(id) ? [] : [{ field: `places.${String(index)}.placeId`, issue: 'notAllowed' }]));
  if (outside.length === 0 && resulting === 0) {
    outside.push({ field: 'places', issue: 'notAllowed' });
  }
  if (outside.length > 0) {
    throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED) });
  }
}

/**
 * Whether the places of a product are the ones a write would store, whatever the order of the elements (a write that changes nothing must not rewrite them).
 *
 * @param stored The stored `placesAvailability`.
 * @param next The list a write would store.
 */
export function samePlaces(stored: unknown, next: readonly Document[]): boolean {
  const before = productPlacesOf(stored);
  const after = productPlacesOf(next);
  const sorted = (entries: readonly ProductPlace[]): string => JSON.stringify([...entries].sort((a, b) => (a.placeId < b.placeId ? -1 : 1)));
  return before.length === after.length && !before.historical && sorted(before.entries) === sorted(after.entries);
}
