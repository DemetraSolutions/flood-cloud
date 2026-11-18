import type { Document, Filter, FindCursor, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { TRASHED } from './filters.ts';

/** Most trashed groups one run reads (ids only, read up front): far above the real number, and a bound on the memory. */
export const MAX_TRASHED_GROUPS = 10_000;

/** A trashed group chosen for the run: its id and the raw `dataCluster` and `databaseHost` its document holds (resolved only when the group is worked on). */
export interface SelectedGroup {
  readonly id: ObjectId;
  readonly dataCluster: unknown;
  readonly databaseHost: unknown;
}

/**
 * Opens a cursor over the groups of the trash, in `_id` order: the documents of `common.groups` whose `trash` is exactly `true`, without the groups to skip.
 * Only `_id`, `dataCluster` and `databaseHost` are read.
 *
 * @param databases Database accessor.
 * @param groupId Restricts the selection to this group, which must also be in the trash (otherwise the cursor is empty), or `null`.
 * @param skip Groups left out of the selection.
 */
export function trashedGroupsCursor(databases: Databases, groupId: ObjectId | null, skip: readonly ObjectId[]): FindCursor<Document> {
  const idFilter: Filter<Document> = groupId === null ? { _id: { $type: 'objectId' } } : { _id: groupId };
  const filter: Filter<Document> = { $and: [idFilter, { _id: { $nin: [...skip] } }, TRASHED] };
  return databases.common().collection('groups').find(filter, { projection: { _id: 1, dataCluster: 1, databaseHost: 1 }, sort: { _id: 1 }, limit: MAX_TRASHED_GROUPS });
}

/**
 * Reads a group document of a cursor as a {@link SelectedGroup}.
 *
 * @param document A document of {@link trashedGroupsCursor}.
 */
export function toSelected(document: Document): SelectedGroup {
  return { id: document._id as ObjectId, dataCluster: document['dataCluster'], databaseHost: document['databaseHost'] };
}
