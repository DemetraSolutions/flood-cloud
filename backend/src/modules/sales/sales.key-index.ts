import type { Db, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';

/**
 * The unique index that makes the creation of a sale idempotent: one sale per `floodCloud.key` (`<placeId>|<timestampId>`, written only by this backend). It is partial because the sales of the legacy have no `floodCloud` and, being written
 * without a unique index on the point of sale and `timestampId`, may hold duplicates that must never block it. The legacy creates no index on this field, so the new backend is the only one that creates it (decided by the user at step VS4: an
 * exception to the rule "no unique index on the legacy collections", created at run time, never declared in the registry).
 */
export const SALES_KEY_INDEX = Object.freeze({
  key: Object.freeze({ 'floodCloud.key': 1 as const }),
  options: Object.freeze({ name: 'floodCloud.key_1', unique: true, partialFilterExpression: Object.freeze({ 'floodCloud.key': Object.freeze({ $type: 'string' }) }) }),
});

/** The index of the `timestampId` of the sales, the same the legacy creates (same name and key: no conflict, and no effect when it is there). Not unique. */
export const SALES_TIMESTAMP_INDEX = Object.freeze({ key: Object.freeze({ timestampId: 1 as const }), options: Object.freeze({ name: 'timestampId_1' }) });

/** The unique index of the key of the tombstones of deleted sales (a collection of this backend). */
export const SALES_TOMBSTONE_INDEX = Object.freeze({ key: Object.freeze({ key: 1 as const }), options: Object.freeze({ name: 'key_1' }) });

/** The `codeName` of the answers that say the index is, or is being, there already: they are not a failure. */
const ALREADY_THERE: readonly string[] = ['IndexBuildAlreadyInProgress', 'IndexOptionsConflict', 'IndexKeySpecsConflict'];

/** The shortest time before a failed creation of the index is tried again (a failure is not repeated on every write). */
export const SALES_KEY_INDEX_RETRY_MS = 10 * 60 * 1000;

/** Whether the unique indexes of the key of the sales and of the tombstones are really there and unique (an index with the right name that is not unique, left by someone else, does not make a sale idempotent). */
async function uniquenessIsThere(db: Db, groupId: ObjectId, logger: Logger): Promise<boolean> {
  const sales = (await db.collection('sales').listIndexes().toArray()).find((index) => index['name'] === SALES_KEY_INDEX.options.name);
  const tombstones = (await db.collection('sales_tombstones').listIndexes().toArray()).find((index) => index['name'] === SALES_TOMBSTONE_INDEX.options.name);
  if (sales?.['unique'] === true && tombstones?.['unique'] === true) {
    return true;
  }
  logger.error('the unique indexes of the sales are not there as they must be', { groupId: groupId.toHexString() });
  return false;
}

/**
 * Creates the unique index of the key of the sales in a group database, and reports how it went in the log, never failing: the write that asked for it goes on (a creation then refuses to run without it: see the sales service).
 * An index that exists already or is being built is `info`; any other failure is `error` with the group and the kind of failure, never the text of the server's message.
 *
 * @param db The group database.
 * @param groupId The group, for the log.
 * @param logger Where the outcome is reported.
 * @returns `true` only when `listIndexes` shows the indexes of the key of the sales and of the tombstones, both unique; `false` otherwise (the guard tries again later, and no sale is saved meanwhile).
 */
export async function createSalesKeyIndex(db: Db, groupId: ObjectId, logger: Logger): Promise<boolean> {
  try {
    await db.collection('sales').createIndex({ ...SALES_KEY_INDEX.key }, { name: SALES_KEY_INDEX.options.name, unique: true, partialFilterExpression: { 'floodCloud.key': { $type: 'string' } } });
    // The search by `timestampId` (and the look for a sale the legacy wrote): the legacy creates the same index (`timestampId_1`) at its first sale, so on a group it served this is a no-op.
    await db.collection('sales').createIndex({ ...SALES_TIMESTAMP_INDEX.key }, { name: SALES_TIMESTAMP_INDEX.options.name });
    // The tombstones of the sales that were deleted: one per key, so a deleted sale is never made again.
    await db.collection('sales_tombstones').createIndex({ ...SALES_TOMBSTONE_INDEX.key }, { name: SALES_TOMBSTONE_INDEX.options.name, unique: true });
    return await uniquenessIsThere(db, groupId, logger);
  } catch (error) {
    const failure = error as { readonly name?: unknown; readonly code?: unknown; readonly codeName?: unknown };
    const fields = { groupId: groupId.toHexString(), errorName: String(failure.name), errorCode: typeof failure.code === 'number' ? failure.code : null };
    if (typeof failure.codeName === 'string' && ALREADY_THERE.includes(failure.codeName)) {
      logger.info('the unique index on the key of the sales exists already or is being built', fields);
      return uniquenessIsThere(db, groupId, logger);
    }
    logger.error('the unique index on the key of the sales could not be created', fields);
    return false;
  }
}

/** Makes sure a group has the unique index of the key of the sales before its first sale is written by this process. */
export interface SalesKeyIndexGuard {
  /**
   * Creates the index if this process has not checked the group yet (once per group and process; a real failure is logged and tried again only after {@link SALES_KEY_INDEX_RETRY_MS}). It never rejects and tells whether the index is there (`false` when it could not be created). It must run **outside** a transaction:
   * an index is not created inside one, and a caller that holds a transaction open calls it before opening it.
   */
  ensure(principal: ScopeHolder, access: GroupAccess): Promise<boolean>;
}

/**
 * Builds the guard of the index.
 *
 * @param databases Database accessor (never one bound to a transaction).
 * @param logger Where the outcome is reported.
 * @param now Clock in epoch milliseconds (tests move it).
 */
export function createSalesKeyIndexGuard(databases: Databases, logger: Logger, now: () => number = Date.now): SalesKeyIndexGuard {
  const checked = new Map<string, { done: Promise<boolean>; retryAt: number | null }>();
  return {
    ensure: (principal, access) => {
      const key = access.groupId.toHexString();
      const known = checked.get(key);
      if (known !== undefined && (known.retryAt === null || now() < known.retryAt)) {
        return known.done;
      }
      const entry: { done: Promise<boolean>; retryAt: number | null } = { done: Promise.resolve(false), retryAt: null };
      entry.done = createSalesKeyIndex(groupDatabaseFor(principal, access, databases), access.groupId, logger).then((created) => {
        entry.retryAt = created ? null : now() + SALES_KEY_INDEX_RETRY_MS;
        return created;
      });
      checked.set(key, entry);
      return entry.done;
    },
  };
}
