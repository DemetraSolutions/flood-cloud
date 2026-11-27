/**
 * The history of sent invoices (`einvoicingSentInvoices`, common database): what the provider accepted, so the SdI
 * duplicate check 00404 can be answered before sending.
 *
 * `{ key, queueId, hub, providerId, sentAt, released, releasedAt? }`: `key` is `duplicateKeyOf` of the invoice. A partial
 * unique index on `key` where `released` is false keeps one live entry per key. An entry is released when the SdI
 * rejects the invoice (`rejected`, `processingError`) or the buyer refuses it (`refused`): the number is then free again.
 * Invoices the legacy sent before the switch are **not** in it (no backfill): the SdI itself still refuses their duplicates.
 *
 * @module
 */
import type { Collection, ObjectId } from 'mongodb';
import { MAX_TIME_MS } from '../db/timeouts.ts';
import type { DuplicateLookup } from '../validation/duplicates.ts';

/** Name of the collection (in the common database) that holds the history. */
export const SENT_COLLECTION = 'einvoicingSentInvoices';

/** One accepted invoice. */
export interface SentInvoice {
  readonly key: string;
  readonly queueId: ObjectId;
  readonly hub: string;
  readonly providerId: string;
  readonly sentAt: Date;
  readonly released: boolean;
  readonly releasedAt?: Date;
}

/** The history of sent invoices. */
export interface SentHistory {
  /** Creates the partial unique index (idempotent). */
  ensureIndexes(): Promise<void>;
  /**
   * The duplicate lookup for one queue record: another record with the same key that is still live is a duplicate.
   *
   * @param queueId The record being checked (its own entry, from an earlier attempt, is not a duplicate).
   */
  lookupFor(queueId: ObjectId): DuplicateLookup;
  /**
   * Records an accepted invoice (idempotent per key and record: a recovered upload may record twice).
   *
   * @throws The driver's duplicate-key error when another record holds the key.
   */
  recordAccepted(entry: Omit<SentInvoice, 'released' | 'releasedAt'>): Promise<void>;
  /** Frees the keys of a record (the SdI rejected the invoice or the buyer refused it). */
  release(queueId: ObjectId, now: number): Promise<void>;
}

/**
 * Creates the history.
 *
 * @param collection The `einvoicingSentInvoices` collection.
 * @returns The history.
 */
export function createSentHistory(collection: Collection<SentInvoice>): SentHistory {
  return {
    async ensureIndexes() {
      await collection.createIndex({ key: 1 }, { name: 'key_1_unreleased', unique: true, partialFilterExpression: { released: false }, maxTimeMS: MAX_TIME_MS });
    },

    lookupFor(queueId) {
      return async (key) => ((await collection.findOne({ key, released: false, queueId: { $ne: queueId } }, { projection: { _id: 1 }, maxTimeMS: MAX_TIME_MS })) === null ? 'unique' : 'duplicate');
    },

    async recordAccepted(entry) {
      await collection.updateOne({ key: entry.key, queueId: entry.queueId, released: false }, { $setOnInsert: { hub: entry.hub, providerId: entry.providerId, sentAt: entry.sentAt } }, { upsert: true, maxTimeMS: MAX_TIME_MS });
    },

    async release(queueId, now) {
      await collection.updateMany({ queueId, released: false }, { $set: { released: true, releasedAt: new Date(now) } }, { maxTimeMS: MAX_TIME_MS });
    },
  };
}
