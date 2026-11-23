import { COLLECTIONS, validateRegistry } from './collections.ts';
import type { CollectionRegistry } from './collections.ts';
import type { Databases } from './databases.ts';

/**
 * Creates, idempotently, the indexes declared in the registry on the common database.
 * Group databases declare no indexes yet: declaring one is rejected instead of being silently ignored.
 * Safe to call on every startup.
 *
 * @param databases Database accessor.
 * @param registry Registry to apply (`COLLECTIONS` for the real one; tests pass their own).
 * @throws {Error} If the registry violates the coexistence rules or declares a group index.
 */
export async function ensureIndexes(databases: Databases, registry: CollectionRegistry): Promise<void> {
  validateRegistry(registry);
  for (const [name, spec] of Object.entries(registry.group)) {
    if ((spec.indexes?.length ?? 0) > 0) {
      throw new Error(`group.${name}: indexes on group databases are not supported yet`);
    }
  }
  for (const [name, spec] of Object.entries(registry.common)) {
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
