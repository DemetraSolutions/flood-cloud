import type { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { FEATURE_PROJECTION, featuresOf } from '../groups/features.ts';
import type { FeatureFlags } from '../groups/features.ts';

/** The part of a group the profile shows. Nothing else of the group document is ever read. */
export interface GroupSummary {
  readonly id: string;
  /** Name of the group, `null` when the document has none. */
  readonly name: string | null;
}

/** The group of the authenticated user as the profile needs it: the summary and the features of the group. */
export interface GroupContext extends GroupSummary {
  /** Which features the group has turned on, every feature of the catalog present. */
  readonly features: FeatureFlags;
}

/** Reads the public summary of a group (`common.groups`, read only). */
export interface GroupSummaryRepository {
  /**
   * @param groupId Id of the group of the authenticated user (from the stored user, not from input).
   * @returns Id, name and features, or `null` when the group does not exist. The projection holds only `name` and the
   * feature flags: the API key and the rest of the document are never loaded.
   */
  find(groupId: ObjectId): Promise<GroupContext | null>;
}

/**
 * Builds the group summary repository.
 *
 * @param databases Database accessor.
 */
export function createGroupSummaryRepository(databases: Databases): GroupSummaryRepository {
  return {
    find: async (groupId) => {
      const group = await databases.common().collection<{ _id: ObjectId; name?: unknown; settings?: unknown }>('groups').findOne({ _id: groupId }, { projection: { name: 1, ...FEATURE_PROJECTION } });
      return group === null ? null : { id: group._id.toHexString(), name: typeof group.name === 'string' ? group.name : null, features: featuresOf(group.settings) };
    },
  };
}
