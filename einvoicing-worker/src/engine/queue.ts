/**
 * The send queue (`<prefix><env>_queue.documents`): atomic claims and fenced writes.
 *
 * The record keeps the legacy shape; this worker only **adds** a `worker` subdocument:
 * `{ state, epoch, leaseUntil, attempts, nextAttemptAt, uploadedAt?, nextStatusAt?, statusChecks?, notFoundChecks?,
 * lastCode?, sdiErrors?, validation? }` with `state` one of `claimed`, `uploading`, `uploaded`, `done`, `failed`, `review`.
 *
 * Claiming is one `findOneAndUpdate`: two engines can never get the same record. A claim stamps the lease `epoch` and a
 * record lease (`leaseUntil`); a crashed claim becomes claimable again when the lease ends, and an `uploading` record is
 * never uploaded again without first asking the provider whether it already went out (the claim keeps `uploading`).
 * The legacy queue has only the `_id` index; the worker adds two (`ensureIndexes`) for its claims, only when a hub is enabled.
 * **Fencing**: every later write filters on `_id` and `worker.epoch`, so once another epoch claimed the record the old
 * holder's writes match nothing and raise {@link FencedError}; a claim refuses records stamped by a newer epoch.
 *
 * @module
 */
import type { Collection, Document, ObjectId } from 'mongodb';
import { MAX_TIME_MS } from '../db/timeouts.ts';
import { FencedError } from '../limits/limiters.ts';

/** A record claimed for upload. */
export interface UploadClaim {
  /** The whole record, as it was before the claim. */
  readonly record: Document;
  /** The `worker.state` before the claim: `uploading` means the file may already be at the provider. */
  readonly previousState: string | undefined;
}

/** The send queue. */
export interface QueueStore {
  /**
   * Creates the two indexes of the claims on the queue (idempotent): `einvoicingWorker_upload` on
   * `{ company.fattura_elettronica.hub: 1, _id: 1 }` and `einvoicingWorker_status` on `{ worker.state: 1, worker.nextStatusAt: 1 }`.
   * The legacy never uses them and is unaffected.
   */
  ensureIndexes(): Promise<void>;
  /**
   * Claims the oldest record of a hub that may be uploaded: no `sent`, `hubId` or `error`, its seller not cooling down,
   * never claimed, or claimed with an expired record lease and a reached `nextAttemptAt`.
   *
   * @param hub The hub.
   * @param blockedSellers `company.code` values of the sellers cooling down.
   * @param epoch Fencing epoch of the lease held.
   * @param now Worker clock.
   * @returns The claim, or `null` when nothing is due.
   */
  claimForUpload(hub: string, blockedSellers: readonly string[], epoch: number, now: number): Promise<UploadClaim | null>;
  /**
   * Claims the record whose status check is the most overdue among the given hubs; a record the legacy had uploaded
   * (`hubId` and no `worker`) is adopted. The claim pushes `nextStatusAt` to the end of the record lease, so a crash
   * leaves the record due again.
   *
   * @returns The record (only the fields the status job needs), or `null`.
   */
  claimForStatus(hubs: readonly string[], epoch: number, now: number): Promise<Document | null>;
  /**
   * Extends the record lease: the fence probe before a write elsewhere.
   *
   * @throws {FencedError} When the record is no longer claimed by this epoch.
   */
  extendLease(id: ObjectId, epoch: number, now: number): Promise<void>;
  /**
   * Marks the record `uploading` (and keeps when the first upload started, `worker.firstUploadAt`), only while its lease is valid.
   *
   * @throws {FencedError} When the record is no longer claimed by this epoch, or its lease ran out.
   */
  markUploading(id: ObjectId, epoch: number, now: number): Promise<void>;
  /**
   * Stores that the provider took the file: `sent`, `hubId` and the history key, **not** fenced by the epoch (the file
   * is at the provider whatever happened to the lease) and idempotent (only a record without `hubId`). Never raises.
   *
   * @param id Record id.
   * @param providerId The id the provider gave.
   * @param historyKey The duplicate key still to be written to the history, if any.
   */
  markSent(id: ObjectId, providerId: string, historyKey: string | undefined): Promise<void>;
  /**
   * Updates a claimed record.
   *
   * @param id Record id.
   * @param epoch Fencing epoch.
   * @param set Fields to set (dotted paths).
   * @param unset Fields to remove.
   * @param inc Fields to increment (dotted path to amount).
   * @throws {FencedError} When the record is no longer claimed by this epoch.
   */
  update(id: ObjectId, epoch: number, set: Document, unset?: readonly string[], inc?: Document): Promise<void>;
  /**
   * Deletes a claimed record.
   *
   * @throws {FencedError} When the record is no longer claimed by this epoch.
   */
  remove(id: ObjectId, epoch: number): Promise<void>;
}

/** Settings of {@link createQueueStore}. */
export interface QueueOptions {
  readonly collection: Collection<Document>;
  /** Lifetime of a claim on a record, in milliseconds. */
  readonly recordLeaseMs: number;
}

/** The fields of a record the status job reads. */
export const STATUS_PROJECTION: Document = {
  groupId: 1,
  hubId: 1,
  'company.code': 1,
  'company.fattura_elettronica.hub': 1,
  'counterpart.fattura_elettronica.formato_trasmissione': 1,
  'fattura_elettronica.tipo': 1,
  worker: 1,
};

/**
 * Creates the queue store.
 *
 * @param options Collection and record lease.
 * @returns The store.
 */
