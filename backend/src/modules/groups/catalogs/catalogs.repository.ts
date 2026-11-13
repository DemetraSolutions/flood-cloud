import type { Collection, Document, Filter, ObjectId } from 'mongodb';
import { GROUPS_OWNED_CATALOGS, GROUPS_OWNED_FIELDS } from '../../../db/collections.ts';
import type { Databases } from '../../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../../shared/http/list.ts';
import type { ContainerChange } from './catalog.ts';
import { equal, isRecord, valueAt } from './kit.ts';

/** The stored containers of a group, read in one query. */
export interface StoredCatalogs {
  /** The `updateDate` of the document: the version the write is checked against. */
  readonly updateDate: unknown;
  /** Size in bytes of the whole stored document (BSON, computed by the database): the base of the size budget of a write. */
  readonly size: number;
  /** The value at each requested path (`undefined` when the group has none). */
  readonly values: Readonly<Record<string, unknown>>;
}

/** The result of {@link CatalogsRepository.apply}. */
export type CatalogWriteOutcome = 'updated' | 'notFound' | 'conflict' | 'malformed';

/** The `$set` and `$unset` of a write. */
export interface CatalogUpdate {
  readonly set: Readonly<Record<string, unknown>>;
  readonly unset: Readonly<Record<string, ''>>;
}

/** Reads and writes the catalogs stored in the legacy `common.groups` document. */
export interface CatalogsRepository {
  /**
   * Reads some paths of a group with the `updateDate` and the size of the whole document (nothing else of the document is loaded: the size is computed by the database).
   *
   * @param id Id of the group.
   * @param paths Stored paths.
   * @returns The values, or `null` when the group does not exist.
   */
  read(id: ObjectId, paths: readonly string[]): Promise<StoredCatalogs | null>;
  /**
   * Writes the new containers. The write applies only if the document still has the `updateDate` that was read (optimistic concurrency) and if every
   * parent container of a path is an object; otherwise nothing is written.
   *
   * @param id Id of the group.
   * @param changes The containers to write.
   * @param expected The `updateDate` read with the containers.
   * @param now The new `updateDate`.
   * @returns `updated`; `notFound`; `conflict` when the document changed since it was read; `malformed` when a parent container (`fidelity`) is not an object.
   * @throws {Error} If a path is outside the catalogs the backend owns.
   */
  apply(id: ObjectId, changes: readonly ContainerChange[], expected: unknown, now: Date): Promise<CatalogWriteOutcome>;
}

/** Name of the computed field that carries the size of the document in the projection of a read (a name no legacy field uses). */
const DOCUMENT_SIZE_FIELD = '__floodDocumentSize';

/** Ids that cannot be a segment of an update path: the whole container is written instead. */
const unsafeKey = (key: string): boolean => key === '' || key.includes('.') || key.startsWith('$');

/**
 * Builds the update of some container changes. An array is replaced as a whole. A map is written element by element (`path.<id>.<field>` for what
 * changed, `path.<id>` for a new element, `$unset` for a removed one), so a write never overwrites what it did not change; a map that is not an object, or
 * has a key that cannot be a path segment, is replaced as a whole.
 *
 * @param changes The containers to write.
 * @returns The `$set` and `$unset` paths.
 * @throws {Error} If a path is outside the owned catalogs.
 */
export function buildCatalogUpdate(changes: readonly ContainerChange[]): CatalogUpdate {
  const owned = new Set(GROUPS_OWNED_FIELDS);
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  const assertOwned = (path: string): void => {
    if (!owned.has(path) && !GROUPS_OWNED_CATALOGS.some((root) => path.startsWith(`${root}.`))) {
      throw new Error(`Refusing to write ${path}: not an owned catalog path`);
    }
  };
  const put = (path: string, value: unknown): void => {
    assertOwned(path);
    set[path] = value;
  };
  for (const change of changes) {
    const next = change.next as Readonly<Record<string, unknown>>;
    const old = change.old;
    if (change.kind === 'array' || !isRecord(old) || [...Object.keys(next), ...Object.keys(old)].some(unsafeKey)) {
      put(change.path, change.next);
      continue;
    }
    for (const [id, element] of Object.entries(next)) {
      const stored = old[id];
      if (!isRecord(element) || !isRecord(stored)) {
        if (!equal(stored, element)) {
          put(`${change.path}.${id}`, element);
        }
        continue;
      }
      for (const [field, value] of Object.entries(element)) {
        if (!equal(stored[field], value)) {
          put(`${change.path}.${id}.${field}`, value);
        }
      }
    }
    for (const id of Object.keys(old)) {
      if (!Object.hasOwn(next, id)) {
        assertOwned(`${change.path}.${id}`);
        unset[`${change.path}.${id}`] = '';
      }
    }
  }
  return { set, unset };
}

/** The proper prefixes of the paths (`fidelity` for `fidelity.cardsTypes`): the containers an update creates or writes into. */
function parentsOf(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap((path) => path.split('.').slice(0, -1).map((_segment, index, parts) => parts.slice(0, index + 1).join('.'))))];
}

/**
 * Builds the catalogs repository over `common.groups`.
 *
 * @param databases Database accessor.
 */
export function createCatalogsRepository(databases: Databases): CatalogsRepository {
  const groups = (): Collection<Document> => databases.common().collection('groups');
  return {
    read: async (id, paths) => {
      const projection = { updateDate: 1, [DOCUMENT_SIZE_FIELD]: { $bsonSize: '$$ROOT' }, ...Object.fromEntries(paths.map((path) => [path, 1 as const])) };
      const document = await groups().findOne({ _id: id }, { projection, maxTimeMS: LIST_MAX_TIME_MS });
      return document === null
        ? null
        : { updateDate: document['updateDate'], size: document[DOCUMENT_SIZE_FIELD] as number, values: Object.fromEntries(paths.map((path) => [path, valueAt(document, path)])) };
    },

    apply: async (id, changes, expected, now) => {
      const { set, unset } = buildCatalogUpdate(changes);
      const parents = parentsOf(changes.map((change) => change.path));
      const intact: Filter<Document>[] = parents.map((path) => ({ $or: [{ [path]: { $exists: false } }, { [path]: { $type: 'object' } }] }));
      const version: Filter<Document> = expected === undefined ? { updateDate: { $exists: false } } : { updateDate: expected };
      const update: Document = { $set: { ...set, updateDate: now } };
      if (Object.keys(unset).length > 0) {
        update['$unset'] = unset;
      }
      const result = await groups().updateOne({ _id: id, ...version, ...(intact.length === 0 ? {} : { $and: intact }) }, update);
      if (result.matchedCount === 1) {
        return 'updated';
      }
      if ((await groups().countDocuments({ _id: id }, { limit: 1 })) === 0) {
        return 'notFound';
      }
      return intact.length > 0 && (await groups().countDocuments({ _id: id, $and: intact }, { limit: 1 })) === 0 ? 'malformed' : 'conflict';
    },
  };
}
