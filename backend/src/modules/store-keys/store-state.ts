import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { groupMirror, trustedGroupMirror } from '../../shared/security/scope/group-mirror.ts';
import type { GroupsRepository } from '../../shared/security/scope/groups.repository.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { placesScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';

/** What the state of a store key's place says about the request. */
export type StoreAssessment =
  /** The place is operational: the company it belongs to now. */
  | { readonly kind: 'ok'; readonly companyId: ObjectId }
  /** The group does not exist: the key is as good as unknown. */
  | { readonly kind: 'unauthenticated' }
  /** The key is good, the store is not operational for now (group suspended or trashed, place disabled, license over, company in the trash): `403 STORE_DISABLED`, nothing is revoked, it resumes by itself. */
  | { readonly kind: 'blocked' }
  /** The place is in the trash or no longer exists: the key ends. */
  | { readonly kind: 'revoke'; readonly reason: 'placeTrashed' | 'placeDeleted' };

/** The place a PSA or a dealer is about to manage the key of. */
export interface ManagedPlace {
  readonly companyId: ObjectId;
  readonly operational: boolean;
}

/** Reads the state a store key depends on. */
export interface StoreStateReader {
  /**
   * Decides, from the stored state, what a request of a store key may do (`doc/Security-Model.md` section 5): the group, then the place (copy in the common database), then the company
   * of the place now. A place that is not an object with a valid company counts as not operational: a broken document is a block, never a crash and never a pass.
   *
   * @param groupId Group of the key.
   * @param placeId Place of the key.
   * @param now Current time, to compare with the end of the license.
   */
  assess(groupId: ObjectId, placeId: ObjectId, now: Date): Promise<StoreAssessment>;
  /**
   * The place of a group the caller was verified to reach, for the routes that manage its key: `null` when it does not exist, is in the trash or is outside the perimeter (one and the same `404`).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param placeId Id of the place.
   * @param now Current time.
   * @returns Its company and whether the place is operational now (a code cannot be made for one that is not).
   */
  managedPlace(principal: ScopeHolder, access: GroupAccess, placeId: ObjectId, now: Date): Promise<ManagedPlace | null>;
}

/** The fields the state of a place is read from. */
const PLACE_STATE = { trash: 1, status: 1, companyId: 1, expirationDate: 1 } as const;

/**
 * Whether a place copy is operational: active (`status` exactly `true`), license not over (`expirationDate` a date not past; none means no end), and with a company id.
 */
function placeUsable(place: Record<string, unknown>, now: Date): boolean {
  const expiration = place['expirationDate'];
  const over = expiration instanceof Date && expiration.getTime() <= now.getTime();
  return place['status'] === true && !over && place['companyId'] instanceof ObjectId;
}

/**
 * Builds the reader of the state of a store key.
 *
 * @param deps The group lookup and the database accessor (the copies of places and companies are read through the copy gate, group by group).
 */
export function createStoreStateReader(deps: { readonly groups: Pick<GroupsRepository, 'findAccess'>; readonly databases: Databases }): StoreStateReader {
  const { groups, databases } = deps;
  /** The state of a company copy is blocked when it is in the trash or missing. */
  const companyBlocked = async (groupId: ObjectId, companyId: ObjectId): Promise<boolean> => {
    const [company] = await trustedGroupMirror(groupId, databases, 'companies').find({ _id: companyId }, { projection: { trash: 1 }, limit: 1 });
    return company === undefined || company['trash'] === true;
  };
  return {
    assess: async (groupId, placeId, now) => {
      const group = await groups.findAccess(groupId);
      if (group === null) {
        return { kind: 'unauthenticated' };
      }
      if (group.availability === 'unavailable') {
        return { kind: 'blocked' };
      }
      const [place] = await trustedGroupMirror(groupId, databases, 'places').find({ _id: placeId }, { projection: PLACE_STATE, limit: 1 });
      if (place === undefined) {
        return { kind: 'revoke', reason: 'placeDeleted' };
      }
      if (place['trash'] === true) {
        return { kind: 'revoke', reason: 'placeTrashed' };
      }
      if (!placeUsable(place, now) || (await companyBlocked(groupId, place['companyId'] as ObjectId))) {
        return { kind: 'blocked' };
      }
      return { kind: 'ok', companyId: place['companyId'] as ObjectId };
    },

    managedPlace: async (principal, access, placeId, now) => {
      const [place] = await groupMirror(principal, access, databases, 'places').find(withScope(placesScopeFilter(principal.scope), { _id: placeId, trash: { $ne: true } }), {
        projection: PLACE_STATE,
        limit: 1,
      });
      if (place === undefined) {
        return null;
      }
      const companyId = place['companyId'] as ObjectId | undefined;
      return { companyId: companyId as ObjectId, operational: placeUsable(place, now) && !(await companyBlocked(access.groupId, companyId as ObjectId)) };
    },
  };
}
