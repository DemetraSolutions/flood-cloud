import type { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { GROUP_CREDENTIAL_PROJECTION, toGroupCredentials } from './store-context.mapper.ts';
import type { GroupCredentials } from './store-context.types.ts';

/** The reads of the store context that the other modules do not already offer. */
export interface StoreContextRepository {
  /**
   * The credentials of a group (the keys of its integrations and its legacy key), read from the stored document with a projection of those paths only. For the server of a store alone: the
   * caller passes the group of the store principal, never a value of the client.
   *
   * @param groupId Id of the group of the store key.
   * @returns The credentials, or `null` when the group does not exist.
   */
  groupCredentials(groupId: ObjectId): Promise<GroupCredentials | null>;
}

/**
 * Builds the store context repository over `common.groups`.
 *
 * @param databases Database accessor.
 */
export function createStoreContextRepository(databases: Databases): StoreContextRepository {
  return {
    groupCredentials: async (groupId) => {
      const document = await databases.common().collection('groups').findOne({ _id: groupId }, { projection: GROUP_CREDENTIAL_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS });
      return document === null ? null : toGroupCredentials(document);
    },
  };
}
