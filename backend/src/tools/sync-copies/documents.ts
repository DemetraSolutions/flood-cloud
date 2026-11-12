import { BSON, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/**
 * The document a copy must be: the original with `groupId` set to the group of the database it was read from
 * (`doc/Tasks.md` D-20 and 0.2.6: the group id never comes from the document). The field keeps its position when the
 * original has it and goes last when it is missing, so copies written by different tools stay byte-identical.
 *
 * @param original Document of the group database.
 * @param groupId Group derived from the database name.
 * @returns A new document; `original` is not modified.
 */
export function expectedCopy(original: Document, groupId: ObjectId): Document {
  return { ...original, groupId };
}

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
 * Exact equality of two documents: same BSON bytes, so type, value, field order and nested structure all count.
 * Neither a deep-equality library nor a hash is needed, and nothing is held beyond the two documents.
 *
 * @param a First document.
 * @param b Second document.
 */
export function sameDocument(a: Document, b: Document): boolean {
  return Buffer.from(BSON.serialize(a)).equals(Buffer.from(BSON.serialize(b)));
}

/**
 * BSON size of a document in bytes, used to bound the blocks.
 *
 * @param document Any document.
 */
export function documentSize(document: Document): number {
  return BSON.calculateObjectSize(document);
}
