import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import { readPlaceCashStorages } from '../../shared/security/scope/group-mirror.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { isRecord } from '../groups/catalogs/kit.ts';
import type { StockBarcode, StockComponent, StockProduct } from './stock.resolve.ts';

/** What a movement of the warehouse is made for: a sale, a fiscal or stock document, or a manual movement. */
export type StockOriginKind = 'sale' | 'document' | 'manual';

/** The origin of the movements of the warehouse: what asked for them. Everything that moves the warehouse is reconciled against one origin. */
export interface StockOrigin {
  readonly kind: StockOriginKind;
  readonly id: ObjectId;
}

/** The fields of a product the stock reads: what the resolution needs, and the allowlist of the snapshot a movement keeps. */
const PRODUCT_PROJECTION = Object.freeze({
  _id: 1,
  type: 1,
  availability: 1,
  measureConversionRatio: 1,
  'bundleProducts._id': 1,
  'bundleProducts.quantity': 1,
  'bundleProducts.waste': 1,
  'barcode.value': 1,
  'barcode.qtLoad': 1,
  code: 1,
  name: 1,
  measureLoad: 1,
  'lastAveragePrice.total.weightedAveragePrice': 1,
});

/** The most places times storages times products a single origin may have moved (a sale or a document is far below it): the state of an origin is read with one aggregation limited to this many rows. */
export const MAX_STATE_ROWS = 20_000;

/** How much an origin has moved a product in a storage of a place, summed over all its movements. */
export interface StockRow {
  readonly placeId: ObjectId;
  readonly storageId: ObjectId;
  readonly productId: ObjectId;
  /** The company of the movements that moved it. */
  readonly companyId: ObjectId;
  /** The sum of the signed values of the records, in load units. */
  readonly value: number;
}

/** The warehouse part of the setup of a group: whether the feature is on, and its rules in the legacy shape. */
export interface StockSetup {
  /** `settings.warehouse === true`. */
  readonly enabled: boolean;
  /** The values of the `warehouseRules` map of the group (`{ id, type: 'L' | 'D', quantity: '+' | '-', cashL, cashD, ... }`), in stored order. */
  readonly rules: readonly Readonly<Record<string, unknown>>[];
}

/** The `warehouse` movements, the `products` stock and the data around them (group, point of sale), as the stock service sees them. Every read and write is scoped to the group of the verified access. */
export interface StockRepository {
  /** Whether the group has the warehouse and its rules, read from the group in the common database. */
  readSetup(principal: ScopeHolder, access: GroupAccess): Promise<StockSetup>;
  /** The ids of the storages of the cash desks (`cash === true`) of a point of sale, in stored order, read from the copy of the point of sale of the group (`group-mirror.ts`); none when the place is not there. */
  readCashStorages(principal: ScopeHolder, access: GroupAccess, placeId: ObjectId): Promise<ObjectId[]>;
  /** The products with some ids, in the minimal view the stock needs. The caller keeps the list to a few hundred ids. */
  findProducts(principal: ScopeHolder, access: GroupAccess, ids: readonly ObjectId[]): Promise<StockProduct[]>;
  /**
   * What an origin has moved so far, by storage and product.
   *
   * @throws {Error} When the origin has more rows than the repository allows (a bug, not a business case).
   */
  currentState(principal: ScopeHolder, access: GroupAccess, origin: StockOrigin): Promise<StockRow[]>;
  /**
   * What the legacy moved for a sale (movements with its `saleId` and no `origin`), by storage and product, signed by the sign of the rule of each movement: the state an adopted sale already has (step VS4a).
   *
   * @throws {Error} When the sale has more rows than the repository allows (a bug, not a business case).
   */
  legacyState(principal: ScopeHolder, access: GroupAccess, saleId: ObjectId): Promise<StockRow[]>;
  /** How many movements an origin has. */
  countMovements(principal: ScopeHolder, access: GroupAccess, origin: StockOrigin): Promise<number>;
  /** Adds a signed quantity to the stock of a product in a storage of a place (`$inc` of `quantity.__<place>.__<storage>.value`, nothing else of the product); `false` when the product is not there. */
  addToStock(principal: ScopeHolder, access: GroupAccess, productId: ObjectId, placeId: ObjectId, storageId: ObjectId, delta: number): Promise<boolean>;
  /** Inserts a movement document (the caller builds it and runs this in the transaction of the stock it moves). */
  insertMovement(principal: ScopeHolder, access: GroupAccess, movement: Document): Promise<void>;
}

/** An id stored as an `ObjectId` or as the hexadecimal text an older client wrote; `null` for anything else. */
function idOf(raw: unknown): ObjectId | null {
  if (raw instanceof ObjectId) {
    return raw;
  }
  return typeof raw === 'string' && /^[0-9a-f]{24}$/.test(raw) ? ObjectId.createFromHexString(raw) : null;
}

/**
 * The minimal view of a stored product. A component with an id that is not an id is left out (it names no product), and anything that is not a list is an empty list.
 *
 * @param document The stored product, read with the projection of the stock.
 * @returns The view.
 */
