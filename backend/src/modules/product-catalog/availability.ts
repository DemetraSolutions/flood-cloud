import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { groupMirror } from '../../shared/security/scope/group-mirror.ts';
import { activeGroupPlaceIds } from '../../shared/security/scope/group-places.ts';
import type { CatalogCaller } from './caller.ts';

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
 * The places a company or place administrator may name, as computed by the server in his scope, or the one place of a store key; `null` for the roles that are not limited to places (platform administrator,
 * dealer, group administrator). The server of a point of sale is limited exactly as a place administrator of its place.
 *
 * @param principal The caller.
 */
export function perimeterOf(principal: CatalogCaller): ReadonlySet<string> | null {
  const { scope } = principal;
  if (scope.kind === 'store') {
    return new Set([scope.placeId.toHexString()]);
  }
  return scope.kind === 'companies' || scope.kind === 'places' ? new Set(scope.placeIds.map((id) => id.toHexString())) : null;
}

/**
 * Whether an availability is the one of an entry for every place: the list is missing, `null` or empty (the same entries the filter of the database reads as "for every place").
 *
 * @param raw The stored `placesAvailability`.
 */
export function isForEveryPlace(raw: unknown): boolean {
  return raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0);
}

/**
 * Whether the entries "for every place" are wholly the caller's own: the group has exactly one place that is not in the trash and the caller is limited to it (a company or place administrator, or the
 * server of that point of sale). Set on the caller by {@link withSoleLocation}, never by a request; with two or more places (or none the caller reaches) it is `false` and the rules of the places
 * of the perimeter apply as they always did. It lets such a caller modify an entry for every place as a whole and create one, and it changes nothing for the roles that are not limited to places.
 *
 * @param principal The caller.
 */
export function ownsEveryPlace(principal: CatalogCaller): boolean {
  return principal.soleLocation === true && perimeterOf(principal) !== null;
}

/** The reader of how many places a group has, for {@link withSoleLocation}. */
export interface PlaceCounter {
  /**
   * The ids of the places of the group that are not in the trash, at most two, read from **both** sources (the `places` of the group database and the copy in the common database): the ids when the
   * two agree on exactly one place, `null` in every other case (two or more places, none, a different place in each, a failed read): then the rules of two places apply. One bounded read of each, made
   * on every call, nothing is kept between calls.
   *
   * @param caller The caller.
   * @param access Verified access to the group.
   */
  soleActivePlaceId(caller: CatalogCaller, access: GroupAccess): Promise<ObjectId | null>;
}

/**
 * Builds the reader of the places of a group. The rule of the group with one place hands an entry for every place to a caller, so it fails closed: the copies in the common database are only as
 * fresh as the last `sync:copies` (a place created by the legacy has none), so the count must come out the same from the group database too, and with the same place.
 *
 * @param databases Database accessor.
 */
export function createPlaceCounter(databases: Databases): PlaceCounter {
  return {
    soleActivePlaceId: async (caller, access) => {
      const [original, copy] = await Promise.all([
        activeGroupPlaceIds(caller, access, databases),
        bounded(() => groupMirror(caller, access, databases, 'places').find({ trash: { $ne: true } }, { projection: { _id: 1 }, limit: 2, sort: { _id: 1 } })),
      ]);
      return original.length === 1 && copy.length === 1 && original[0]!.equals(copy[0]!['_id'] as ObjectId) ? original[0]! : null;
    },
  };
}

/**
 * Wraps a service of the catalog (every operation of which takes the caller and the group access first) so that each call is made with the caller marked `soleLocation` when the rule of
 * {@link ownsEveryPlace} holds: the group has exactly one place that is not in the trash and it is in the caller's perimeter. This is the only place that decides it, and it decides it on every
 * call from a fresh read, so the roles that are not limited to places pay nothing and the others see a second place at once.
 *
 * @param service The service; each of its functions takes `(caller, access, ...rest)`.
 * @param places The reader of the places.
 * @param logger Where a failed read is reported (the caller then gets the rules of two places).
 * @returns A service with the same shape.
 */
