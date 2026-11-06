import type { ClientSession, Collection, Document, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListParams } from '../../shared/http/list.ts';
import { DEALER_PROJECTION, companyOf, fromDocument } from './dealer.mapper.ts';
import type { Company, Dealer, DealerSummary } from './dealer.types.ts';
import { DEALERS_LIST } from './dealers.list.ts';

/** A page of dealers. */
export interface DealerPage {
  readonly dealers: readonly Dealer[];
  readonly page: PageInfo;
}

/** Reads and writes `common.dealers`, the registry of the dealers' company data (D-09). */
export interface DealersRepository {
  /**
   * Inserts a dealer document built by `toNewDocument`.
   *
   * @param document The document, with the `_id` of the dealer's user.
   * @param session Transaction the write belongs to: a dealer is never written without its user.
   * @throws {MongoServerError} Duplicate key (`11000`) when another dealer has the same VAT number.
   */
  insert(document: Document, session: ClientSession): Promise<void>;
  /**
   * Reads a dealer.
   *
   * @param id Id of the dealer (the id of his user).
   * @returns The dealer, or `null` when it does not exist.
   */
  findById(id: ObjectId): Promise<Dealer | null>;
  /**
   * Reads the id and name of a dealer.
   *
   * @param id Id of the dealer.
   * @returns The summary, or `null` when it does not exist.
   */
  findSummary(id: ObjectId): Promise<DealerSummary | null>;
  /**
   * Reads a page of dealers.
   *
   * @param params Validated list parameters.
   */
  list(params: ListParams): Promise<DealerPage>;
  /**
   * Tells whether a VAT number belongs to a dealer.
   *
   * @param vatNumber The VAT number, normalized.
   * @param excludeId A dealer that may keep its own number (the one being edited).
   */
  isVatTaken(vatNumber: string, excludeId?: ObjectId): Promise<boolean>;
  /**
   * Replaces the company data of a dealer and stamps `updatedAt`.
   *
   * @param id Id of the dealer.
   * @param company The whole company data.
   * @param now Time of the change.
   * @returns `false` when the dealer does not exist.
   * @throws {MongoServerError} Duplicate key (`11000`) when another dealer has the same VAT number.
   */
  update(id: ObjectId, company: Company, now: Date): Promise<boolean>;
  /**
   * Deletes a dealer.
   *
   * @param id Id of the dealer.
   * @param session Transaction the write belongs to: a dealer goes with its user.
   * @returns The deleted dealer, or `null` when there was no document (a user `D` created before the registry and not yet migrated).
   */
  deleteById(id: ObjectId, session: ClientSession): Promise<Dealer | null>;
}

/**
 * Builds the dealers repository over `common.dealers`.
 *
 * @param databases Database accessor.
 */
export function createDealersRepository(databases: Databases): DealersRepository {
  const dealers = (): Collection<Document> => databases.common().collection('dealers');
  return {
    insert: async (document, session) => {
      await dealers().insertOne({ ...document }, { session });
    },

    findById: async (id) => {
      const document = await dealers().findOne({ _id: id }, { projection: DEALER_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS });
      return document === null ? null : fromDocument(document);
    },

    findSummary: async (id) => {
      const document = await dealers().findOne({ _id: id }, { projection: { businessName: 1 }, maxTimeMS: LIST_MAX_TIME_MS });
      return document === null ? null : { id: id.toHexString(), businessName: document['businessName'] as string };
    },

    list: async (params) => {
      const documents = await dealers().aggregate(listPipeline(listSearch(params, DEALERS_LIST), params, DEALERS_LIST, DEALER_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray();
      const { items, page } = pageOf(documents, params);
      return { dealers: items.map(fromDocument), page };
    },

    isVatTaken: async (vatNumber, excludeId) =>
      (await dealers().findOne({ vatNumber, ...(excludeId === undefined ? {} : { _id: { $ne: excludeId } }) }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS })) !== null,

    update: async (id, company, now) => {
      const result = await dealers().updateOne({ _id: id }, { $set: { ...companyOf(company), updatedAt: now } });
      return result.matchedCount === 1;
    },

    deleteById: async (id, session) => {
      const document = await dealers().findOneAndDelete({ _id: id }, { session, projection: DEALER_PROJECTION });
      return document === null ? null : fromDocument(document);
    },
  };
}
