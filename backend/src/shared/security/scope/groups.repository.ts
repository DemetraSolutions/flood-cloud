import type { ObjectId } from 'mongodb';
import type { Databases } from '../../../db/databases.ts';

/**
 * Whether a group may be worked on: `available` (active and not trashed), `unavailable`
 * (suspended or trashed) or `null` for a group that does not exist.
 */
export type GroupAvailability = 'available' | 'unavailable';

/** Reads the minimum about a group needed to authorize access to it. */
export interface GroupsRepository {
  /**
   * Looks a group up in `common.groups`, projecting only `_id`, `status` and `trash`.
   *
   * @param groupId Id of the group.
   * @returns The availability, or `null` when the group does not exist.
   */
  findAvailability(groupId: ObjectId): Promise<GroupAvailability | null>;
}

/**
 * Builds the repository of group availability (`common.groups`, read only).
 *
 * @param databases Database accessor.
 */
export function createGroupsRepository(databases: Databases): GroupsRepository {
  return {
    findAvailability: async (groupId) => {
      const group = await databases.common().collection<{ _id: ObjectId; status?: unknown; trash?: unknown }>('groups').findOne({ _id: groupId }, { projection: { status: 1, trash: 1 } });
      if (group === null) {
        return null;
      }
      return group.status === true && group.trash !== true ? 'available' : 'unavailable';
    },
  };
}
