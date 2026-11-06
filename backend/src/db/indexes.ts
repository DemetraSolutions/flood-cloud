import { isDeepStrictEqual } from 'node:util';
import type { Db, Document } from 'mongodb';
import { COLLECTIONS, validateRegistry } from './collections.ts';
import type { CollectionRegistry } from './collections.ts';
import type { Databases } from './databases.ts';
import type { Logger } from '../shared/logging/logger.ts';

/** MongoDB error code of `createCollection` on a collection that already exists. */
const NAMESPACE_EXISTS = 48;

/** MongoDB error code of a command the user is not allowed to run. */
const UNAUTHORIZED = 13;

/** The two settings every validator of this backend is applied with. */
const VALIDATION_SETTINGS = { validationLevel: 'strict', validationAction: 'error' } as const;

/**
 * Applies a `$jsonSchema` validator to a collection of the common database, creating the collection
 * when missing. For an existing collection the current validator is read first and `collMod` runs only
 * if it differs (deep comparison, key order ignored): the database user of a shared cluster may lack the
 * `collMod` privilege, and a validator that is already right needs none. If `collMod` is refused with
 * `Unauthorized` the problem is logged and the application-level validation keeps protecting the data.
 */
async function applyValidator(db: Db, name: string, validator: Readonly<Record<string, unknown>>, logger: Pick<Logger, 'error'>): Promise<void> {
  const options = { validator: { $jsonSchema: validator }, ...VALIDATION_SETTINGS } as const;
  const [existing] = await db.listCollections({ name }).toArray();
  if (existing === undefined) {
    try {
      await db.createCollection(name, options);
      return;
    } catch (error) {
      // Another instance created it in the meantime: fall through to the update.
      if ((error as { code?: unknown }).code !== NAMESPACE_EXISTS) {
        throw error;
      }
    }
  } else {
    const current = ((existing as { options?: Document }).options ?? {}) as Document;
    if (isDeepStrictEqual(current['validator'], options.validator) && current['validationLevel'] === options.validationLevel && current['validationAction'] === options.validationAction) {
      return;
    }
  }
  try {
    await db.command({ collMod: name, ...options });
  } catch (error) {
    if ((error as { code?: unknown }).code !== UNAUTHORIZED) {
      throw error;
    }
    logger.error(`validator out of date for ${name}: the database user needs the collMod privilege; application-level validation still applies`, { collection: name });
  }
}

/**
 * Creates, idempotently, the validators and the indexes declared in the registry on the common database.
 * Group databases declare no indexes or validators yet: declaring one is rejected instead of being silently ignored.
 * Safe to call on every startup.
 *
 * @param databases Database accessor.
 * @param registry Registry to apply (`COLLECTIONS` for the real one; tests pass their own).
 * @param logger Receives the `error` about a validator that is out of date and cannot be updated for lack of the `collMod` privilege.
 * @throws {Error} If the registry violates the coexistence rules or declares a group index or validator.
 */
export async function ensureIndexes(databases: Databases, registry: CollectionRegistry, logger: Pick<Logger, 'error'>): Promise<void> {
  validateRegistry(registry);
  for (const [name, spec] of Object.entries(registry.group)) {
    if ((spec.indexes?.length ?? 0) > 0) {
      throw new Error(`group.${name}: indexes on group databases are not supported yet`);
    }
    if (spec.validator !== undefined) {
      throw new Error(`group.${name}: validators on group databases are not supported yet`);
    }
  }
  for (const [name, spec] of Object.entries(registry.common)) {
    if (spec.validator !== undefined) {
      await applyValidator(databases.common(), name, spec.validator, logger);
    }
    if (spec.indexes === undefined || spec.indexes.length === 0) {
      continue;
    }
    const collection = databases.common().collection(name);
    await collection.createIndexes(
      spec.indexes.map(({ key, name: indexName, unique, expireAfterSeconds, partialFilterExpression }) => ({
        key: { ...key },
        name: indexName,
        ...(unique === true ? { unique } : {}),
        ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}),
        ...(partialFilterExpression !== undefined ? { partialFilterExpression: { ...partialFilterExpression } } : {}),
      })),
    );
    // Only after the replacements exist, so queries are never left without an index.
    const existing = new Set((await collection.indexes()).map((index) => index.name));
    for (const obsolete of spec.obsoleteIndexes ?? []) {
      if (existing.has(obsolete)) {
        await collection.dropIndex(obsolete);
      }
    }
  }
}
