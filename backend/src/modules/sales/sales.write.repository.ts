import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { SALES_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { isRecord } from '../groups/catalogs/kit.ts';
import { objectIdOrNull } from './sales.document.ts';
import type { CatalogProduct } from './sales.lines.ts';

/** The fields of a contact a sale copies (the customer of the sale): the allowlist of the fields of the legacy, never the account, the services, the notes, the price lists or the trash. */
const CONTACT_COPY_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  contactCode: 1,
  code: 1,
  name: 1,
  surname: 1,
  address: 1,
  postcode: 1,
  city: 1,
  countryCode: 1,
  countryAreaCode: 1,
  telephone: 1,
  email: 1,
  companyName: 1,
  companyCode: 1,
  companyCode2: 1,
  companyAddress: 1,
  companyPostcode: 1,
  companyCity: 1,
  companyCountryCode: 1,
  companyCountryAreaCode: 1,
  companyTelephone: 1,
  companyEmail: 1,
  'fattura_elettronica.formato_trasmissione': 1,
  'fattura_elettronica.identificativo': 1,
  'fattura_elettronica.codice_destinatario': 1,
  'fattura_elettronica.pec': 1,
  'fattura_elettronica.regime_fiscale': 1,
  'fattura_elettronica.split_payment': 1,
  'fidelities.code': 1,
  trash: 1,
});

/** The fields of a product a line reads from the catalog: its identity, the stock flag and the components, the costs. */
const CATALOG_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  code: 1,
  name: 1,
  type: 1,
  categories: 1,
  departmentId: 1,
  trash: 1,
  'availability.warehouse': 1,
  'bundleProducts._id': 1,
  'bundleProducts.quantity': 1,
  'bundleProducts.waste': 1,
  simpleCost: 1,
  'lastAveragePrice.total.averagePrice': 1,
  'roomsSettings.percentageFee': 1,
});

/** A change of a sale: a `$set` of owned fields (`SALES_OWNED_FIELDS`) only. */
export interface SaleChange {
  readonly $set: Readonly<Document>;
}

/** What a sale must have to be gathered by a deferred invoice (step VS5): the company and the customer of the invoice, and the perimeter of whoever writes it (the point of sale of a store key, `salesPerimeter` of a user). */
export interface UnpaidCriteria {
  readonly companyId: ObjectId;
  readonly customerId: ObjectId;
  readonly scope: Filter<Document>;
}

