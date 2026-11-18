import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import type { ClusterId } from '../config.ts';
import type { Databases } from './databases.ts';
import { assertAllowedDatabaseName } from './databases.ts';
import { commonDatabaseName, groupDatabaseName, parseGroupDatabaseName, queueDatabaseName } from './names.ts';
import type { DatabaseNameContext } from './names.ts';

/** Upper bound for the administrative reads of the purge, in milliseconds. */
const MAX_TIME_MS = 30_000;

/** The collections of a group database whose newest `_id` tells when the group last worked (legacy sales and documents). */
const ACTIVITY_COLLECTIONS: readonly string[] = Object.freeze(['sales', 'documents']);

/** What a group database holds, as read by {@link GroupDatabasePurger.describe}. */
export interface GroupDatabaseSummary {
  /** Collections, views and time series that {@link GroupDatabasePurger.drop} would drop (the system collections are never counted). */
  readonly collections: number;
  /** Sum of the estimated document counts of the real collections (views hold none). */
  readonly documents: number;
  /** The newest creation time found in the `_id` of `sales` and `documents` (one indexed sort each), `null` when there is none or the ids are not ObjectIds. */
  readonly newestActivity: Date | null;
}

/**
 * Handle for the destructive operations on the operational database of a group. It is not part of `Databases`, so the running server cannot reach it:
 * only the tool that purges trashed groups imports its factory.
 */
export interface GroupDatabasePurger {
  /**
   * Counts what the database holds, for the audit before a purge. Read only; a database that does not exist is empty.
   *
   * @param groupId The group.
   * @param clusterId Cluster of the group, from `Databases.resolveGroupCluster`.
   * @throws {Error} If the name fails {@link assertPurgeableGroupDatabase}, or the cluster is not configured.
   */
  describe(groupId: ObjectId, clusterId: ClusterId): Promise<GroupDatabaseSummary>;
  /**
   * Drops every collection of the database, one by one (views first, then the empty `system.views` they leave, which would keep the database in the listing; no other
   * system collection). A collection that is already gone is not an error, so the call can be repeated after a failure. Irreversible.
   *
   * @param groupId The group.
   * @param clusterId Cluster of the group, from `Databases.resolveGroupCluster`.
   * @returns How many collections, views and time series this call listed and dropped.
   * @throws {Error} If the name fails {@link assertPurgeableGroupDatabase}, or the cluster is not configured.
   */
  drop(groupId: ObjectId, clusterId: ClusterId): Promise<number>;
}

/**
 * Environment and identity guard of the purge of a group database: the name must be allowed in this environment, must be neither the common nor the queue
 * database, and must parse back to exactly this group id.
 *
 * @param name The database name about to be emptied.
 * @param groupId The group the database must belong to.
 * @param context Prefix and environment.
 * @throws {Error} If any of the conditions fails (the message never contains a connection string).
 */
export function assertPurgeableGroupDatabase(name: string, groupId: ObjectId, context: DatabaseNameContext): void {
  assertAllowedDatabaseName(name, context);
  if (name === commonDatabaseName(context) || name === queueDatabaseName(context)) {
    throw new Error(`Database "${name}" is not a group database`);
  }
  const parsed = parseGroupDatabaseName(context, name);
  if (parsed === null || !parsed.equals(groupId)) {
    throw new Error(`Database "${name}" does not belong to the group ${groupId.toHexString()}`);
  }
}

/**
 * Builds the purger over a database accessor: every database it opens is the group database from `Databases.group` (so the environment guard applies) and has
 * passed {@link assertPurgeableGroupDatabase}.
 *
 * @param databases Database accessor.
 * @param context Prefix and environment of the run.
 */
export function createGroupDatabasePurger(databases: Databases, context: DatabaseNameContext): GroupDatabasePurger {
  const open = (groupId: ObjectId, clusterId: ClusterId): Db => {
    assertPurgeableGroupDatabase(groupDatabaseName(context, groupId), groupId, context);
    return databases.group(groupId, clusterId);
  };
  /** The collections of a database that a purge handles: everything but the `system.*` ones, views first. */
  const entriesOf = async (db: Db): Promise<Array<{ name: string; type?: string }>> => {
    const entries = await db.listCollections({}, { nameOnly: false }).toArray();
    return entries.filter((entry) => !entry.name.startsWith('system.')).sort((a, b) => Number(b.type === 'view') - Number(a.type === 'view') || a.name.localeCompare(b.name));
  };
  return {
    describe: async (groupId, clusterId) => {
      const db = open(groupId, clusterId);
      const entries = await entriesOf(db);
      let documents = 0;
      let newest: Date | null = null;
      for (const entry of entries.filter((candidate) => candidate.type === 'collection')) {
        // The `count` command without a query reads the counter of the collection (an estimate, like `estimatedDocumentCount`).
        documents += Number((await db.command({ count: entry.name, maxTimeMS: MAX_TIME_MS }))['n']);
        if (ACTIVITY_COLLECTIONS.includes(entry.name)) {
          const reply = await db.command({ find: entry.name, filter: {}, projection: { _id: 1 }, sort: { _id: -1 }, limit: 1, singleBatch: true, maxTimeMS: MAX_TIME_MS });
          const id = (reply['cursor'] as { firstBatch: Array<{ _id?: unknown }> }).firstBatch[0]?._id;
          if (id instanceof ObjectId && (newest === null || id.getTimestamp() > newest)) {
            newest = id.getTimestamp();
          }
        }
      }
      return { collections: entries.length, documents, newestActivity: newest };
    },
    drop: async (groupId, clusterId) => {
      const db = open(groupId, clusterId);
      let dropped = 0;
      for (const entry of await entriesOf(db)) {
        // The server answers success for a collection that is already gone (dropped meanwhile): the goal is reached.
        await db.dropCollection(entry.name);
        dropped += 1;
      }
      if ((await db.listCollections({ name: 'system.views' }, { nameOnly: true }).toArray()).length > 0) {
        await db.dropCollection('system.views');
      }
      return dropped;
    },
  };
}
