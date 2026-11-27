/**
 * Read-only access to the send queue for the shadow mode: the only code that touches the queue when the worker does not
 * send. It exposes two reads and nothing else, so a write is not expressible; it creates no index (the scan is bounded by
 * `maxTimeMS` and by the page size).
 *
 * @module
 */
import type { Collection, Document, ObjectId } from 'mongodb';
import { MAX_TIME_MS } from '../db/timeouts.ts';
import type { ShadowHubs } from '../config.ts';

/** The reads of the shadow mode on the queue. */
export interface ShadowQueue {
  /**
   * The ids of the next records to look at, oldest first: those of the selected hubs the legacy has not sent yet (no
   * `sent`, `hubId` or `error`) and those it has uploaded (`hubId` present). Records the legacy refused (`error`) are left out.
   *
   * @param after Only records with a greater id (`undefined` from the start). Only records with an `ObjectId` id are returned.
   * @param hubs The hubs to look at (`*` for every hub, an empty list for none).
   * @param limit Page size.
   * @param notBefore Records older than this id (an ObjectId made from a time) are ignored: a very old record would be falsely refused by the date checks.
   * @returns At most `limit` ids in ascending order.
   */
  idsAfter(after: ObjectId | undefined, hubs: ShadowHubs, limit: number, notBefore: ObjectId): Promise<ObjectId[]>;
  /**
   * Reads one record whole.
   *
   * @param id A record id.
   * @returns The record, or `null` when it is gone.
   */
  read(id: ObjectId): Promise<Document | null>;
}

/**
 * Creates the read-only queue access.
 *
 * @param collection The queue `documents` collection.
 * @returns The access.
 */
export function createShadowQueue(collection: Collection<Document>): ShadowQueue {
  return {
    async idsAfter(after, hubs, limit, notBefore) {
      const hub = hubs === '*' ? { $type: 'string' } : { $in: [...hubs] };
      const filter: Document = {
        'company.fattura_elettronica.hub': hub,
        $or: [{ sent: { $exists: false }, hubId: { $exists: false }, error: { $exists: false } }, { hubId: { $exists: true } }],
        _id: after === undefined || after.toHexString() < notBefore.toHexString() ? { $gte: notBefore } : { $gt: after },
      };
      const found = await collection.find(filter, { projection: { _id: 1 }, sort: { _id: 1 }, limit, maxTimeMS: MAX_TIME_MS }).toArray();
      return found.map((entry) => entry._id as ObjectId);
    },

    async read(id) {
      return await collection.findOne({ _id: id }, { maxTimeMS: MAX_TIME_MS });
    },
  };
}
