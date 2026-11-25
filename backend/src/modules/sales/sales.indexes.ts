import type { Db, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';

/**
 * The index the purchases of a customer are read with: the customer, then the date, newest first. The legacy has no index on `customer._id`, and the legacy creates its own indexes on the sales only at every sale, so this one is the first the new backend creates
 * on a collection the legacy owns (an exception to the rule "no index on the legacy collections of the sales", decided by the user at step V1). The index is not unique and holds no data of its own.
 */
export const SALES_CUSTOMER_INDEX = Object.freeze({ key: Object.freeze({ 'customer._id': 1 as const, date: -1 as const }), options: Object.freeze({ name: 'customer._id_1_date_-1' }) });

/** The `codeName` of the answers that say the index is, or is being, there already: they are not a failure. */
const ALREADY_THERE: readonly string[] = ['IndexBuildAlreadyInProgress', 'IndexOptionsConflict', 'IndexKeySpecsConflict'];

/**
 * Creates the index of the purchases of a customer in a group database, once, and reports how it went in the log, never failing: the read that asked for it goes on with its own time limit. An index that exists already with another name
 * (an administrator made it) or is being built is `info`; any other failure is `error` with the group and the kind of failure, never the text of the server's message.
 *
 * @param db The group database.
 * @param groupId The group, for the log.
 * @param logger Where the outcome is reported.
 * @returns `false` when the creation failed for a reason other than the index being there already or being built (the guard tries again later).
 */
export async function createSalesCustomerIndex(db: Db, groupId: ObjectId, logger: Logger): Promise<boolean> {
  try {
    await db.collection('sales').createIndex({ ...SALES_CUSTOMER_INDEX.key }, { ...SALES_CUSTOMER_INDEX.options });
    return true;
  } catch (error) {
    const failure = error as { readonly name?: unknown; readonly code?: unknown; readonly codeName?: unknown };
    const fields = { groupId: groupId.toHexString(), errorName: String(failure.name), errorCode: typeof failure.code === 'number' ? failure.code : null };
    if (typeof failure.codeName === 'string' && ALREADY_THERE.includes(failure.codeName)) {
      logger.info('the index on the customer of the sales exists already or is being built', fields);
      return true;
    }
    logger.error('the index on the customer of the sales could not be created', fields);
    return false;
  }
}

/** Makes sure a group has the index of the purchases of a customer, the first time this process reads them. */
export interface SalesIndexGuard {
  /**
   * Starts the creation of the index if this process has not checked the group yet (once per group and process; a real failure is logged and tried again only after {@link SALES_INDEX_RETRY_MS}). The caller does not wait for it: the promise never rejects, so it can be
   * ignored, and tests wait for it.
   */
  ensure(principal: AuthPrincipal, access: GroupAccess): Promise<void>;
}

/** The shortest time before a failed creation of the index is tried again (a failure is not repeated on every read). */
export const SALES_INDEX_RETRY_MS = 10 * 60 * 1000;

/**
 * Builds the guard of the index.
 *
 * @param databases Database accessor.
 * @param logger Where the outcome is reported.
 * @param now Clock in epoch milliseconds (tests move it).
 */
export function createSalesIndexGuard(databases: Databases, logger: Logger, now: () => number = Date.now): SalesIndexGuard {
  const checked = new Map<string, { readonly done: Promise<void>; retryAt: number | null }>();
  return {
    ensure: (principal, access) => {
      const key = access.groupId.toHexString();
      const known = checked.get(key);
      if (known !== undefined && (known.retryAt === null || now() < known.retryAt)) {
        return known.done;
      }
      const entry: { done: Promise<void>; retryAt: number | null } = { done: Promise.resolve(), retryAt: null };
      entry.done = createSalesCustomerIndex(groupDatabaseFor(principal, access, databases), access.groupId, logger).then((created) => {
        entry.retryAt = created ? null : now() + SALES_INDEX_RETRY_MS;
      });
      checked.set(key, entry);
      return entry.done;
    },
  };
}
