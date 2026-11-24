import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../http/errors.ts';
import type { Logger } from '../logging/logger.ts';

/** Prefix of the key of the lock document of a group in `common.settings`. */
export const CATALOG_LOCK_PREFIX = 'CATALOG_LOCK:';

/** `E11000`: a document with the same key already exists. */
const DUPLICATE_KEY = 11000;

/** How long a lock lasts when it is taken or renewed: the longest an operation may run plus a margin, so a server that dies in the middle frees the group by itself. */
export const CATALOG_LOCK_MS = 15_000 + 3 * 60_000;

/** A lock held on a group; it is returned by {@link CatalogLock.acquire}. */
export interface CatalogLockHandle {
  /**
   * Moves the expiry forward by the lifetime of a lock.
   *
   * @throws {AppError} `CONFLICT` when the lock was lost (it expired and someone else took it), `SERVICE_UNAVAILABLE` on a database error.
   */
  renew(): Promise<void>;
  /** Gives the lock back; one that expired and was taken by someone else is not touched. A database error is logged: the lock then expires by itself. It never rejects. */
  release(): Promise<void>;
}

/** The lock of the catalog of a group, shared by every operation that rewrites many products at once (the import of the workbook and the tobacco synchronization), whatever the server instance. */
export interface CatalogLock {
  /**
   * Takes the lock of a group with one atomic conditional write: the document of the group is created, or taken over when its expiry has passed; while another holder's has not, the write finds the key taken.
   *
   * @param groupId The group, from the verified access.
   * @returns The lock, or `null` when another operation holds it.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the database fails: nothing is run without the lock.
   */
  acquire(groupId: ObjectId): Promise<CatalogLockHandle | null>;
}

/** What {@link createCatalogLock} needs. */
export interface CatalogLockDeps {
  readonly databases: Databases;
  readonly logger: Logger;
  /** Lifetime of a lock in milliseconds. */
  readonly lifetimeMs?: number;
}

/**
 * Builds the lock. The document is `{ key: 'CATALOG_LOCK:<groupId>', value: { owner, expiresAt }, updatedAt }` in `common.settings` (unique `key`): taken with one pipeline `findOneAndUpdate` with `upsert` that rewrites the document only when it is free (absent, expired or without a valid expiry, judged and set on the clock of the database, `$$NOW`), so exactly one of two concurrent callers becomes the owner and the other sees another owner; released with `deleteOne` filtered on the owner. An expired lock is free.
 *
 * @param deps The collaborators.
 */
export function createCatalogLock(deps: CatalogLockDeps): CatalogLock {
  const lifetime = deps.lifetimeMs ?? CATALOG_LOCK_MS;
  /** The expiry, as an expression of the database clock. */
  const expiry = { $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: lifetime } };
  const settings = () => deps.databases.common().collection('settings');
  const keyOf = (groupId: ObjectId): string => `${CATALOG_LOCK_PREFIX}${groupId.toHexString()}`;
  const unavailable = (error: unknown): AppError => {
    deps.logger.error('the lock of the catalog of a group could not be taken or renewed', { error });
    return new AppError('SERVICE_UNAVAILABLE');
  };
  return {
    acquire: async (groupId) => {
      const owner = new ObjectId().toHexString();
      let current;
      try {
        // One atomic upsert of the document of the group, a pipeline that rewrites it only when it is free: absent, expired or without a valid expiry. The comparison and the new expiry use the clock of the database
        // (`$$NOW`), never the one of this server, so an instance whose clock is ahead cannot take a lock that is still valid. Whoever is the owner in the document that comes back holds the lock.
        const free = { $or: [{ $ne: [{ $type: '$value.expiresAt' }, 'date'] }, { $lte: ['$value.expiresAt', '$$NOW'] }] };
        current = await settings().findOneAndUpdate(
          { key: keyOf(groupId) },
          [{ $set: { value: { $cond: [free, { owner: { $literal: owner }, expiresAt: expiry }, '$value'] }, updatedAt: { $cond: [free, '$$NOW', '$updatedAt'] } } }],
          { upsert: true, returnDocument: 'after', projection: { 'value.owner': 1 } },
        );
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === DUPLICATE_KEY) {
          return null;
        }
        throw unavailable(error);
      }
      if ((current?.['value'] as { owner?: unknown } | undefined)?.owner !== owner) {
        return null;
      }
      return {
        renew: async () => {
          let renewed;
          try {
            renewed = await settings().updateOne({ key: keyOf(groupId), 'value.owner': owner }, [{ $set: { 'value.expiresAt': expiry } }]);
          } catch (error) {
            throw unavailable(error);
          }
          if (renewed.matchedCount === 0) {
            throw new AppError('CONFLICT', { message: 'The lock of the group was lost', details: [{ field: 'group', issue: 'busy' }] });
          }
        },
        release: async () => {
          try {
            await settings().deleteOne({ key: keyOf(groupId), 'value.owner': owner });
          } catch (error) {
            deps.logger.error('the lock of the catalog of a group could not be released, it expires by itself', { error });
          }
        },
      };
    },
  };
}
