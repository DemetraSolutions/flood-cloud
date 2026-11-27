import type { Db, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';

/**
 * The unique index of the counters of the numbering: one counter per company, series, sectional and year. It is what makes two counters of the same key impossible (two concurrent first documents of a year cannot both create it), so the numbering
 * refuses to run in a group where it could not be created. `document_counters` is a collection of this backend (the legacy does not know it), so the unique index is allowed; it is created at run time because group databases declare no indexes in the registry.
 */
export const NUMBERING_COUNTERS_INDEX = Object.freeze({
  key: Object.freeze({ companyId: 1 as const, series: 1 as const, prefixSuffix: 1 as const, year: 1 as const }),
  options: Object.freeze({ name: 'companyId_1_series_1_prefixSuffix_1_year_1', unique: true }),
});

/**
 * The index the highest number of a company, type and sectional in a year is read with: the range of the year on `date` bounds the keys scanned to the documents of that year, and the highest number among them is a top-one sort (an index on `number` would
 * scan every document of the earlier years first, whose numbers are higher than those of a year that has just started). It is not unique and holds no data of its own: the first one the new backend creates on `documents`, a collection the legacy owns (an exception to the rule "no index on the legacy
 * collections", decided by the user at step VS3, like the one of the sales).
 */
export const DOCUMENTS_NUMBER_INDEX = Object.freeze({
  key: Object.freeze({ companyId: 1 as const, type: 1 as const, prefixSuffix: 1 as const, date: -1 as const }),
  options: Object.freeze({ name: 'companyId_1_type_1_prefixSuffix_1_date_-1' }),
});

/** The index the highest `progressivo_invio` of a company in a year is read with (all the types and sectionals): the company and the date. Not unique, same exception as {@link DOCUMENTS_NUMBER_INDEX}. */
export const DOCUMENTS_DATE_INDEX = Object.freeze({
  key: Object.freeze({ companyId: 1 as const, date: -1 as const }),
  options: Object.freeze({ name: 'companyId_1_date_-1' }),
});

/** The `codeName` of the answers that say the index is, or is being, there already: they are not a failure. */
const ALREADY_THERE: readonly string[] = ['IndexBuildAlreadyInProgress', 'IndexOptionsConflict', 'IndexKeySpecsConflict'];

/** Creates one index and tells how it went: `true` when it is there (made now, or before, or being built), `false` after logging the failure (never the text of the server's message). */
async function create(run: () => Promise<unknown>, indexName: string, groupId: ObjectId, logger: Logger): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    const failure = error as { readonly name?: unknown; readonly code?: unknown; readonly codeName?: unknown };
    const fields = { groupId: groupId.toHexString(), index: indexName, errorName: String(failure.name), errorCode: typeof failure.code === 'number' ? failure.code : null };
    if (typeof failure.codeName === 'string' && ALREADY_THERE.includes(failure.codeName)) {
      logger.info('an index of the numbering of the documents exists already or is being built', fields);
      return true;
    }
    logger.error('an index of the numbering of the documents could not be created', fields);
    return false;
  }
}

/**
 * Creates the indexes of the numbering in a group database (the unique one of the counters and the two supporting ones of `documents`) and reports how it went in the log, never failing.
 *
 * @param db The group database.
 * @param groupId The group, for the log.
 * @param logger Where the outcome is reported.
 * @returns `true` when the unique index of the counters is there (the supporting indexes only make the reads faster: a failure to create one is logged and does not stop the numbering).
 */
export async function createNumberingIndexes(db: Db, groupId: ObjectId, logger: Logger): Promise<boolean> {
  // Literal collection names: the collection registry check requires them.
  const counters = await create(() => db.collection('document_counters').createIndex({ ...NUMBERING_COUNTERS_INDEX.key }, { ...NUMBERING_COUNTERS_INDEX.options }), NUMBERING_COUNTERS_INDEX.options.name, groupId, logger);
  await create(() => db.collection('documents').createIndex({ ...DOCUMENTS_NUMBER_INDEX.key }, { ...DOCUMENTS_NUMBER_INDEX.options }), DOCUMENTS_NUMBER_INDEX.options.name, groupId, logger);
  await create(() => db.collection('documents').createIndex({ ...DOCUMENTS_DATE_INDEX.key }, { ...DOCUMENTS_DATE_INDEX.options }), DOCUMENTS_DATE_INDEX.options.name, groupId, logger);
  return counters;
}

/** Makes sure a group has the indexes of the numbering before this process numbers its first document. */
export interface NumberingIndexGuard {
  /**
   * Creates the indexes if this process has not confirmed the group yet (once per group and process: the answer is kept only when the unique index is there, so a failure is tried again at the next call). It never rejects. It must run **outside** a
   * transaction: an index is not created inside one, so a caller that holds a transaction open calls it before opening it.
   *
   * @returns `true` when the unique index of the counters is there.
   */
  ensure(principal: ScopeHolder, access: GroupAccess): Promise<boolean>;
  /** Whether {@link NumberingIndexGuard.ensure} confirmed the group in this process. */
  confirmed(access: GroupAccess): boolean;
}

/**
 * Builds the guard of the indexes.
 *
 * @param databases Database accessor (never one bound to a transaction).
 * @param logger Where the outcome is reported.
 */
export function createNumberingIndexGuard(databases: Databases, logger: Logger): NumberingIndexGuard {
  const checking = new Map<string, Promise<boolean>>();
  const done = new Set<string>();
  return {
    ensure: (principal, access) => {
      const key = access.groupId.toHexString();
      if (done.has(key)) {
        return Promise.resolve(true);
      }
      const running = checking.get(key);
      if (running !== undefined) {
        return running;
      }
      const started = createNumberingIndexes(groupDatabaseFor(principal, access, databases), access.groupId, logger).then((created) => {
        checking.delete(key);
        if (created) {
          done.add(key);
        }
        return created;
      });
      checking.set(key, started);
      return started;
    },
    confirmed: (access) => done.has(access.groupId.toHexString()),
  };
}
