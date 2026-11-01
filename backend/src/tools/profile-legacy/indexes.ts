import type { Collection, Db } from 'mongodb';
import { hasCollection, MAX_TIME_MS } from './read.ts';

/** Description of an index; the content of a partial filter never leaves, only its presence. */
export interface IndexInfo {
  name: string;
  key: Record<string, number | string>;
  unique: boolean;
  sparse: boolean;
  expireAfterSeconds: number | null;
  hasPartialFilter: boolean;
}

/** An index with the number of databases in which it was found. */
export interface IndexUsage extends IndexInfo {
  databases: number;
}

/**
 * Reads the indexes of a collection.
 *
 * @param db Database that holds the collection.
 * @param collection The collection (it may not exist yet).
 * @returns The indexes, or an empty list when the collection does not exist.
 */
export async function listIndexInfo(db: Db, collection: Collection): Promise<IndexInfo[]> {
  if (!(await hasCollection(db, collection.collectionName))) {
    return [];
  }
  const raw = await collection.listIndexes({ maxTimeMS: MAX_TIME_MS }).toArray();
  return raw.map((index) => ({
    name: String(index['name']),
    key: { ...(index['key'] as Record<string, number | string>) },
    unique: index['unique'] === true,
    sparse: index['sparse'] === true,
    expireAfterSeconds: typeof index['expireAfterSeconds'] === 'number' ? index['expireAfterSeconds'] : null,
    hasPartialFilter: index['partialFilterExpression'] !== undefined,
  }));
}

/** Accumulator that merges the indexes of many databases. */
export interface IndexUnion {
  /** Adds the indexes of one database. */
  add(indexes: readonly IndexInfo[]): void;
  /** Distinct indexes with the number of databases that have them, sorted by name. */
  result(): IndexUsage[];
}

/**
 * Creates an accumulator that merges the indexes of many databases (same name, keys and flags
 * count once per database).
 *
 * @returns The accumulator.
 */
export function indexUnion(): IndexUnion {
  const merged = new Map<string, IndexUsage>();
  return {
    add(indexes) {
      for (const index of indexes) {
        const id = JSON.stringify(index);
        const known = merged.get(id);
        if (known === undefined) {
          merged.set(id, { ...index, databases: 1 });
        } else {
          known.databases += 1;
        }
      }
    },
    result() {
      return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name) || b.databases - a.databases);
    },
  };
}
