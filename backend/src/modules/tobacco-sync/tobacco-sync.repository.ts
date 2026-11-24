import { ObjectId } from 'mongodb';
import type { AnyBulkWriteOperation, Collection, Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { groupMirror } from '../../shared/security/scope/group-mirror.ts';
import { valueAt } from '../groups/catalogs/kit.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { MAX_TOBACCOS } from '../tobaccos/tobaccos.sheet.ts';
import { PLAN_PRODUCT_FIELDS } from './tobacco-sync.plan.ts';

/** Most products of the types tobaccos, games and monopoly a group may have for the synchronization: more is `413`. */
export const MAX_TGM_PRODUCTS = 60_000;

/** Most categories a group may have for the synchronization: more is `413`. */
export const MAX_SYNC_CATEGORIES = 10_000;

/** Operations of one `bulkWrite` inside the transaction. */
export const WRITE_BATCH = 500;

/** The bounds of the reads (tests lower them). */
export interface SyncReadLimits {
  readonly maxList?: number;
  readonly maxProducts?: number;
  readonly maxCategories?: number;
}

/** A point of sale of the group. */
export interface SyncPlace {
  readonly id: string;
  readonly name: string;
}

/** The index of the activity log the last synchronization is read with (`{ action: 1, at: -1 }`): named, so the read never depends on the planner choosing it. */
export const LAST_SYNC_INDEX = 'action_1_at_-1';

/**
 * The filter and the options of the read of the last synchronization of a group that wrote: the newest `tobaccos.synced` entry (the index is in the order of the date) that succeeded and was not a dry run.
 *
 * @param groupId The group, from the verified access.
 */
export function lastSyncQuery(groupId: ObjectId) {
  return [{ groupId, action: 'tobaccos.synced', outcome: 'success', 'metadata.dryRun': false }, { projection: { at: 1, metadata: 1 }, sort: { at: -1 }, limit: 1, maxTimeMS: LIST_MAX_TIME_MS, hint: LAST_SYNC_INDEX }] as const;
}

/** The reads of the synchronization that are not part of the transaction (the common database and the copies of the places). */
export interface TobaccoSyncReads {
  /** The points of sale of the group that are not in the trash and have the tobaccos on, by name, at most `limit`. */
  tobaccoPlaces(principal: CatalogCaller, access: GroupAccess, limit: number): Promise<SyncPlace[]>;
  /** The points of sale of the group among these ids that are not in the trash, each with whether it has the tobaccos on (at most a few hundred ids). */
  existingPlaces(principal: CatalogCaller, access: GroupAccess, ids: readonly ObjectId[]): Promise<Map<string, boolean>>;
  /** How many products the national price list has (counted up to `MAX_TOBACCOS + 1`) and when it was imported (the creation time of its newest document), `null` when it is empty. */
  listStats(): Promise<{ readonly entries: number; readonly importedAt: Date | null }>;
  /** The whole price list, in the order of the ids, only the fields the synchronization reads; `null` when it has more than {@link MAX_TOBACCOS} products. */
  readList(maxTimeMS: number): Promise<Document[] | null>;
  /** The newest successful synchronization (not a dry run) of the group in the activity log: its date and the counts, `null` when there is none (the log keeps entries for a limited time). */
  lastSync(groupId: ObjectId): Promise<{ readonly at: Date; readonly metadata: Document } | null>;
}

/** The reads and writes of the group database of the synchronization; built over the accessor of the transaction. */
export interface TobaccoSyncGroupStore {
  /** The products of the types tobaccos, games and monopoly, in the order of their ids, with the fields the plan reads. @throws {AppError} `PAYLOAD_TOO_LARGE`. */
  tgmProducts(principal: CatalogCaller, access: GroupAccess, maxTimeMS: number): Promise<Document[]>;
  /** The categories (`_id`, `name`), in the order of their ids. @throws {AppError} `PAYLOAD_TOO_LARGE`. */
  categories(principal: CatalogCaller, access: GroupAccess, maxTimeMS: number): Promise<Document[]>;
  /** Applies operations to the categories of the group, in batches of {@link WRITE_BATCH}; `beforeBatch` runs before each one (it throws to stop). */
  writeCategories(principal: CatalogCaller, access: GroupAccess, operations: readonly AnyBulkWriteOperation<Document>[], beforeBatch: () => void): Promise<void>;
  /** Applies operations to the products of the group, in batches of {@link WRITE_BATCH}; `beforeBatch` runs before each one (it throws to stop). */
  writeProducts(principal: CatalogCaller, access: GroupAccess, operations: readonly AnyBulkWriteOperation<Document>[], beforeBatch: () => void): Promise<void>;
}

/**
 * The reads of the synchronization outside the transaction.
 *
 * @param databases Database accessor.
 * @param limits The bounds of the reads.
 */
export function createTobaccoSyncReads(databases: Databases, limits: SyncReadLimits = {}): TobaccoSyncReads {
  const maxList = limits.maxList ?? MAX_TOBACCOS;
  return {
    tobaccoPlaces: async (principal, access, limit) =>
      (await groupMirror(principal, access, databases, 'places').find({ trash: { $ne: true }, 'tgm.status': true }, { projection: { _id: 1, name: 1 }, limit, sort: { name: 1, _id: 1 } })).map((place) => ({
        id: (place['_id'] as ObjectId).toHexString(),
        name: typeof place['name'] === 'string' ? place['name'] : '',
      })),

    existingPlaces: async (principal, access, ids) =>
      new Map(
        (await groupMirror(principal, access, databases, 'places').find({ trash: { $ne: true }, _id: { $in: [...ids] } }, { projection: { _id: 1, 'tgm.status': 1 }, limit: ids.length })).map((place): [string, boolean] => [
          (place['_id'] as ObjectId).toHexString(),
          valueAt(place, 'tgm.status') === true,
        ]),
      ),

    listStats: async () => {
      const collection = databases.common().collection('tobaccos');
      const [entries, newest] = await bounded(() =>
        Promise.all([collection.countDocuments({}, { limit: MAX_TOBACCOS + 1, maxTimeMS: LIST_MAX_TIME_MS }), collection.find({}, { projection: { _id: 1 }, sort: { _id: -1 }, limit: 1, maxTimeMS: LIST_MAX_TIME_MS }).toArray()]),
      );
      return { entries, importedAt: newest[0] === undefined ? null : (newest[0]['_id'] as ObjectId).getTimestamp() };
    },

    readList: async (maxTimeMS) => {
      const found = await bounded(() =>
        databases
          .common()
          .collection('tobaccos')
          .find({}, { projection: { code: 1, name: 1, category: 1, price: 1, description: 1, 'barcodes.barcode': 1, 'barcodes.quantity': 1 }, sort: { _id: 1 }, limit: maxList + 1, maxTimeMS })
          .toArray(),
      );
      return found.length > maxList ? null : found;
    },

    lastSync: async (groupId) => {
      const found = await bounded(() =>
        databases
          .common()
          .collection('activityEvents')
          .find(...lastSyncQuery(groupId))
          .toArray(),
      );
      return found[0] === undefined ? null : { at: found[0]['at'] as Date, metadata: found[0]['metadata'] as Document };
    },
  };
}

/** Applies operations to a collection in batches, one `bulkWrite` after the other (a transaction runs one operation at a time). */
async function writeBatches(target: Collection<Document>, operations: readonly AnyBulkWriteOperation<Document>[], beforeBatch: () => void): Promise<void> {
  for (let from = 0; from < operations.length; from += WRITE_BATCH) {
    beforeBatch();
    await target.bulkWrite(operations.slice(from, from + WRITE_BATCH), { ordered: true });
  }
}

/**
 * The group database side of the synchronization, over an accessor (the plain one or the one of a transaction). The database is opened from the verified access.
 *
 * @param databases Database accessor.
 * @param limits The bounds of the reads.
 */
export function createTobaccoSyncGroupStore(databases: Databases, limits: SyncReadLimits = {}): TobaccoSyncGroupStore {
  const maxProducts = limits.maxProducts ?? MAX_TGM_PRODUCTS;
  const maxCategories = limits.maxCategories ?? MAX_SYNC_CATEGORIES;
  return {
    tgmProducts: async (principal, access, maxTimeMS) => {
      const found = await bounded(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('products')
          .find({ type: { $in: ['tobaccos', 'games', 'monopoly'] } }, { projection: Object.fromEntries(PLAN_PRODUCT_FIELDS.map((field) => [field, 1])), sort: { _id: 1 }, limit: maxProducts + 1, maxTimeMS })
          .toArray(),
      );
      if (found.length > maxProducts) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: `The group has more than ${String(maxProducts)} tobacco, game and monopoly products` });
      }
      return found;
    },

    categories: async (principal, access, maxTimeMS) => {
      const found = await bounded(() =>
        groupDatabaseFor(principal, access, databases).collection('products_categories').find({}, { projection: { name: 1 }, sort: { _id: 1 }, limit: maxCategories + 1, maxTimeMS }).toArray(),
      );
      if (found.length > maxCategories) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: `The group has more than ${String(maxCategories)} categories` });
      }
      return found;
    },

    writeCategories: (principal, access, operations, beforeBatch) => writeBatches(groupDatabaseFor(principal, access, databases).collection('products_categories'), operations, beforeBatch),

    writeProducts: (principal, access, operations, beforeBatch) => writeBatches(groupDatabaseFor(principal, access, databases).collection('products'), operations, beforeBatch),
  };
}
