import type { AggregateOptions, ClientSession, CountDocumentsOptions, Db, Document, Filter, FindCursor, FindOptions, MongoClient, ObjectId, Sort, WithId } from 'mongodb';
import type { AggregationCursor } from 'mongodb';
import type { ClusterId } from '../config.ts';
import type { ClusterClients, ClusterRegistry } from './clusters.ts';
import { commonDatabaseName, groupDatabaseName, parseGroupDatabaseName } from './names.ts';
import type { DatabaseNameContext } from './names.ts';

/** Escapes a string for literal use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** MongoDB rejects database names longer than 63 bytes. */
export const MAX_DATABASE_NAME_BYTES = 63;

/** Upper bound for the administrative commands (listing databases, server version) in milliseconds. */
const ADMIN_MAX_TIME_MS = 30_000;

/**
 * Environment guard: accepts only `^<prefix><appEnv>_(common|<24 hex>)$`, at most 63 bytes long.
 * It keeps `production_*` databases out of reach when `APP_ENV=development` and vice versa.
 *
 * @param name Database name to check.
 * @param context Prefix and environment.
 * @throws {Error} If the name does not belong to this environment (the message never contains the URI).
 */
export function assertAllowedDatabaseName(name: string, context: DatabaseNameContext): void {
  const allowed = new RegExp(`^${escapeRegExp(context.prefix)}${escapeRegExp(context.appEnv)}_(common|[0-9a-f]{24})$`);
  if (!allowed.test(name) || Buffer.byteLength(name) > MAX_DATABASE_NAME_BYTES) {
    throw new Error(`Database "${name}" is not allowed in environment "${context.appEnv}"`);
  }
}

/**
 * A cursor restricted to reading. It deliberately hides the driver's cursor, which holds a reference to
 * the `MongoClient` (`cursor.client`) and could therefore reach any database with write access.
 */
export interface ReadOnlyCursor<T extends Document = Document> {
  /** Reads every remaining document into memory: only for results known to be small. */
  toArray(): Promise<T[]>;
  /** The next document, or `null` when the cursor is exhausted. */
  next(): Promise<T | null>;
  /** Whether another document is available. */
  hasNext(): Promise<boolean>;
  /** Closes the cursor on the server. */
  close(): Promise<void>;
  /** Sort order (find cursors only). */
  sort(sort: Sort): ReadOnlyCursor<T>;
  /** Maximum number of documents. */
  limit(value: number): ReadOnlyCursor<T>;
  /** Number of documents to skip (find cursors only). */
  skip(value: number): ReadOnlyCursor<T>;
  /** Projection (find cursors only). */
  project(value: Document): ReadOnlyCursor<T>;
  /** Server-side time limit in milliseconds. */
  maxTimeMS(value: number): ReadOnlyCursor<T>;
  [Symbol.asyncIterator](): AsyncGenerator<T, void, void>;
}

/** The read methods of a collection exposed through the analytics connection. */
export interface ReadOnlyCollection {
  find(filter: Filter<Document>, options?: FindOptions): ReadOnlyCursor;
  findOne(filter: Filter<Document>, options?: FindOptions): Promise<WithId<Document> | null>;
  /**
   * @throws {Error} Before calling the driver, if a top-level stage is `$out` or `$merge` (they write).
   */
  aggregate(pipeline: Document[], options?: AggregateOptions): ReadOnlyCursor;
  countDocuments(filter: Filter<Document>, options?: CountDocumentsOptions): Promise<number>;
  estimatedDocumentCount(): Promise<number>;
  distinct(key: string, filter: Filter<Document>): Promise<unknown[]>;
}

/** Stages that write to a collection. */
const WRITING_STAGES = ['$out', '$merge'];

/**
 * A database handle that can only read: it offers collections restricted to {@link ReadOnlyCollection}.
 * Heavy reads (statistics, reports) use it so they run on the analytics node and can never write.
 */
export interface ReadOnlyDb {
  /**
   * @param name Collection name.
   * @returns A collection with read methods only.
   */
  collection(name: string): ReadOnlyCollection;
}

/**
 * Thrown when a group must be reached on a cluster that is not configured, or whose declared id is not valid.
 * The central error handler answers `503 SERVICE_UNAVAILABLE` and logs `groupId` and `clusterId`: guessing
 * another cluster would risk reading or writing the data of a group in the wrong place.
 */
