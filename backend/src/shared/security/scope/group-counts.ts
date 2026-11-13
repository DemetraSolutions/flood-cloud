import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { MAX_LIMIT } from '../../http/list.ts';

/** How many elements of one kind a group holds: the ones in use and the ones in the trash (`trash: true`). */
export interface TrashCount {
  readonly active: number;
  readonly trashed: number;
}

/**
 * Validates the ids a count is computed for.
 *
 * @param groupIds Ids of the groups of one page.
 * @returns The same ids.
 * @throws {Error} If the list is empty, longer than the maximum page size ({@link MAX_LIMIT}) or holds anything but `ObjectId`s.
 */
export function assertCountedGroups(groupIds: readonly ObjectId[]): readonly ObjectId[] {
  if (!Array.isArray(groupIds) || groupIds.length === 0 || groupIds.length > MAX_LIMIT || groupIds.some((id: unknown) => !(id instanceof ObjectId))) {
    throw new Error(`A count needs between 1 and ${MAX_LIMIT} group ids`);
  }
  return groupIds;
}

/**
 * The pipeline that counts, in one pass, the documents of some groups by group and by trash state. The only stages are a
 * `$match` on the groups (a `groupId` that is an array or not an `ObjectId` never matches) and a `$group`; it is built here
 * and never accepts a stage from a caller. It uses the index whose prefix is `groupId`.
 *
 * @param groupIds Ids of the groups, already validated by {@link assertCountedGroups}.
 */
export function countByGroupPipeline(groupIds: readonly ObjectId[]): Document[] {
  return [
    { $match: { $and: [{ groupId: { $in: [...groupIds] } }, { groupId: { $type: 'objectId' } }, { groupId: { $not: { $type: 'array' } } }] } },
    { $group: { _id: { groupId: '$groupId', trashed: { $eq: ['$trash', true] } }, count: { $sum: 1 } } },
  ];
}

/**
 * Turns the rows of {@link countByGroupPipeline} into a map by group (hex id). Every requested group is present, with zeros when nothing was counted.
 *
 * @param groupIds The groups asked for.
 * @param rows Rows `{ _id: { groupId, trashed }, count }`.
 */
export function countsByGroup(groupIds: readonly ObjectId[], rows: readonly Document[]): Map<string, TrashCount> {
  const counts = new Map<string, { active: number; trashed: number }>(groupIds.map((id) => [id.toHexString(), { active: 0, trashed: 0 }]));
  for (const row of rows) {
    const entry = counts.get((row['_id'].groupId as ObjectId).toHexString());
    if (entry !== undefined) {
      entry[row['_id'].trashed === true ? 'trashed' : 'active'] = row['count'] as number;
    }
  }
  return counts;
}