export function createQueueStore(options: QueueOptions): QueueStore {
  const { collection, recordLeaseMs } = options;
  const lease = (now: number): Date => new Date(now + recordLeaseMs);

  const matchOrThrow = (matched: number): void => {
    if (matched === 0) {
      throw new FencedError('queue record');
    }
  };

  return {
    async ensureIndexes() {
      await collection.createIndex({ 'company.fattura_elettronica.hub': 1, _id: 1 }, { name: 'einvoicingWorker_upload', maxTimeMS: MAX_TIME_MS });
      await collection.createIndex({ 'worker.state': 1, 'worker.nextStatusAt': 1 }, { name: 'einvoicingWorker_status', maxTimeMS: MAX_TIME_MS });
    },

    async claimForUpload(hub, blockedSellers, epoch, now) {
      const at = new Date(now);
      const record = await collection.findOneAndUpdate(
        {
          'company.fattura_elettronica.hub': hub,
          sent: { $exists: false },
          hubId: { $exists: false },
          error: { $exists: false },
          ...(blockedSellers.length > 0 ? { 'company.code': { $nin: [...blockedSellers] } } : {}),
          $or: [
            { worker: { $exists: false } },
            {
              'worker.state': { $in: ['claimed', 'uploading', 'failed'] },
              'worker.epoch': { $lte: epoch },
              'worker.leaseUntil': { $lte: at },
              'worker.nextAttemptAt': { $lte: at },
            },
          ],
        },
        [
          {
            $set: {
              'worker.state': { $cond: [{ $eq: ['$worker.state', 'uploading'] }, 'uploading', 'claimed'] },
              'worker.epoch': epoch,
              'worker.leaseUntil': lease(now),
              'worker.attempts': { $add: [{ $ifNull: ['$worker.attempts', 0] }, 1] },
              'worker.nextAttemptAt': { $ifNull: ['$worker.nextAttemptAt', at] },
            },
          },
        ],
        { sort: { _id: 1 }, returnDocument: 'before', maxTimeMS: MAX_TIME_MS },
      );
      if (record === null) {
        return null;
      }
      const state: unknown = (record['worker'] as Document | undefined)?.['state'];
      return { record, previousState: typeof state === 'string' ? state : undefined };
    },

    async claimForStatus(hubs, epoch, now) {
      const at = new Date(now);
      const until = lease(now);
      const base = { hubId: { $exists: true }, 'company.fattura_elettronica.hub': { $in: [...hubs] } };
      const update = [
        {
          $set: {
            'worker.state': 'uploaded',
            'worker.epoch': epoch,
            'worker.leaseUntil': until,
            'worker.nextStatusAt': until,
            'worker.uploadedAt': { $ifNull: ['$worker.uploadedAt', { $convert: { input: '$_id', to: 'date', onError: at, onNull: at } }] },
            'worker.statusChecks': { $ifNull: ['$worker.statusChecks', 0] },
            'worker.attempts': { $ifNull: ['$worker.attempts', 0] },
          },
        },
      ];
      // First the records due for a check (the status index serves this query), then, only when none is due, the ones to adopt:
      // a record the legacy uploaded (no `worker`), or a file whose `uploaded` write was fenced out, once its lease ended.
      const due = await collection.findOneAndUpdate(
        { ...base, 'worker.state': 'uploaded', 'worker.epoch': { $lte: epoch }, 'worker.nextStatusAt': { $lte: at } },
        update,
        { sort: { 'worker.nextStatusAt': 1, _id: 1 }, returnDocument: 'after', projection: STATUS_PROJECTION, maxTimeMS: MAX_TIME_MS },
      );
      if (due !== null) {
        return due;
      }
      return await collection.findOneAndUpdate(
        {
          ...base,
          $or: [{ worker: { $exists: false } }, { 'worker.state': { $in: ['claimed', 'uploading'] }, 'worker.epoch': { $lte: epoch }, 'worker.leaseUntil': { $lte: at } }],
        },
        update,
        { sort: { _id: 1 }, returnDocument: 'after', projection: STATUS_PROJECTION, maxTimeMS: MAX_TIME_MS },
      );
    },

    async markSent(id, providerId, historyKey) {
      await collection.updateOne(
        { _id: id, hubId: { $exists: false } },
        { $set: { sent: true, hubId: providerId, ...(historyKey === undefined ? {} : { 'worker.historyKey': historyKey, 'worker.historyPending': true }) } },
        { maxTimeMS: MAX_TIME_MS },
      );
    },

    async extendLease(id, epoch, now) {
      const result = await collection.updateOne({ _id: id, 'worker.epoch': epoch }, { $set: { 'worker.leaseUntil': lease(now) } }, { maxTimeMS: MAX_TIME_MS });
      matchOrThrow(result.matchedCount);
    },

    async markUploading(id, epoch, now) {
      const result = await collection.updateOne(
        { _id: id, 'worker.epoch': epoch, 'worker.leaseUntil': { $gt: new Date(now) } },
        { $set: { 'worker.state': 'uploading' }, $min: { 'worker.firstUploadAt': new Date(now) } },
        { maxTimeMS: MAX_TIME_MS },
      );
      matchOrThrow(result.matchedCount);
    },

    async update(id, epoch, set, unset = [], inc = {}) {
      const result = await collection.updateOne(
        { _id: id, 'worker.epoch': epoch },
        {
          ...(Object.keys(set).length > 0 ? { $set: set } : {}),
          ...(unset.length > 0 ? { $unset: Object.fromEntries(unset.map((field) => [field, ''])) } : {}),
          ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
        },
        { maxTimeMS: MAX_TIME_MS },
      );
      matchOrThrow(result.matchedCount);
    },

    async remove(id, epoch) {
      const result = await collection.deleteOne({ _id: id, 'worker.epoch': epoch }, { maxTimeMS: MAX_TIME_MS });
      matchOrThrow(result.deletedCount);
    },
  };
}