export class UnknownClusterError extends Error {
  /** The group concerned as 24 hex characters, or `null` for a cluster-level operation. */
  readonly groupId: string | null;
  /** The cluster id that could not be served: sanitized and at most 64 characters, `[invalid]` when the declared value is not a string. */
  readonly clusterId: string;

  /**
   * @param clusterId The requested cluster id (any value: it may come from a stored document).
   * @param groupId The group concerned, if any.
   */
  constructor(clusterId: unknown, groupId: ObjectId | null = null) {
    super('Cluster is not configured');
    this.name = 'UnknownClusterError';
    this.groupId = groupId === null ? null : groupId.toHexString();
    this.clusterId = typeof clusterId === 'string' ? clusterId.replace(/[^\x21-\x7e]/g, '?').slice(0, 64) : '[invalid]';
  }
}

/** The only way to obtain a `Db` handle. */
export interface Databases {
  /** Ids of the configured clusters, in configuration order. */
  readonly clusterIds: readonly ClusterId[];
  /** The cluster of the common database. */
  readonly commonCluster: ClusterId;
  /** The common database (identity, tenancy, security) on the common cluster. */
  common(): Db;
  /**
   * The operational database of a group on the cluster that holds its data.
   *
   * @param groupId Group id taken from the authenticated context or from a database name.
   * @param clusterId Cluster of the group, from {@link Databases.resolveGroupCluster}.
   * @throws {UnknownClusterError} If the cluster is not configured.
   */
  group(groupId: ObjectId, clusterId: ClusterId): Db;
  /** The common database through the analytics connection of the common cluster (reads only). */
  analyticsCommon(): ReadOnlyDb;
  /**
   * The operational database of a group through the analytics connection of its cluster (reads only).
   *
   * @throws {UnknownClusterError} If the cluster is not configured.
   */
  analyticsGroup(groupId: ObjectId, clusterId: ClusterId): ReadOnlyDb;
  /**
   * The cluster that holds the data of a group: its `dataCluster` when valid and configured, the default
   * cluster when the field is absent. A `dataCluster` that is present but not valid or not configured is
   * never replaced with the default (the group's data would end up in the wrong cluster).
   *
   * @param group The `groups` document, projected on `_id` and `dataCluster`.
   * @throws {UnknownClusterError} If `dataCluster` is present and not usable.
   */
  resolveGroupCluster(group: { readonly _id: ObjectId; readonly dataCluster?: unknown }): ClusterId;
  /**
   * Runs `work` in a transaction (replica set) on the **common cluster**: every write that receives the
   * session commits together or none does. There are no transactions across clusters: an operation that
   * involves the common database and a group on another cluster cannot be atomic. The driver retries
   * `work` on transient errors and on an unknown commit result, so it must hold database operations only
   * (no side effect that cannot be repeated). Whatever `work` throws aborts the transaction and is rethrown.
   *
   * @param work The operations, each passing the session it is given.
   * @returns What `work` returned.
   */
  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
  /**
   * Ids of the group databases that exist on a cluster for this prefix and environment
   * (names are parsed, never trusted), sorted by hex.
   *
   * @throws {UnknownClusterError} If the cluster is not configured.
   */
  listGroupIds(clusterId: ClusterId): Promise<ObjectId[]>;
  /**
   * Counts the databases of a cluster that are neither the common database nor a group database of this
   * environment. Only counts leave: the names never do.
   *
   * @returns `flite_common` and `queue` (the other products' databases of this environment) and `other`.
   * @throws {UnknownClusterError} If the cluster is not configured.
   */
  countOtherDatabases(clusterId: ClusterId): Promise<Record<'flite_common' | 'queue' | 'other', number>>;
  /**
   * Version string of the MongoDB server of a cluster.
   *
   * @throws {UnknownClusterError} If the cluster is not configured.
   */
  serverVersion(clusterId: ClusterId): Promise<string>;
}

/**
 * Builds the database accessor. Every name is built by `names.ts` and passes
 * {@link assertAllowedDatabaseName}; no other module may call the driver's database selector.
 *
 * @param registry The clients of every cluster.
 * @param context Prefix and environment from the configuration.
 * @returns The accessor.
 * @throws {Error} From `common()` / `group()` if the resulting name is not allowed.
 */
