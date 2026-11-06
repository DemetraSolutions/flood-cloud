import type { ObjectId } from 'mongodb';
import type { ClusterId } from '../../../config.ts';
import type { Databases } from '../../../db/databases.ts';
import { FEATURE_PROJECTION } from '../../../modules/groups/features.ts';

/**
 * Whether a group may be worked on: `available` (active and not trashed), `unavailable`
 * (suspended or trashed) or `null` for a group that does not exist.
 */
export type GroupAvailability = 'available' | 'unavailable';

/** What group access needs from `common.groups`: availability, the raw, unvalidated `dataCluster` and the feature flags. */
export interface GroupAccessInfo {
  readonly availability: GroupAvailability;
  /** The group as stored, projected: `dataCluster` is untrusted until {@link GroupsRepository.resolveCluster} accepts it. */
  readonly group: {
    readonly _id: ObjectId;
    readonly dataCluster?: unknown;
    /** The stored `settings`, projected to the feature flags of the catalog and nothing else; of unknown shape. */
    readonly settings?: unknown;
  };
}

/** Reads the minimum about a group needed to authorize access to it. */
export interface GroupsRepository {
  /**
   * Looks a group up in `common.groups`, projecting only `_id`, `status`, `trash`, `dataCluster` and the feature flags (`settings.<feature>`).
   *
   * @param groupId Id of the group.
   * @returns The availability, or `null` when the group does not exist.
   */
  findAvailability(groupId: ObjectId): Promise<GroupAvailability | null>;
  /**
   * Like {@link GroupsRepository.findAvailability}, and also returns the stored `dataCluster` unresolved:
   * the caller must check availability and perimeter first, then call {@link GroupsRepository.resolveCluster}.
   *
   * @param groupId Id of the group.
   * @returns Availability and the projected group, or `null` when the group does not exist.
   */
  findAccess(groupId: ObjectId): Promise<GroupAccessInfo | null>;
  /**
   * Cluster that holds the data of a group (`dataCluster`, or the default when absent).
   *
   * @param group The group as returned by {@link GroupsRepository.findAccess}.
   * @returns The cluster id.
   * @throws {UnknownClusterError} If `dataCluster` is present and not usable.
   */
  resolveCluster(group: GroupAccessInfo['group']): ClusterId;
}

/**
 * Builds the repository of group availability (`common.groups`, read only).
 *
 * @param databases Database accessor.
 */
export function createGroupsRepository(databases: Databases): GroupsRepository {
  type GroupState = { _id: ObjectId; status?: unknown; trash?: unknown; dataCluster?: unknown; settings?: unknown };
  const find = (groupId: ObjectId): Promise<GroupState | null> =>
    databases.common().collection<GroupState>('groups').findOne({ _id: groupId }, { projection: { status: 1, trash: 1, dataCluster: 1, ...FEATURE_PROJECTION } });
  const availabilityOf = (group: GroupState): GroupAvailability => (group.status === true && group.trash !== true ? 'available' : 'unavailable');
  return {
    findAvailability: async (groupId) => {
      const group = await find(groupId);
      return group === null ? null : availabilityOf(group);
    },
    findAccess: async (groupId) => {
      const group = await find(groupId);
      return group === null ? null : { availability: availabilityOf(group), group };
    },
    resolveCluster: (group) => databases.resolveGroupCluster(group),
  };
}
