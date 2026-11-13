import { BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/**
 * Whether the `groupId` of an original document is an `ObjectId` equal to the group of its database.
 *
 * @param original Document of the group database.
 * @param groupId Group derived from the database name.
 */
export function hasCorrectGroupId(original: Document, groupId: ObjectId): boolean {
  const declared: unknown = original['groupId'];
  return declared instanceof ObjectId && declared.equals(groupId);
}

/**
 * BSON size of a document in bytes, used to bound the blocks.
 *
 * @param document Any document.
 */
export function documentSize(document: Document): number {
  return BSON.calculateObjectSize(document);
}
