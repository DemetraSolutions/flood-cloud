import type { Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { TOBACCO_PROJECTION } from './tobaccos.mapper.ts';
import { TOBACCOS_LIST } from './tobaccos.list.ts';
import type { TobaccoDocument } from './tobaccos.sheet.ts';

/** Documents written by one `insertMany` inside the transaction of the import. */
export const INSERT_BATCH = 1000;

/** The outcome of a replacement. */
export interface Replacement {
  /** Documents the list had before. */
  readonly previous: number;
}

/** The `tobaccos` collection of the common database: the national price list, one for the whole platform. */
export interface TobaccosRepository {
  /**
   * A page of the list.
   *
   * @param params Validated list parameters.
   * @param category Exact category to keep, or `null` for every one.
   */
  list(params: ListParams, category: string | null): Promise<ListPage>;
  /**
   * Replaces the whole list with new documents, atomically: in one transaction the previous documents are deleted and the new ones are inserted (in batches of {@link INSERT_BATCH}), so a reader sees the
   * old list or the new one and never a mix, and a failure anywhere leaves the old list untouched.
   *
   * @param documents The new list.
   * @returns How many documents the list had before.
   */
  replaceAll(documents: readonly TobaccoDocument[]): Promise<Replacement>;
}

/**
 * Builds the repository of the price list. Every read is limited (a page, a time limit) and projected; the only write is {@link TobaccosRepository.replaceAll}.
 *
 * @param databases Database accessor (the common database and its transaction).
 */
export function createTobaccosRepository(databases: Databases): TobaccosRepository {
  const tobaccos = () => databases.common().collection('tobaccos');
  return {
    list: async (params, category) => {
      const match: Document = { ...listSearch(params, TOBACCOS_LIST), ...(category === null ? {} : { category }) };
      return pageOf(await tobaccos().aggregate(listPipeline(match, params, TOBACCOS_LIST, TOBACCO_PROJECTION), { maxTimeMS: LIST_MAX_TIME_MS }).toArray(), params);
    },

    replaceAll: (documents) =>
      databases.transaction(async (session) => {
        const collection = tobaccos();
        const { deletedCount } = await collection.deleteMany({}, { session });
        for (let from = 0; from < documents.length; from += INSERT_BATCH) {
          // Copies: the driver adds the `_id` to the objects it is given, and the work may run again.
          await collection.insertMany(documents.slice(from, from + INSERT_BATCH).map((document) => ({ ...document })), { session, ordered: true });
        }
        return { previous: deletedCount };
      }),
  };
}
