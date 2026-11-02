import type { ObjectId } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';

/** Default cap on the places of the companies of one user; above it the scope is refused, not truncated. */
export const MAX_COMPANY_PLACES = 20_000;

/**
 * Reads which places belong to some companies, in a group database.
 *
 * This is the second and only exception, besides `groupDatabaseFor`, to opening a group database
 * from a verified `GroupAccess`: the `groupId` comes from the stored user document (the group the
 * user belongs to), never from request input.
 */
export interface CompanyPlacesRepository {
  /**
   * Ids of the places (trashed ones included: user management does not depend on the trash of
   * a place) whose `companyId` is one of the given companies. Companies without places, or that do
   * not exist, contribute nothing.
   *
   * @param groupId Id of the group (from the stored user).
   * @param companyIds Companies of the user.
   * @throws {Error} Above the cap (fail closed).
   */
  listCompanyPlaceIds(groupId: ObjectId, companyIds: readonly ObjectId[]): Promise<ObjectId[]>;
}

/**
 * Builds the repository of the company-to-places relation (`places`, read only, ids only).
 *
 * @param databases Database accessor.
 * @param maxPlaces Cap, {@link MAX_COMPANY_PLACES} by default.
 */
export function createCompanyPlacesRepository(databases: Databases, maxPlaces: number = MAX_COMPANY_PLACES): CompanyPlacesRepository {
  return {
    listCompanyPlaceIds: async (groupId, companyIds) => {
      const cursor = databases
        .group(groupId)
        .collection<{ _id: ObjectId }>('places')
        .find({ companyId: { $in: [...companyIds] } }, { projection: { _id: 1 }, limit: maxPlaces + 1 });
      const ids: ObjectId[] = [];
      for await (const place of cursor) {
        ids.push(place._id);
      }
      if (ids.length > maxPlaces) {
        throw new Error(`Companies have more than ${String(maxPlaces)} places`);
      }
      return ids;
    },
  };
}