/** The reads and writes of the sales of a group in the legacy shape, always in the group database of the verified access. Built over a database accessor: the real one, or the one bound to a transaction. */
export interface SalesWriteRepository {
  /** The products of the catalog a body names (at most 500), by their ids, trashed ones included. */
  findCatalog(caller: ScopeHolder, access: GroupAccess, ids: readonly ObjectId[]): Promise<CatalogProduct[]>;
  /** A contact of the group with the fields a sale copies and whether it is in the trash; `null` when it is not of the group. */
  findContact(caller: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<{ readonly copy: Document; readonly trashed: boolean } | null>;
  /** The sale of a point of sale with a `timestampId`: the one this backend wrote (`floodCloud.key`) or, failing that, the legacy one (the point of sale as an `ObjectId` or as text). `null` when there is none. */
  findByKey(caller: ScopeHolder, access: GroupAccess, placeId: ObjectId, timestampId: string): Promise<Document | null>;
  /** A sale of a point of sale by its id, whole; `null` when it is not of that point of sale (or of the group). */
  findOfPlace(caller: ScopeHolder, access: GroupAccess, placeId: ObjectId, id: ObjectId): Promise<Document | null>;
  /** The sales of a point of sale that match a search, the newest first, whole. */
  search(caller: ScopeHolder, access: GroupAccess, placeId: ObjectId, filter: Filter<Document>, limit: number): Promise<Document[]>;
  /** Inserts a whole sale. */
  insert(caller: ScopeHolder, access: GroupAccess, sale: Document): Promise<void>;
  /** Changes a sale; `false` when it is not there any more. @throws {Error} When the change names a field this backend does not own. */
  update(caller: ScopeHolder, access: GroupAccess, id: ObjectId, change: SaleChange): Promise<boolean>;
  /** The tombstone a deleted sale left for its key, `null` when no sale with that key was ever deleted. */
  findTombstone(caller: ScopeHolder, access: GroupAccess, key: string): Promise<{ readonly saleId: ObjectId } | null>;
  /** Writes the tombstone of a sale that is being deleted (the caller runs it in the transaction of the deletion). */
  insertTombstone(caller: ScopeHolder, access: GroupAccess, tombstone: { readonly key: string; readonly saleId: ObjectId; readonly deletedAt: Date }): Promise<void>;
  /** Deletes a sale; `false` when it is not there any more. */
  remove(caller: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<boolean>;
  /** Which of the sales `ids` a deferred invoice may gather: within the perimeter of the writer, of the company and of the customer, fiscal, with something unpaid, not gathered yet, not canceled or returned, and never an invoice or the parent bill of a split table. */
  findGatherable(caller: ScopeHolder, access: GroupAccess, ids: readonly ObjectId[], criteria: UnpaidCriteria): Promise<ObjectId[]>;
  /** Marks the sales `ids` as gathered (`status: 'invoiced'`), only those that still meet the conditions of {@link SalesWriteRepository.findGatherable} when the write is made; returns how many it marked. */
  gather(caller: ScopeHolder, access: GroupAccess, ids: readonly ObjectId[], criteria: UnpaidCriteria, at: Date): Promise<number>;
  /** Records on the sale that its invoice is being handed to the send queue (`floodCloud.invoice.queuedAt`), only if no attempt was recorded yet: `true` for the one caller that wins it. */
  markQueued(caller: ScopeHolder, access: GroupAccess, id: ObjectId, at: Date): Promise<boolean>;
  /** Takes back the mark of {@link SalesWriteRepository.markQueued} when the queue refused the record, so a repetition of the sale may try again. */
  unmarkQueued(caller: ScopeHolder, access: GroupAccess, id: ObjectId): Promise<void>;
}

/** The products of the catalog as the lines read them: every field tolerantly, a component with no id left out. */
function catalogProductOf(document: Document): CatalogProduct {
  const availability = isRecord(document['availability']) ? document['availability'] : {};
  const bundle = Array.isArray(document['bundleProducts']) ? (document['bundleProducts'] as unknown[]).filter(isRecord) : [];
  const average = isRecord(document['lastAveragePrice']) && isRecord(document['lastAveragePrice']['total']) ? document['lastAveragePrice']['total']['averagePrice'] : null;
  const fee = isRecord(document['roomsSettings']) ? document['roomsSettings']['percentageFee'] : null;
  return {
    _id: document['_id'] as ObjectId,
    code: document['code'],
    name: document['name'],
    type: document['type'],
    categories: document['categories'],
    departmentId: document['departmentId'],
    trash: document['trash'] === true,
    warehouse: availability['warehouse'] === true,
    bundleProducts: bundle.flatMap((component) => {
      const id = objectIdOrNull(component['_id']);
      return id === null ? [] : [{ _id: id, quantity: component['quantity'], waste: component['waste'] }];
    }),
    simpleCost: document['simpleCost'],
    averagePrice: average,
    percentageFee: fee,
  };
}

/** The conditions of a sale a deferred invoice may gather, within the perimeter of the writer. The ids that were stored as text (the older documents) match too. */
const gatherableFilter = (ids: readonly ObjectId[], criteria: UnpaidCriteria): Filter<Document> => ({
  $and: [
    criteria.scope,
    {
      _id: { $in: [...ids] },
      companyId: { $in: [criteria.companyId, criteria.companyId.toHexString()] },
      'customer._id': { $in: [criteria.customerId, criteria.customerId.toHexString()] },
      unpaid: { $gt: 0 },
      status: { $ne: 'invoiced' },
      fiscalState: { $nin: ['canceled', 'refunded'] },
      receiptType: { $nin: ['invoice', 'partitioned'] },
      sType: { $in: [false, null] },
    },
  ],
});

/** The point of sale as the sales store it: an `ObjectId`, or the text of its id (the older documents). */
const placeFilter = (placeId: ObjectId): Filter<Document> => ({ placeId: { $in: [placeId, placeId.toHexString()] } });

/**
 * Builds the repository of the sales writes over a database accessor. Every read and write is in the group database of the verified access, has a time limit and a bound, and a write names only the fields the backend owns.
 *
 * @param databases Database accessor: the real one, or the one bound to the session of a transaction (`sessionDatabases`).
 */
export function createSalesWriteRepository(databases: Databases): SalesWriteRepository {
  const sales = (caller: ScopeHolder, access: GroupAccess) => groupDatabaseFor(caller, access, databases).collection('sales');
  return {
    findCatalog: async (caller, access, ids) => {
      const found = await bounded(() =>
        groupDatabaseFor(caller, access, databases)
          .collection('products')
          .find({ _id: { $in: [...ids] } }, { projection: { ...CATALOG_PROJECTION }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      return found.map(catalogProductOf);
    },

    findContact: async (caller, access, id) => {
      const found = await bounded(() => groupDatabaseFor(caller, access, databases).collection('contacts').findOne({ _id: id }, { projection: { ...CONTACT_COPY_PROJECTION }, maxTimeMS: LIST_MAX_TIME_MS }));
      if (found === null) {
        return null;
      }
      const { trash, ...copy } = found;
      // The cards the customer holds are copied by code only: the points are the contact's, never the sale's.
      return { copy: { ...copy, ...(Array.isArray(copy['fidelities']) ? { fidelities: (copy['fidelities'] as Document[]).map((card) => ({ code: card['code'] })) } : {}) }, trashed: trash === true };
    },

    findByKey: async (caller, access, placeId, timestampId) => {
      const own = await bounded(() => sales(caller, access).findOne({ 'floodCloud.key': `${placeId.toHexString()}|${timestampId}` }, { maxTimeMS: LIST_MAX_TIME_MS }));
      return own ?? bounded(() => sales(caller, access).findOne({ timestampId, ...placeFilter(placeId) }, { sort: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS }));
    },

    findOfPlace: (caller, access, placeId, id) => bounded(() => sales(caller, access).findOne({ _id: id, ...placeFilter(placeId) }, { maxTimeMS: LIST_MAX_TIME_MS })),

    search: (caller, access, placeId, filter, limit) =>
      bounded(() => sales(caller, access).find({ $and: [placeFilter(placeId), filter] }, { sort: { date: -1, _id: -1 }, limit, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),

    insert: async (caller, access, sale) => {
      await sales(caller, access).insertOne({ ...sale });
    },

    update: async (caller, access, id, change) => {
      const stray = Object.keys(change.$set).filter((name) => !SALES_OWNED_FIELDS.includes(name.split('.')[0]!));
      if (stray.length > 0) {
        throw new Error(`The sales module does not own the field ${stray[0]!}`);
      }
      return (await sales(caller, access).updateOne({ _id: id }, { $set: { ...change.$set } })).matchedCount === 1;
    },

    findTombstone: async (caller, access, key) => {
      const found = await bounded(() => groupDatabaseFor(caller, access, databases).collection('sales_tombstones').findOne({ key }, { projection: { saleId: 1 }, maxTimeMS: LIST_MAX_TIME_MS }));
      return found === null ? null : { saleId: found['saleId'] as ObjectId };
    },

    insertTombstone: async (caller, access, tombstone) => {
      // Upsert: a second quote of the legacy with the same `timestampId` (it has doublets) can be deleted too, and the key keeps the first tombstone.
      await groupDatabaseFor(caller, access, databases).collection('sales_tombstones').updateOne({ key: tombstone.key }, { $setOnInsert: { ...tombstone } }, { upsert: true });
    },

    remove: async (caller, access, id) => (await sales(caller, access).deleteOne({ _id: id })).deletedCount === 1,

    findGatherable: async (caller, access, ids, criteria) => (await bounded(() => sales(caller, access).find(gatherableFilter(ids, criteria), { projection: { _id: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray())).map((sale) => sale['_id'] as ObjectId),

    markQueued: async (caller, access, id, at) => (await sales(caller, access).updateOne({ _id: id, 'floodCloud.invoice.documentId': { $exists: true }, 'floodCloud.invoice.queuedAt': { $exists: false } }, { $set: { 'floodCloud.invoice.queuedAt': at } })).modifiedCount === 1,

    unmarkQueued: async (caller, access, id) => {
      await sales(caller, access).updateOne({ _id: id }, { $unset: { 'floodCloud.invoice.queuedAt': '' } });
    },

    gather: async (caller, access, ids, criteria, at) => (await sales(caller, access).updateMany(gatherableFilter(ids, criteria), { $set: { status: 'invoiced', updateDate: at } })).modifiedCount,
  };
}

/** The `AppError` of a sale that is not there (also the one of a sale of another point of sale or group: no difference is told). */
export function saleNotFound(): AppError {
  return new AppError('NOT_FOUND');
}
