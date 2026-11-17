import { ObjectId } from 'mongodb';
import type { Db, Document } from 'mongodb';
import type { Databases } from '../../src/db/databases.ts';
import { sameDocument } from '../../src/shared/legacy-write/copy-rule.ts';

/** What a hook does instead of (or around) the driver call: it receives the real call and its arguments. */
export type Hook = (call: () => Promise<unknown>, args: unknown[]) => Promise<unknown>;

/** Hooks by collection name, then by method name. */
export type Hooks = Readonly<Record<string, Readonly<Record<string, Hook>>>>;

function wrapCollection(collection: object, hooks: Readonly<Record<string, Hook>> | undefined): object {
  return new Proxy(collection, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      const hook = typeof property === 'string' ? hooks?.[property] : undefined;
      if (hook !== undefined) {
        return (...args: unknown[]) => hook(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args), args);
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function wrapDb(db: Db, hooks: Hooks | undefined): Db {
  return { collection: (name: string) => wrapCollection(db.collection(name), hooks?.[name]) } as unknown as Db;
}

/**
 * A `Databases` whose `common()` and `group()` handles run hooks around the collection methods named in `hooks`: used to make a step of the
 * write service fail, or to let the legacy write between two of its steps. Everything else is the real accessor.
 *
 * @param databases The real accessor.
 * @param hooks Hooks of the common database and of the group databases.
 */
export function withHooks(databases: Databases, hooks: { readonly common?: Hooks; readonly group?: Hooks }): Databases {
  return {
    ...databases,
    common: () => wrapDb(databases.common(), hooks.common),
    group: (groupId, clusterId) => wrapDb(databases.group(groupId, clusterId), hooks.group),
  };
}

/** Every document of every collection of every database of a test prefix, as `<database>.<collection>`: to prove that a failed write changed nothing. */
export async function snapshotOf(client: { db(name: string): Db }, names: readonly string[]): Promise<Record<string, Document[]>> {
  const result: Record<string, Document[]> = {};
  for (const name of names) {
    const db = client.db(name);
    for (const entry of await db.listCollections({}, { nameOnly: true }).toArray()) {
      result[`${name}.${entry.name}`] = await db.collection(entry.name).find({}).sort({ _id: 1 }).toArray();
    }
  }
  return result;
}

/**
 * Asserts, by BSON bytes, that two versions of a document differ only in the named top-level fields (and have the same keys in the same order).
 *
 * @param before The document before the write.
 * @param after The document after the write.
 * @param changed Top-level fields that may differ.
 * @returns The names of the fields that really differ.
 */
export function differences(before: Document, after: Document, changed: readonly string[]): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const different: string[] = [];
  for (const key of keys) {
    if (!sameDocument({ v: before[key] }, { v: after[key] })) {
      different.push(key);
    }
  }
  const unexpected = different.filter((key) => !changed.includes(key));
  // `trashDate` comes and goes with the trash flag: it is a change like any other, but it does not make the order of the other keys differ.
  const order = (document: Document): string => JSON.stringify(Object.keys(document).filter((key) => key !== 'trashDate'));
  if (unexpected.length > 0 || order(before) !== order(after)) {
    throw new Error(`Unexpected changes: ${unexpected.join(', ')} (keys ${Object.keys(before).join()} -> ${Object.keys(after).join()})`);
  }
  return different;
}

/** A throw-away id for tests that need a document that does not exist. */
export const missingId = (): ObjectId => new ObjectId();
