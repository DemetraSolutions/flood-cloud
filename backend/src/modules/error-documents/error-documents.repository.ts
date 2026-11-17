import { MongoServerError } from 'mongodb';
import type { Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';

/** MongoDB's `MaxTimeMSExpired` error code. */
const MAX_TIME_EXPIRED = 50;

/**
 * The `sendStatus` values that put a document on the page, as the legacy page listed them (its `$or`): the hub's processing error, the SDI refusal, a delivery that failed or could not be
 * made, a refusal, and the expiry of the terms. A document with an `error` (the upload was refused) is listed whatever its status.
 */
export const ERROR_SEND_STATUSES: readonly string[] = Object.freeze(['processingError', 'rejected', 'notDelivered', 'deliveryImpossible', 'refused', 'effectiveDate']);

/** What the fields of the queue document the table needs are: nothing else is read (the `XML` and the fiscal data of the counterpart stay in the queue). */
export const QUEUE_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  groupId: 1,
  type: 1,
  number: 1,
  prefixSuffix: 1,
  date: 1,
  total: 1,
  customerType: 1,
  'counterpart.name': 1,
  'counterpart.surname': 1,
  'counterpart.companyName': 1,
  'fattura_elettronica.tipo': 1,
  'company.name': 1,
  'company.invoicesPS': 1,
  sendStatus: 1,
  error: 1,
});

/** What a read selects: the perimeter (already resolved by the server) and the filters of the request. */
export interface ErrorDocumentsFilter {
  /** The groups the caller may read; `null` for every group (the platform administrator without a narrower filter). Never empty: the service answers an empty perimeter itself. */
  readonly groupIds: readonly ObjectId[] | null;
  /** The `type` stored in the queue (`invoice`, `credit-note`). */
  readonly type?: 'invoice' | 'credit-note';
  /** The code of the hub's refusal. */
  readonly errorCode?: string;
}

/** The reads of the error documents: the legacy send queue (read only) and the names of the groups of a page. */
export interface ErrorDocumentsRepository {
  /**
   * A page of the documents in error, by `_id` descending.
   *
   * @param filter The perimeter and the filters.
   * @param after Where to continue from (the `_id` of the last document of the previous page), `null` for the first page.
   * @param limit How many documents to read.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  find(filter: ErrorDocumentsFilter, after: ObjectId | null, limit: number): Promise<Document[]>;
  /**
   * How many documents in error a query has, counted up to `cap + 1`.
   *
   * @param filter The perimeter and the filters.
   * @param cap The largest count that matters.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  count(filter: ErrorDocumentsFilter, cap: number): Promise<number>;
  /**
   * The names of some groups, those of one page of rows.
   *
   * @param ids The groups, at most a page of rows.
   * @returns The names by hexadecimal id (a name that is not a text is `''`).
   */
  groupNames(ids: readonly ObjectId[]): Promise<Map<string, string>>;
}

/** The condition on the queue: the legacy `$or`, with an `error` that is a value (a `null` is no error). Only listed ids (an `ObjectId`) are read, so the cursor can always continue. */
function queueFilter(filter: ErrorDocumentsFilter, after: ObjectId | null): Filter<Document> {
  const conditions: Filter<Document>[] = [
    { $or: [{ sendStatus: { $in: [...ERROR_SEND_STATUSES] } }, { error: { $exists: true, $ne: null } }] },
    after === null ? { _id: { $type: 'objectId' } } : { $and: [{ _id: { $type: 'objectId' } }, { _id: { $lt: after } }] },
  ];
  if (filter.groupIds !== null) {
    conditions.push({ groupId: { $in: [...filter.groupIds] } });
  }
  if (filter.type !== undefined) {
    conditions.push({ type: filter.type });
  }
  if (filter.errorCode !== undefined) {
    conditions.push({ 'error.errorCode': filter.errorCode });
  }
  return { $and: conditions };
}

/** Runs a read, answering `503` when it exceeds its time limit: the answer is unknown, never an empty one. */
async function limited<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw error instanceof MongoServerError && error.code === MAX_TIME_EXPIRED ? new AppError('SERVICE_UNAVAILABLE') : error;
  }
}

/**
 * Builds the repository of the error documents. The queue is read through `Databases.queue()`, which offers reads only: nothing is ever written to it, no index is created on it, and an
 * absent database or collection reads as empty. Every query has a time limit and a bound; the group names come from the common database.
 *
 * @param databases Database accessor.
 */
export function createErrorDocumentsRepository(databases: Databases): ErrorDocumentsRepository {
  return {
    find: (filter, after, limit) =>
      limited(() => databases.queue().collection('documents').find(queueFilter(filter, after), { projection: { ...QUEUE_PROJECTION }, sort: { _id: -1 }, limit, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),
    count: (filter, cap) => limited(() => databases.queue().collection('documents').countDocuments(queueFilter(filter, null), { limit: cap + 1, maxTimeMS: LIST_MAX_TIME_MS })),
    groupNames: async (ids) => {
      const found = await limited(() => databases.common().collection('groups').find({ _id: { $in: [...ids] } }, { projection: { name: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      return new Map(found.map((group) => [(group['_id'] as ObjectId).toHexString(), typeof group['name'] === 'string' ? group['name'] : '']));
    },
  };
}
