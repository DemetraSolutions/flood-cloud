import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';

/** Most places the availability of a department or a brand may name. */
export const MAX_AVAILABILITY_PLACES = 200;

/** Most refused ids reported in the details of one refused request. */
const MAX_REPORTED = 20;

/**
 * The place ids of a stored `placesAvailability`, read tolerantly: the hexadecimal form of every `ObjectId`, without repetitions and in order. Anything else in the list is anomalous: it is not a place,
 * is never shown and never counts as one. (A company or place administrator cannot write an entry that has any, and the list a write sends replaces the stored one as a whole.)
 *
 * @param raw The stored value, of any type.
 * @returns The ids.
 */
export function placeIdsOf(raw: unknown): string[] {
  return [...new Set((Array.isArray(raw) ? (raw as unknown[]) : []).flatMap((item) => (item instanceof ObjectId ? [item.toHexString()] : [])))];
}

/**
 * The places a company or place administrator may name, as computed by the server in his scope; `null` for the roles that are not limited to places (platform administrator, dealer, group administrator).
 *
 * @param principal The authenticated caller.
 */
export function perimeterOf(principal: AuthPrincipal): ReadonlySet<string> | null {
  const { scope } = principal;
  return scope.kind === 'companies' || scope.kind === 'places' ? new Set(scope.placeIds.map((id) => id.toHexString())) : null;
}

/**
 * The filter of what a caller reaches: nothing is held back from the roles that are not limited to places; a company or place administrator reaches the entries with no place (every place) and
 * the ones that name a place of his perimeter. Combine it with the filter of the request (`$and`).
 *
 * @param principal The authenticated caller.
 */
export function visibleTo(principal: AuthPrincipal): Filter<Document> {
  const allowed = perimeterOf(principal);
  if (allowed === null) {
    return {};
  }
  const ids = [...allowed];
  return {
    $or: [
      { placesAvailability: { $exists: false } },
      { placesAvailability: null },
      { placesAvailability: { $size: 0 } },
      { placesAvailability: { $in: ids.map((id) => ObjectId.createFromHexString(id)) } },
    ],
  };
}

/**
 * The place ids the caller is shown: all of them for the roles that are not limited to places, only the ones of the perimeter for a company or place administrator (the other ones are
 * stored and kept, never shown).
 *
 * @param principal The authenticated caller.
 * @param raw The stored `placesAvailability`.
 */
export function shownPlaceIds(principal: AuthPrincipal, raw: unknown): string[] {
  const allowed = perimeterOf(principal);
  const ids = placeIdsOf(raw);
  return allowed === null ? ids : ids.filter((id) => allowed.has(id));
}

/** The new availability of an entry, and the places that have to be verified to exist. */
export interface PlacesWrite {
  /** The value to store in `placesAvailability`. */
  readonly value: unknown[];
  /** The places of the request that the entry did not name yet. */
  readonly added: readonly string[];
}

/**
 * Works out the availability a new or modified entry will have. A company or place administrator names only places of his perimeter, at least one (an entry for every place is not his to make):
 * `placeIds` is the whole new list. (An entry he may modify names only places of his perimeter already, see {@link isWritablePlaces}, so nothing outside it is ever left behind.)
 *
 * @param principal The authenticated caller.
 * @param stored The stored `placesAvailability` (`undefined` for a new entry).
 * @param requested The ids of the request, hexadecimal and without repetitions.
 * @returns The value to store and the ids to verify.
 * @throws {AppError} `FORBIDDEN` with `placeIds.<index>` `notAllowed` for each id outside the perimeter, or `placeIds` `notAllowed` when the entry would have no place.
 */
export function placesWrite(principal: AuthPrincipal, stored: unknown, requested: readonly string[]): PlacesWrite {
  const allowed = perimeterOf(principal);
  const current = new Set(placeIdsOf(stored));
  const added = requested.filter((id) => !current.has(id));
  if (allowed !== null) {
    const outside: ErrorDetail[] = requested.flatMap((id, index) => (allowed.has(id) ? [] : [{ field: `placeIds.${String(index)}`, issue: 'notAllowed' }]));
    if (outside.length === 0 && requested.length === 0) {
      outside.push({ field: 'placeIds', issue: 'notAllowed' });
    }
    if (outside.length > 0) {
      throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED) });
    }
  }
  return { value: requested.map((id) => ObjectId.createFromHexString(id)), added };
}

/**
 * Whether the caller may modify or delete an entry: always for the roles that are not limited to places; a company or place administrator only when the entry names places, all of them
 * ObjectIds inside his perimeter (an entry for every place, one shared with places outside it, or one with anomalous elements is read only to him).
 *
 * @param principal The authenticated caller.
 * @param stored The stored `placesAvailability`.
 */
export function isWritablePlaces(principal: AuthPrincipal, stored: unknown): boolean {
  const allowed = perimeterOf(principal);
  if (allowed === null) {
    return true;
  }
  const list = Array.isArray(stored) ? (stored as unknown[]) : [];
  const ids = placeIdsOf(list);
  return list.length > 0 && ids.length === list.length && ids.every((id) => allowed.has(id));
}

/**
 * Refuses to a company or place administrator the modification or the deletion of an entry that is not his ({@link isWritablePlaces}).
 *
 * @param principal The authenticated caller.
 * @param stored The stored `placesAvailability`.
 * @throws {AppError} `FORBIDDEN`.
 */
export function assertWritablePlaces(principal: AuthPrincipal, stored: unknown): void {
  if (!isWritablePlaces(principal, stored)) {
    throw new AppError('FORBIDDEN');
  }
}
