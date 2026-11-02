import type { ObjectId } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';

/** Default cap on the groups of one dealer; a dealer above it is a data problem, not a page to truncate. */
export const MAX_DEALER_GROUPS = 10_000;

/** Reads, from the common database, which groups belong to a dealer. */
export interface DealerGroupsRepository {
  /**
   * Ids of the available groups (`status === true`, not trashed) whose `dealerId` is the given user.
   * A `dealerId` stored in another type never matches.
   *
   * @param dealerUserId `_id` of the dealer user.
   * @throws {Error} If the dealer has more groups than the cap (fail closed instead of truncating).
   */
  listDealerGroupIds(dealerUserId: ObjectId): Promise<ObjectId[]>;
}

/**
 * Builds the repository of the dealer-to-groups relation (`common.groups`, read only).
 *
 * @param databases Database accessor.
 * @param maxGroups Cap on the groups of one dealer, {@link MAX_DEALER_GROUPS} by default.
 * @returns The repository.
 */
export function createDealerGroupsRepository(databases: Databases, maxGroups: number = MAX_DEALER_GROUPS): DealerGroupsRepository {
  return {
    listDealerGroupIds: async (dealerUserId) => {
      const cursor = databases
        .common()
        .collection<{ _id: ObjectId }>('groups')
        .find({ dealerId: dealerUserId, status: true, trash: { $ne: true } }, { projection: { _id: 1 }, limit: maxGroups + 1 });
      const ids: ObjectId[] = [];
      for await (const group of cursor) {
        ids.push(group._id);
      }
      if (ids.length > maxGroups) {
        throw new Error(`Dealer has more than ${String(maxGroups)} groups`);
      }
      return ids;
    },
  };
}