export function withSoleLocation<S extends object>(service: S, places: PlaceCounter, logger: Logger): S {
  const resolve = async (caller: CatalogCaller, access: GroupAccess): Promise<CatalogCaller> => {
    const allowed = perimeterOf(caller);
    if (allowed === null) {
      return caller;
    }
    const sole = await places.soleActivePlaceId(caller, access).catch((error: unknown) => {
      // Fail closed: a read that fails is a group that is not known to have one place only.
      logger.error('reading the places of a group failed, the rules of two or more places apply', { error });
      return null;
    });
    return sole !== null && allowed.has(sole.toHexString()) ? { ...caller, soleLocation: true } : caller;
  };
  const wrapped = Object.entries(service).map(([name, operation]) => [
    name,
    typeof operation === 'function' ? async (caller: CatalogCaller, access: GroupAccess, ...rest: unknown[]) => (operation as (...args: unknown[]) => unknown)(await resolve(caller, access), access, ...rest) : operation,
  ]);
  return Object.fromEntries(wrapped) as S;
}

/**
 * The filter of what a caller reaches: nothing is held back from the roles that are not limited to places; a company or place administrator reaches the entries with no place (every place) and
 * the ones that name a place of his perimeter. Combine it with the filter of the request (`$and`).
 *
 * @param principal The authenticated caller.
 */
export function visibleTo(principal: CatalogCaller): Filter<Document> {
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
export function shownPlaceIds(principal: CatalogCaller, raw: unknown): string[] {
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
 * Works out the availability a new or modified entry will have. A company or place administrator names only places of his perimeter, at least one (an entry for every place is not his to make, unless the group has one place only, {@link ownsEveryPlace}):
 * `placeIds` is the whole new list. (An entry he may modify names only places of his perimeter already, see {@link isWritablePlaces}, so nothing outside it is ever left behind.)
 *
 * @param principal The authenticated caller.
 * @param stored The stored `placesAvailability` (`undefined` for a new entry).
 * @param requested The ids of the request, hexadecimal and without repetitions.
 * @returns The value to store and the ids to verify.
 * @throws {AppError} `FORBIDDEN` with `placeIds.<index>` `notAllowed` for each id outside the perimeter, or `placeIds` `notAllowed` when the entry would have no place.
 */
export function placesWrite(principal: CatalogCaller, stored: unknown, requested: readonly string[]): PlacesWrite {
  const allowed = perimeterOf(principal);
  const current = new Set(placeIdsOf(stored));
  const added = requested.filter((id) => !current.has(id));
  if (allowed !== null) {
    const outside: ErrorDetail[] = requested.flatMap((id, index) => (allowed.has(id) ? [] : [{ field: `placeIds.${String(index)}`, issue: 'notAllowed' }]));
    if (outside.length === 0 && requested.length === 0 && !ownsEveryPlace(principal)) {
      outside.push({ field: 'placeIds', issue: 'notAllowed' });
    }
    if (outside.length > 0) {
      throw new AppError('FORBIDDEN', { details: outside.slice(0, MAX_REPORTED) });
    }
  }
  return { value: requested.map((id) => ObjectId.createFromHexString(id)), added };
}

/**
 * Whether the caller may modify or delete an entry: always for the roles that are not limited to places; a company or place administrator (or the server of a point of sale) only when the entry names places, all of them
 * ObjectIds inside his perimeter (an entry for every place, one shared with places outside it, or one with anomalous elements is read only to him), unless the group has one place only ({@link ownsEveryPlace}), which makes an
 * entry for every place wholly his.
 *
 * @param principal The authenticated caller.
 * @param stored The stored `placesAvailability`.
 */
export function isWritablePlaces(principal: CatalogCaller, stored: unknown): boolean {
  const allowed = perimeterOf(principal);
  if (allowed === null || (ownsEveryPlace(principal) && isForEveryPlace(stored))) {
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
export function assertWritablePlaces(principal: CatalogCaller, stored: unknown): void {
  if (!isWritablePlaces(principal, stored)) {
    throw new AppError('FORBIDDEN');
  }
}
