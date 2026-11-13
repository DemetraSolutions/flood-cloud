import { BSON } from 'mongodb';
import type { ObjectId, Document } from 'mongodb';

/**
 * Read options that keep the BSON numeric types as they are stored (`Double`, `Int32`, `Long` wrappers instead of JS
 * numbers): without them a whole-number double would be written back as an int32 and the copy would not be an exact
 * mirror. The copy block of the legacy must read with the same options, or every comparison would find a difference.
 */
export const EXACT_TYPES = Object.freeze({ promoteValues: false, promoteLongs: false, bsonRegExp: true });

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
 * Exact equality of two documents: same BSON bytes, so type, value, field order and nested structure all count.
 * Neither a deep-equality library nor a hash is needed, and nothing is held beyond the two documents.
 *
 * @param a First document.
 * @param b Second document.
 */
export function sameDocument(a: Document, b: Document): boolean {
  return Buffer.from(BSON.serialize(a)).equals(Buffer.from(BSON.serialize(b)));
}