export function createDatabases(registry: ClusterRegistry, context: DatabaseNameContext): Databases {
  const clientsOf = (clusterId: ClusterId, groupId: ObjectId | null = null): ClusterClients => {
    const clients = registry.clusters.get(clusterId);
    if (clients === undefined) {
      throw new UnknownClusterError(clusterId, groupId);
    }
    return clients;
  };
  const open = (client: MongoClient, name: string): Db => {
    assertAllowedDatabaseName(name, context);
    return client.db(name);
  };
  const wrapCursor = (cursor: FindCursor<Document> | AggregationCursor<Document>): ReadOnlyCursor => {
    const chain = (apply: (c: FindCursor<Document> & AggregationCursor<Document>) => unknown): ReadOnlyCursor => {
      apply(cursor as FindCursor<Document> & AggregationCursor<Document>);
      return wrapped;
    };
    const wrapped: ReadOnlyCursor = {
      toArray: () => cursor.toArray(),
      next: () => cursor.next(),
      hasNext: () => cursor.hasNext(),
      close: () => cursor.close(),
      sort: (sort) => chain((c) => c.sort(sort)),
      limit: (value) => chain((c) => c.limit(value)),
      skip: (value) => chain((c) => c.skip(value)),
      project: (value) => chain((c) => c.project(value)),
      maxTimeMS: (value) => chain((c) => c.maxTimeMS(value)),
      async *[Symbol.asyncIterator]() {
        for await (const document of cursor) {
          yield document;
        }
      },
    };
    return wrapped;
  };
  const readOnly = (db: Db): ReadOnlyDb => ({
    collection: (name) => {
      const collection = db.collection(name);
      return {
        find: (filter, options = {}) => wrapCursor(collection.find(filter, options)),
        findOne: (filter, options = {}) => collection.findOne(filter, options),
        aggregate: (pipeline, options = {}) => {
          if (pipeline.some((stage) => WRITING_STAGES.some((writing) => Object.hasOwn(stage, writing)))) {
            throw new Error('Read-only aggregation cannot contain $out or $merge');
          }
          return wrapCursor(collection.aggregate(pipeline, options));
        },
        countDocuments: (filter, options = {}) => collection.countDocuments(filter, options),
        estimatedDocumentCount: () => collection.estimatedDocumentCount(),
        distinct: (key, filter) => collection.distinct(key, filter),
      };
    },
  });
  const listNames = async (clusterId: ClusterId): Promise<string[]> => {
    const { databases } = await clientsOf(clusterId).main.db().admin().listDatabases({ nameOnly: true, maxTimeMS: ADMIN_MAX_TIME_MS });
    return databases.map((entry) => entry.name);
  };
  const commonName = commonDatabaseName(context);
  return {
    clusterIds: [...registry.clusters.keys()],
    commonCluster: registry.commonCluster,
    common: () => open(clientsOf(registry.commonCluster).main, commonName),
    group: (groupId, clusterId) => open(clientsOf(clusterId, groupId).main, groupDatabaseName(context, groupId)),
    analyticsCommon: () => readOnly(open(clientsOf(registry.commonCluster).analytics, commonName)),
    analyticsGroup: (groupId, clusterId) => readOnly(open(clientsOf(clusterId, groupId).analytics, groupDatabaseName(context, groupId))),
    resolveGroupCluster: (group) => {
      if (group.dataCluster === undefined) {
        return registry.defaultGroupCluster;
      }
      if (typeof group.dataCluster !== 'string' || !registry.clusters.has(group.dataCluster)) {
        throw new UnknownClusterError(group.dataCluster, group._id);
      }
      return group.dataCluster;
    },
    transaction: (work) => clientsOf(registry.commonCluster).main.withSession((session) => session.withTransaction(() => work(session))),
    listGroupIds: async (clusterId) => {
      const ids: ObjectId[] = [];
      for (const name of await listNames(clusterId)) {
        const id = parseGroupDatabaseName(context, name);
        if (id !== null) {
          ids.push(id);
        }
      }
      return ids.sort((a, b) => a.toHexString().localeCompare(b.toHexString()));
    },
    countOtherDatabases: async (clusterId) => {
      const counts = { flite_common: 0, queue: 0, other: 0 };
      const head = `${context.prefix}${context.appEnv}_`;
      for (const name of await listNames(clusterId)) {
        if (name === commonName || parseGroupDatabaseName(context, name) !== null) {
          continue;
        }
        if (name === `${head}flite_common`) {
          counts.flite_common += 1;
        } else if (name === `${head}queue`) {
          counts.queue += 1;
        } else {
          counts.other += 1;
        }
      }
      return counts;
    },
    serverVersion: async (clusterId) => {
      const info = await clientsOf(clusterId).main.db().admin().command({ buildInfo: 1, maxTimeMS: ADMIN_MAX_TIME_MS });
      return String(info['version']);
    },
  };
}
