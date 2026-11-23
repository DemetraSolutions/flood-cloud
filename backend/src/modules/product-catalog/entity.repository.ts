import type { Collection, Db, Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, pageOf } from '../../shared/http/list.ts';
import type { ListConfig, ListPage, ListParams } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { CatalogCaller } from './caller.ts';
import { withScope } from '../../shared/security/scope/scope-filters.ts';
import { visibleTo } from './availability.ts';

/** What changes in a stored entry: the fields to set and to unset, and the new date of the change. */
export interface EntityChange {
  readonly set: Document;
  readonly unset: Document;
  readonly updateDate: Date;
  /** The `placesAvailability` that was read (`undefined` when the document had none), which the write requires the document to still hold: the legacy writes the places without touching `updateDate`. */
  readonly readPlaces: unknown;
  /** The containers the write sets leaves below (`integrations`, `printStations`…): the write requires each of them to be missing or an object, so it never fails on a document the legacy left in a strange shape. */
  readonly intact?: readonly string[];
  /** The value each whole field the write sets had when it was read (`undefined` when it was missing): the write requires it to still be that, so a list or a text another writer changed meanwhile is never overwritten. */
  readonly readValues?: Readonly<Record<string, unknown>>;
}

/** The documents of one catalog collection (the departments or the brands) of a group database, as seen by a caller. */
export interface EntityRepository {
  /**
   * A page of the entries the caller reaches.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter The filter of the request (search, state), combined with what the caller may reach.
   * @param params Validated list parameters.
   * @param config How the list is sorted, for the language of the caller.
   */
  list(principal: CatalogCaller, access: GroupAccess, filter: Filter<Document>, params: ListParams, config: ListConfig): Promise<ListPage>;
  /**
   * One entry, or `null` when it does not exist in the group or the caller does not reach it (a company or place administrator reaches the entries for every place and the ones that name a place of his own).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the entry.
   */
  findById(principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<Document | null>;
  /**
   * Inserts a whole new entry.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param document The document, built by the service.
   */
  insert(principal: CatalogCaller, access: GroupAccess, document: Document): Promise<void>;
  /**
   * Applies a change, only if the entry still has the date it was read with, so a change made meanwhile is never overwritten. Only the given fields are touched: every other key of the document stays.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the entry.
   * @param change The fields and the new date.
   * @param readDate The `updateDate` the entry had when it was read, of whatever type (`undefined` when it had none): the write requires exactly that value.
   * @returns `updated`, or `conflict` when the entry changed (or disappeared) since it was read, or a container of {@link EntityChange.intact} is not an object.
   */
  update(principal: CatalogCaller, access: GroupAccess, id: ObjectId, change: EntityChange, readDate: unknown): Promise<'updated' | 'conflict'>;
  /**
   * Deletes an entry.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the entry.
   * @param readDate The `updateDate` the entry had when it was read (any type, `undefined` when it had none): the deletion requires exactly that value.
   * @param readPlaces The `placesAvailability` the entry had when it was read (`undefined` when it had none): the deletion requires exactly that value too.
   * @returns Whether an entry was deleted (`false` when it changed or disappeared since it was read).
   */
  remove(principal: CatalogCaller, access: GroupAccess, id: ObjectId, readDate: unknown, readPlaces: unknown): Promise<boolean>;
}

/** The read of whole entries, which only the collections that a client downloads need (the products). */
export interface FullListing {
  /**
   * A page of the whole entries the caller reaches (every owned field, not the summary of {@link EntityRepository.list}), in the order of the list configuration, minus some fields that are not read at all.
   *
   * @param principal The caller.
   * @param access Verified access to the group.
   * @param filter The filter of the request, combined with what the caller may reach.
   * @param params Validated list parameters.
   * @param config How the list is sorted.
   * @param omit Top-level fields (or paths) that are left out of the projection, so they are never read from the database.
   */
  listFull(principal: CatalogCaller, access: GroupAccess, filter: Filter<Document>, params: ListParams, config: ListConfig, omit?: readonly string[]): Promise<ListPage>;
}

/** How a repository is built over one collection. */
export interface EntityRepositoryOptions {
  /** Opens the collection in a group database (the name of the collection is a literal in the module that owns it). */
  readonly open: (db: Db) => Collection<Document>;
  /** The fields of the collection this backend owns: they are all read, so the version of an entry covers everything the backend can write. */
  readonly ownedFields: readonly string[];
  /** The fields a list returns. */
  readonly summary: Readonly<Record<string, 1>>;
  /**
   * The owned fields that are owned as a whole, with every path below them (a map whose keys are made at run time). When it is given, every other field is owned by exact equality only: a leaf is
   * written because it is listed. When it is left out (the departments and the brands) an owned field is owned with everything below it.
   */
  readonly trees?: readonly string[];
  /** The filter of what a caller reaches ({@link visibleTo} for the departments and the brands, whose availability is a list of place ids). */
  readonly visible?: (principal: CatalogCaller) => Filter<Document>;
  /** Whether a path is owned although it is not listed (the leaves of a map whose keys are made at run time, and nothing else of it). */
  readonly owns?: (path: string) => boolean;
  /** The owned fields a new document has and a modification never writes: they are never read (apart from the {@link EntityRepositoryOptions.readFields}) and a modification refuses to write them. */
  readonly insertOnly?: readonly string[];
  /** The fields that are read although a modification never writes them (they stay in the projection of an entry). */
  readonly readFields?: readonly string[];
}

/** The projection of one entry: every owned field. */
export function entityProjection(ownedFields: readonly string[]): Readonly<Record<string, 1>> {
  // A field below another listed one is already in the projection (MongoDB refuses both: a path collision).
  const own = ownedFields.filter((field) => !ownedFields.some((other) => field.startsWith(`${other}.`)));
  return Object.freeze(Object.fromEntries(own.map((field) => [field, 1 as const])));
}

/**
 * The condition that a field still holds exactly the value that was read, whatever its type or none: `$eq` takes the stored value (which the legacy wrote, and could look like an operator) as a literal.
 *
 * @param field The field.
 * @param read The value read (`undefined` when the document had no such field).
 */
export function sameAs(field: string, read: unknown): Filter<Document> {
  return { [field]: read === undefined ? { $exists: false } : { $eq: read } };
}

/**
 * Builds the repository of a catalog collection. The collection is opened from the verified group access, so an entry of another group is never reachable; the keys a write sets are checked against
 * the owned fields of the collection, and nothing else of the document is touched.
 *
 * @param databases Database accessor.
 * @param options The collection and its fields.
 */
export function createEntityRepository(databases: Databases, options: EntityRepositoryOptions): EntityRepository & FullListing {
  const insertOnly = new Set(options.insertOnly ?? []);
  const writable = options.ownedFields.filter((field) => !insertOnly.has(field));
  const owned = new Set(writable);
  const projection = entityProjection([...writable, ...(options.readFields ?? [])]);
  const visible = options.visible ?? visibleTo;
  const entries = (principal: CatalogCaller, access: GroupAccess): Collection<Document> => options.open(groupDatabaseFor(principal, access, databases));
  /** Whether a path is owned: it is listed, or (the default) something above it is, or (with `trees`) it is below a tree. */
  const isOwned = (path: string): boolean => {
    const segments = path.split('.');
    const prefixes = segments.map((_, index) => segments.slice(0, index + 1).join('.'));
    if (options.owns?.(path) === true) {
      return true;
    }
    return options.trees === undefined ? prefixes.some((prefix) => owned.has(prefix)) : owned.has(path) || options.trees.some((tree) => path.startsWith(`${tree}.`));
  };
  /** A path to write must be one the backend owns. */
  const assertOwned = (keys: Iterable<string>): void => {
    for (const key of keys) {
      if (!isOwned(key)) {
        throw new Error(`Refusing to write ${key}: not an owned field`);
      }
    }
  };
  /** A key of a new document must be owned, or hold owned leaves (`integrations`, which is owned leaf by leaf). */
  const assertOwnedKeys = (keys: Iterable<string>): void => {
    for (const key of keys) {
      if (!isOwned(key) && !insertOnly.has(key) && !options.ownedFields.some((field) => field.startsWith(`${key}.`))) {
        throw new Error(`Refusing to write ${key}: not an owned field`);
      }
    }
  };
  return {
    list: async (principal, access, filter, params, config) =>
      pageOf(
        await bounded(() => entries(principal, access).aggregate(listPipeline(withScope(visible(principal), filter), params, config, options.summary), { maxTimeMS: LIST_MAX_TIME_MS }).toArray()),
        params,
      ),

    listFull: async (principal, access, filter, params, config, omit = []) => {
      const wanted = Object.fromEntries(Object.entries(projection).filter(([path]) => !omit.some((left) => path === left || path.startsWith(`${left}.`)))) as Record<string, 1>;
      return pageOf(await bounded(() => entries(principal, access).aggregate(listPipeline(withScope(visible(principal), filter), params, config, wanted), { maxTimeMS: LIST_MAX_TIME_MS }).toArray()), params);
    },

    findById: (principal, access, id) => bounded(() => entries(principal, access).findOne(withScope(visible(principal), { _id: id }), { projection, maxTimeMS: LIST_MAX_TIME_MS })),

    insert: async (principal, access, document) => {
      assertOwnedKeys(Object.keys(document).filter((key) => key !== '_id'));
      await entries(principal, access).insertOne(document);
    },

    update: async (principal, access, id, change, readDate) => {
      assertOwned([...Object.keys(change.set), ...Object.keys(change.unset)]);
      const update: Document = { $set: { ...change.set, updateDate: change.updateDate } };
      if (Object.keys(change.unset).length > 0) {
        update['$unset'] = change.unset;
      }
      const intact: Filter<Document>[] = (change.intact ?? []).map((path) => ({ $or: [{ [path]: { $exists: false } }, { [path]: { $type: 'object' } }] }));
      const unchanged: Filter<Document>[] = Object.entries(change.readValues ?? {}).map(([path, read]) => sameAs(path, read));
      const conditions = [...intact, ...unchanged];
      const guard: Filter<Document> = { _id: id, ...sameAs('updateDate', readDate), ...sameAs('placesAvailability', change.readPlaces), ...(conditions.length === 0 ? {} : { $and: conditions }) };
      const result = await entries(principal, access).updateOne(guard, update);
      return result.matchedCount === 1 ? 'updated' : 'conflict';
    },

    remove: async (principal, access, id, readDate, readPlaces) =>
      (await entries(principal, access).deleteOne({ _id: id, ...sameAs('updateDate', readDate), ...sameAs('placesAvailability', readPlaces) })).deletedCount === 1,
  };
}
