import { COLLECTIONS, validateRegistry } from './collections.ts';
import type { CollectionRegistry } from './collections.ts';
import type { Databases } from './databases.ts';

/**
 * Creates, idempotently, the indexes declared in the registry on the common database.
 * Group databases declare no indexes yet: declaring one is rejected instead of being silently ignored.
 * Safe to call on every startup.
 *
 * @param databases Database accessor.
 * @param registry Registry to apply (the real one by default; tests pass their own).
 * @throws {Error} If the registry violates the coexistence rules or declares a group index.
 */
export async function ensureIndexes(databases: Databases, registry: CollectionRegistry = COLLECTIONS): Promise<void> {
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
    await databases.common().collection(name).createIndexes(
      spec.indexes.map(({ key, name: indexName, unique, expireAfterSeconds }) => ({
        key: { ...key },
        name: indexName,
        ...(unique === true ? { unique } : {}),
        ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}),
      })),
    );
  }
}
