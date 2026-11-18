import type { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';

/**
 * The roles of a user that belongs to one group. A `PSA` (platform) and a `D` (dealer) are never listed: they serve many groups, so whatever
 * `groupId` they carry they are never deleted with a group.
 */
export const GROUP_ROLES: readonly string[] = Object.freeze(['SA', 'CA', 'PA', 'E']);

/**
 * A group that is in the trash: `trash` is exactly the boolean `true` (not `1`, not `'true'`, not an array that holds `true`).
 * It is the only definition of "trashed" of the purge, for the selection and for the final deletion of the group document.
 */
export const TRASHED: Filter<Document> = Object.freeze({ $and: [{ trash: true }, { trash: { $not: { $type: 'array' } } }] });

/**
 * Matches the documents of the common database that belong to one group: `groupId` equal to its `ObjectId` or to its hex string (the two forms the
 * legacy data may hold), and never an array (a `groupId` that is a list would match another group too).
 *
 * @param groupId The group.
 */
export function groupIdFilter(groupId: ObjectId): Filter<Document> {
  return { $and: [{ groupId: { $in: [groupId, groupId.toHexString()] } }, { groupId: { $not: { $type: 'array' } } }] };
}

/**
 * Matches the users of one group that are deleted with it: `groupId` of the group (see {@link groupIdFilter}) and a role that is exactly one of
 * {@link GROUP_ROLES}. A user whose role is missing, unknown or a list is not matched.
 *
 * @param groupId The group.
 */
export function groupUsersFilter(groupId: ObjectId): Filter<Document> {
  return { $and: [groupIdFilter(groupId), { role: { $in: [...GROUP_ROLES] } }, { role: { $not: { $type: 'array' } } }] };
}

/**
 * Whether the `databaseHost` of a group document says its data lives on a dedicated host of the legacy that this tool cannot reach: anything but a missing value,
 * `null` or a blank string (a value of an unexpected type counts as a host, so such a group is never purged).
 *
 * @param value The `databaseHost` of the group document.
 */
export function isExternalHost(value: unknown): boolean {
  return !(value === undefined || value === null || (typeof value === 'string' && value.trim() === ''));
}
