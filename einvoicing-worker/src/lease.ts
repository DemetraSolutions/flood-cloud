import type { Collection } from 'mongodb';

/** Name of the collection (in the common database) that holds the lease. */
export const LEASE_COLLECTION = 'einvoicingWorkerLeases';

/** `_id` of the only lease document. */
export const LEASE_ID = 'einvoicing-worker';

/** The lease document. */
export interface LeaseDocument {
  readonly _id: string;
  /** Instance that holds (or last held) the lease. */
  readonly holder: string;
  /** Incremented every time the lease changes holder or is taken after expiry: a fencing token for later steps. */
  readonly epoch: number;
  readonly acquiredAt: Date;
  readonly renewedAt: Date;
  /** The lease is free for anyone at or after this instant. */
  readonly expiresAt: Date;
}

/** Single-instance lease as the runner uses it. Times are milliseconds since the epoch. */
export interface Lease {
  /**
   * Tries to take the lease.
   *
   * @param now Worker clock.
   * @returns The epoch when acquired, `null` when another instance holds a live lease.
   */
  tryAcquire(now: number): Promise<number | null>;
  /**
   * Extends the lease if this instance still holds it with the epoch it acquired.
   *
   * @param now Worker clock.
   * @returns `false` when the lease was lost.
   */
  renew(now: number): Promise<boolean>;
  /**
   * Gives the lease up (graceful shutdown): expires it at once, only if still held with the acquired epoch.
   *
   * @param now Worker clock.
   * @returns `true` when it was released.
   */
  release(now: number): Promise<boolean>;
}

/** Settings of {@link createLease}. */
export interface LeaseOptions {
  /** The `einvoicingWorkerLeases` collection of the common database. */
  readonly collection: Collection<LeaseDocument>;
  /** Identity of this instance. */
  readonly instanceId: string;
  /** Lease lifetime in milliseconds. */
  readonly ttlMs: number;
}

/** Whether `error` is a MongoDB duplicate key error. */
function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * Creates the lease of one instance. Expiry is judged with the worker clock passed as `now`: the assumption is a
 * single active pod with NTP-synchronised clocks (a skew far below the TTL is harmless, it only shifts expiry).
 * The `epoch` grows whenever the lease is taken after expiry or from another holder, so later steps can fence
 * their writes with it. The collection has no index other than `_id` and no `$jsonSchema` validator (D-32).
 *
 * @param options Collection, instance id and TTL.
 * @returns The lease.
 * @example
 * const lease = createLease({ collection, instanceId: 'pod-0', ttlMs: 30_000 });
 * const epoch = await lease.tryAcquire(Date.now());
 */
export function createLease(options: LeaseOptions): Lease {
  const { collection, instanceId, ttlMs } = options;
  let heldEpoch: number | null = null;

  return {
    async tryAcquire(now) {
      const at = new Date(now);
      const expiresAt = new Date(now + ttlMs);
      // The same holder re-taking a lease that is still valid keeps the epoch (a restart under the same pod name);
      // any other acquisition increments it. On insert `$holder` is missing, so the epoch starts at 1.
      const stillMine = { $and: [{ $eq: ['$holder', instanceId] }, { $gt: ['$expiresAt', at] }] };
      try {
        const doc = await collection.findOneAndUpdate(
          { _id: LEASE_ID, $or: [{ expiresAt: { $lte: at } }, { holder: instanceId }] },
          [
            {
              $set: {
                epoch: { $cond: [stillMine, '$epoch', { $add: [{ $ifNull: ['$epoch', 0] }, 1] }] },
                acquiredAt: { $cond: [stillMine, '$acquiredAt', at] },
                holder: instanceId,
                renewedAt: at,
                expiresAt,
              },
            },
          ],
          { upsert: true, returnDocument: 'after' },
        );
        // With `upsert` and `returnDocument: 'after'` the driver always returns the document.
        heldEpoch = (doc as LeaseDocument).epoch;
        return heldEpoch;
      } catch (error) {
        if (isDuplicateKey(error)) {
          heldEpoch = null;
          return null;
        }
        throw error;
      }
    },

    async renew(now) {
      if (heldEpoch === null) {
        return false;
      }
      const result = await collection.updateOne(
        { _id: LEASE_ID, holder: instanceId, epoch: heldEpoch },
        { $set: { renewedAt: new Date(now), expiresAt: new Date(now + ttlMs) } },
      );
      if (result.matchedCount === 0) {
        heldEpoch = null;
        return false;
      }
      return true;
    },

    async release(now) {
      if (heldEpoch === null) {
        return false;
      }
      const epoch = heldEpoch;
      heldEpoch = null;
      const result = await collection.updateOne({ _id: LEASE_ID, holder: instanceId, epoch }, { $set: { expiresAt: new Date(now) } });
      return result.matchedCount === 1;
    },
  };
}