export function stockProductOf(document: Document): StockProduct {
  const records = (raw: unknown): Readonly<Record<string, unknown>>[] => (Array.isArray(raw) ? (raw as unknown[]).filter(isRecord) : []);
  const bundleProducts: StockComponent[] = records(document['bundleProducts']).flatMap((item) => {
    const id = idOf(item['_id']);
    return id === null ? [] : [{ _id: id, quantity: item['quantity'], waste: item['waste'] }];
  });
  const barcode: StockBarcode[] = records(document['barcode']).map((item) => ({ value: item['value'], qtLoad: item['qtLoad'] }));
  const price = isRecord(document['lastAveragePrice']) && isRecord(document['lastAveragePrice']['total']) ? document['lastAveragePrice']['total']['weightedAveragePrice'] : null;
  return {
    _id: document['_id'] as ObjectId,
    type: document['type'],
    availability: isRecord(document['availability']) ? document['availability'] : {},
    measureConversionRatio: document['measureConversionRatio'],
    bundleProducts,
    barcode,
    code: document['code'],
    name: document['name'],
    measureLoad: document['measureLoad'],
    weightedAveragePrice: price,
  };
}

/**
 * Builds the repository over a database accessor: the real one in a request, or the one bound to the session of a transaction (`sessionDatabases`) so every read and write is part of it.
 *
 * @param databases Database accessor.
 * @param options `maxStateRows`: how many rows the state of an origin may have (tests lower it).
 */
export function createStockRepository(databases: Databases, options: { readonly maxStateRows?: number } = {}): StockRepository {
  const maxStateRows = options.maxStateRows ?? MAX_STATE_ROWS;
  return {
    readSetup: async (_principal, access) => {
      const group = await bounded(() => databases.common().collection('groups').findOne({ _id: access.groupId }, { projection: { 'settings.warehouse': 1, warehouseRules: 1 }, maxTimeMS: LIST_MAX_TIME_MS }));
      const settings = group?.['settings'];
      const rules = group?.['warehouseRules'];
      return { enabled: isRecord(settings) && settings['warehouse'] === true, rules: isRecord(rules) ? Object.values(rules).filter(isRecord) : [] };
    },

    readCashStorages: async (principal, access, placeId) => {
      const place = await bounded(() => readPlaceCashStorages(principal, access, databases, placeId));
      const storages = Array.isArray(place?.['storages']) ? (place['storages'] as unknown[]) : [];
      return storages.flatMap((storage) => {
        const id = isRecord(storage) && storage['cash'] === true ? idOf(storage['id']) : null;
        return id === null ? [] : [id];
      });
    },

    findProducts: async (principal, access, ids) => {
      const found = await bounded(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('products')
          .find({ _id: { $in: [...ids] } }, { projection: { ...PRODUCT_PROJECTION }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      return found.map(stockProductOf);
    },

    currentState: async (principal, access, origin) => {
      const rows = await bounded(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('warehouse')
          .aggregate(
            [
              { $match: { 'origin.kind': origin.kind, 'origin.id': origin.id } },
              { $unwind: '$records' },
              { $group: { _id: { placeId: '$placeId', storageId: '$storageId', productId: '$records.product._id' }, companyId: { $first: '$companyId' }, value: { $sum: '$records.value' } } },
              { $limit: maxStateRows + 1 },
            ],
            { maxTimeMS: LIST_MAX_TIME_MS },
          )
          .toArray(),
      );
      if (rows.length > maxStateRows) {
        throw new Error('An origin of the warehouse has more rows than the stock reads');
      }
      return rows.map((row) => ({ placeId: row['_id'].placeId as ObjectId, storageId: row['_id'].storageId as ObjectId, productId: row['_id'].productId as ObjectId, companyId: row['companyId'] as ObjectId, value: row['value'] as number }));
    },

    legacyState: async (principal, access, saleId) => {
      const rows = await bounded(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('warehouse')
          .aggregate(
            [
              { $match: { saleId, origin: { $exists: false } } },
              { $unwind: '$records' },
              { $group: { _id: { placeId: '$placeId', storageId: '$storageId', productId: '$records.product._id' }, companyId: { $first: '$companyId' }, value: { $sum: { $switch: { branches: [{ case: { $eq: ['$rule.quantity', '+'] }, then: '$records.quantity' }, { case: { $eq: ['$rule.quantity', '-'] }, then: { $multiply: ['$records.quantity', -1] } }], default: 0 } } } } },
              { $limit: maxStateRows + 1 },
            ],
            { maxTimeMS: LIST_MAX_TIME_MS },
          )
          .toArray(),
      );
      if (rows.length > maxStateRows) {
        throw new Error('A sale has more legacy movements than the stock reads');
      }
      return rows.flatMap((row) => {
        const value = row['value'] as number;
        const ids = row['_id'] as { placeId: unknown; storageId: unknown; productId: unknown };
        return value === 0 || !(ids.placeId instanceof ObjectId) || !(ids.storageId instanceof ObjectId) || !(ids.productId instanceof ObjectId) || !(row['companyId'] instanceof ObjectId)
          ? []
          : [{ placeId: ids.placeId, storageId: ids.storageId, productId: ids.productId, companyId: row['companyId'], value }];
      });
    },

    countMovements: (principal, access, origin) =>
      bounded(() => groupDatabaseFor(principal, access, databases).collection('warehouse').countDocuments({ 'origin.kind': origin.kind, 'origin.id': origin.id }, { maxTimeMS: LIST_MAX_TIME_MS })),

    addToStock: async (principal, access, productId, placeId, storageId, delta) => {
      const result = await groupDatabaseFor(principal, access, databases)
        .collection('products')
        .updateOne({ _id: productId }, { $inc: { [`quantity.__${placeId.toHexString()}.__${storageId.toHexString()}.value`]: delta } });
      return result.matchedCount === 1;
    },

    insertMovement: async (principal, access, movement) => {
      await groupDatabaseFor(principal, access, databases).collection('warehouse').insertOne({ ...movement });
    },
  };
}
