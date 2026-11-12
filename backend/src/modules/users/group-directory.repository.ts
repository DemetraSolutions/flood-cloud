import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { groupMirror } from '../../shared/security/scope/group-mirror.ts';
import { companiesScopeFilter, placesScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';

/** A place of a group, as far as the placement of a user is concerned. */
export interface PlaceRef {
  readonly id: ObjectId;
  /** The company the place belongs to, or `null` when the document has none. */
  readonly companyId: ObjectId | null;
}

/** What user management needs to know about the group a user is created in. */
export interface GroupDirectoryRepository {
  /**
   * The dealer of a group (`groups.dealerId`), copied to the users created in it.
   *
   * @param groupId Id of the group (from a verified access).
   * @returns The dealer's user id, or `null` when the group has none or does not exist.
   */
  findDealerId(groupId: ObjectId): Promise<ObjectId | null>;
  /**
   * Tells whether a user is the dealer of some group, trashed or suspended ones included.
   *
   * @param userId Id of the dealer user.
   */
  isDealerOfAnyGroup(userId: ObjectId): Promise<boolean>;
  /**
   * Which of the given companies exist in the group (in the copies), are not in the trash and are inside the caller's
   * perimeter (the scope filter of the caller is applied): any other is simply not among the results.
   *
   * @param principal The authenticated caller.
   * @param access The verified access to the group.
   * @param ids Candidate company ids (at most a few dozen: the request schema bounds them).
   * @returns The ids found.
   */
  findCompanies(principal: AuthPrincipal, access: GroupAccess, ids: readonly ObjectId[]): Promise<ObjectId[]>;
  /**
   * Which of the given places exist in the group, are not in the trash and are inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access The verified access to the group.
   * @param ids Candidate place ids.
   * @returns The places found, with their company.
   */
  findPlaces(principal: AuthPrincipal, access: GroupAccess, ids: readonly ObjectId[]): Promise<PlaceRef[]>;
}

/**
 * Builds the group directory over `common.groups` and the copies `common.companies` and `common.places`,
 * which are read only through `groupMirror` (a verified group access). Read only, ids and company references only.
 *
 * @param databases Database accessor.
 */
export function createGroupDirectoryRepository(databases: Databases): GroupDirectoryRepository {
  return {
    findDealerId: async (groupId) => {
      const group = await databases.common().collection('groups').findOne({ _id: groupId }, { projection: { dealerId: 1 }, maxTimeMS: LIST_MAX_TIME_MS });
      return group?.['dealerId'] instanceof ObjectId ? group['dealerId'] : null;
    },

    isDealerOfAnyGroup: async (userId) =>
      (await databases.common().collection('groups').findOne({ dealerId: userId }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS })) !== null,

    findCompanies: async (principal, access, ids) => {
      if (ids.length === 0) {
        return [];
      }
      const companies = await groupMirror(principal, access, databases, 'companies').find(withScope(companiesScopeFilter(principal.scope), { _id: { $in: [...ids] }, trash: { $ne: true } }), {
        projection: { _id: 1 },
        limit: ids.length,
      });
      return companies.map((company) => company._id);
    },

    findPlaces: async (principal, access, ids) => {
      if (ids.length === 0) {
        return [];
      }
      const places = await groupMirror(principal, access, databases, 'places').find(withScope(placesScopeFilter(principal.scope), { _id: { $in: [...ids] }, trash: { $ne: true } }), {
        projection: { companyId: 1 },
        limit: ids.length,
      });
      return places.map((place) => ({ id: place._id, companyId: place['companyId'] instanceof ObjectId ? place['companyId'] : null }));
    },
  };
}
