import type { Db } from 'mongodb';
import { COLLECTIONS, validateRegistry } from './collections.ts';
import type { CollectionRegistry } from './collections.ts';
import type { Databases } from './databases.ts';

/** MongoDB error code of `createCollection` on a collection that already exists. */
const NAMESPACE_EXISTS = 48;

/**
 * Applies a `$jsonSchema` validator to a collection of the common database, creating the collection
 * when missing and otherwise updating the validator in place (`collMod`), so it is idempotent.
 */
async function applyValidator(db: Db, name: string, validator: Readonly<Record<string, unknown>>): Promise<void> {
  const options = { validator: { $jsonSchema: validator }, validationLevel: 'strict', validationAction: 'error' } as const;
  if ((await db.listCollections({ name }, { nameOnly: true }).toArray()).length === 0) {
    try {
      await db.createCollection(name, options);
      return;
    } catch (error) {
      // Another instance created it in the meantime: fall through to the update.
      if ((error as { code?: unknown }).code !== NAMESPACE_EXISTS) {
        throw error;
      }
    }
  }
  await db.command({ collMod: name, ...options });
}

/**
 * Creates, idempotently, the validators and the indexes declared in the registry on the common database.
 * Group databases declare no indexes or validators yet: declaring one is rejected instead of being silently ignored.
 * Safe to call on every startup.
 *
 * @param databases Database accessor.
 * @param registry Registry to apply (the real one by default; tests pass their own).
 * @throws {Error} If the registry violates the coexistence rules or declares a group index or validator.
 */
export async function ensureIndexes(databases: Databases, registry: CollectionRegistry = COLLECTIONS): Promise<void> {
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
      await applyValidator(databases.common(), name, spec.validator);
    }
    if (spec.indexes === undefined || spec.indexes.length === 0) {
      continue;
    }
    const collection = databases.common().collection(name);
    await collection.createIndexes(
      spec.indexes.map(({ key, name: indexName, unique, expireAfterSeconds }) => ({
        key: { ...key },
        name: indexName,
        ...(unique === true ? { unique } : {}),
        ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}),
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
