/**
 * Access to the databases of the groups (`<prefix><env>_<groupId>`, collection `documents`): the worker writes
 * `sendStatus` on the fiscal document and reads the original of a credit note. Nothing else, and never another field.
 *
 * @module
 */
import { ObjectId } from 'mongodb';
import type { Document, MongoClient } from 'mongodb';
import { groupDatabaseName } from '../db/names.ts';
import type { DatabaseNameContext } from '../db/names.ts';
import { MAX_TIME_MS } from '../db/timeouts.ts';

/** An id as the legacy stores it (ObjectId) or as text (24 lowercase hexadecimal characters); anything else is refused. */
function toObjectId(value: unknown): ObjectId | undefined {
  if (value instanceof ObjectId) {
    return value;
  }
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value) ? new ObjectId(value) : undefined;
}

/** The group documents. */
export interface GroupStore {
  /**
   * Writes `sendStatus` on a group's fiscal document (never creates it).
   *
   * @param groupId The `groupId` of the queue record: an ObjectId or 24 lowercase hexadecimal characters, anything else is refused.
   * @param documentId The document id (same as the queue record's).
   * @param status The status to write.
   * @returns `false` when the group id is not an ObjectId or the document does not exist.
   */
  setSendStatus(groupId: unknown, documentId: ObjectId, status: string): Promise<boolean>;
  /**
   * Reads the fields of the original document of a credit note (`number`, `prefixSuffix`, `date`).
   *
   * @param groupId The `groupId` of the queue record (anything: it is checked).
   * @param documentId The `fromDocumentId` of the record (anything: it is checked).
   * @returns The fields, or `null` when the ids are not ObjectIds or the document does not exist.
   */
  readOriginal(groupId: unknown, documentId: unknown): Promise<Document | null>;
}

/**
 * Creates the group store.
 *
 * @param client The MongoDB client.
 * @param context Prefix and environment of the database names.
 * @returns The store.
 */
export function createGroupStore(client: MongoClient, context: DatabaseNameContext): GroupStore {
  const documents = (groupId: ObjectId) => client.db(groupDatabaseName(context, groupId.toHexString())).collection('documents');
  return {
    async setSendStatus(groupId, documentId, status) {
      const group = toObjectId(groupId);
      if (group === undefined) {
        return false;
      }
      const result = await documents(group).updateOne({ _id: documentId }, { $set: { sendStatus: status } }, { maxTimeMS: MAX_TIME_MS });
      return result.matchedCount === 1;
    },

    async readOriginal(groupId, documentId) {
      const group = toObjectId(groupId);
      const original = toObjectId(documentId);
      if (group === undefined || original === undefined) {
        return null;
      }
      return await documents(group).findOne({ _id: original }, { projection: { number: 1, prefixSuffix: 1, date: 1 }, maxTimeMS: MAX_TIME_MS });
    },
  };
}
