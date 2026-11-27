import type { Db, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';

/**
 * The unique index that makes the movements of the warehouse idempotent: one movement per origin and sequence number. It is partial because the movements of the legacy have no `origin` and must never be constrained. The legacy has no index on
 * these fields, so the new backend is the only one that creates it (decided by the user at step VS: an exception to the rule "no unique index on the legacy collections", created at run time, never declared in the registry).
 */
export const STOCK_ORIGIN_INDEX = Object.freeze({
  key: Object.freeze({ 'origin.kind': 1 as const, 'origin.id': 1 as const, 'origin.seq': 1 as const }),
  options: Object.freeze({ name: 'origin.kind_1_origin.id_1_origin.seq_1', unique: true, partialFilterExpression: Object.freeze({ 'origin.kind': Object.freeze({ $exists: true }) }) }),
});

/** The `codeName` of the answers that say the index is, or is being, there already: they are not a failure. */
const ALREADY_THERE: readonly string[] = ['IndexBuildAlreadyInProgress', 'IndexOptionsConflict', 'IndexKeySpecsConflict'];

/** The shortest time before a failed creation of the index is tried again (a failure is not repeated on every write). */
export const STOCK_INDEX_RETRY_MS = 10 * 60 * 1000;

/**
 * Creates the unique index of the origins of the warehouse movements in a group database, and reports how it went in the log, never failing: the write that asked for it goes on (the transaction and the sequence read in it protect the group anyway).
 * An index that exists already or is being built is `info`; any other failure is `error` with the group and the kind of failure, never the text of the server's message.
 *
 * @param db The group database.
 * @param groupId The group, for the log.
 * @param logger Where the outcome is reported.
 * @returns `false` when the creation failed for a reason other than the index being there already or being built (the guard tries again later).
 */
export async function createStockOriginIndex(db: Db, groupId: ObjectId, logger: Logger): Promise<boolean> {
  try {
    await db.collection('warehouse').createIndex({ ...STOCK_ORIGIN_INDEX.key }, { name: STOCK_ORIGIN_INDEX.options.name, unique: true, partialFilterExpression: { 'origin.kind': { $exists: true } } });
    return true;
  } catch (error) {
    const failure = error as { readonly name?: unknown; readonly code?: unknown; readonly codeName?: unknown };
    const fields = { groupId: groupId.toHexString(), errorName: String(failure.name), errorCode: typeof failure.code === 'number' ? failure.code : null };
    if (typeof failure.codeName === 'string' && ALREADY_THERE.includes(failure.codeName)) {
      logger.info('the unique index on the origins of the warehouse movements exists already or is being built', fields);
      return true;
    }
    logger.error('the unique index on the origins of the warehouse movements could not be created', fields);
    return false;
  }
}

/** Makes sure a group has the unique index of the origins before its first warehouse movement is written by this process. */
export interface StockIndexGuard {
  /**
   * Creates the index if this process has not checked the group yet (once per group and process; a real failure is logged and tried again only after {@link STOCK_INDEX_RETRY_MS}). It never rejects. It must run **outside** a transaction:
   * an index is not created inside one, and a caller that holds a transaction open calls it before opening it.
   */
  ensure(principal: ScopeHolder, access: GroupAccess): Promise<void>;
}

/**
 * Builds the guard of the index.
 *
 * @param databases Database accessor (never one bound to a transaction).
 * @param logger Where the outcome is reported.
 * @param now Clock in epoch milliseconds (tests move it).
 */
export function createStockIndexGuard(databases: Databases, logger: Logger, now: () => number = Date.now): StockIndexGuard {
  const checked = new Map<string, { readonly done: Promise<void>; retryAt: number | null }>();
  return {
    ensure: (principal, access) => {
      const key = access.groupId.toHexString();
      const known = checked.get(key);
      if (known !== undefined && (known.retryAt === null || now() < known.retryAt)) {
        return known.done;
      }
      const entry: { done: Promise<void>; retryAt: number | null } = { done: Promise.resolve(), retryAt: null };
      entry.done = createStockOriginIndex(groupDatabaseFor(principal, access, databases), access.groupId, logger).then((created) => {
        entry.retryAt = created ? null : now() + STOCK_INDEX_RETRY_MS;
      });
      checked.set(key, entry);
      return entry.done;
    },
  };
}
