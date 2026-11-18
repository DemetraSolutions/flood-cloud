import { MongoServerError } from 'mongodb';
import type { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import type { PriceList } from './price-list.ts';

/** The key of the price list in `common.settings`. */
export const PRICE_LIST_KEY = 'PRICE_LIST';

/** MongoDB's duplicate key error code: a second document with the same `key`. */
const DUPLICATE_KEY = 11000;

/** Reads and writes `common.settings`, the settings of the platform, one document per key. */
export interface SettingsRepository {
  /**
   * The stored value of the price list, exactly as the database holds it.
   *
   * @returns The `value`, or `null` when no price list was ever saved.
   */
  readPriceList(): Promise<unknown>;
  /**
   * Saves the price list, only if the stored value is still the one that was read: a list saved meanwhile is never overwritten. With nothing stored the document is inserted, and the unique index of the key decides between two
   * saves at once.
   *
   * @param read What {@link readPriceList} returned.
   * @param next The whole new list, in its canonical order.
   * @param by The administrator.
   * @param at Time of the change.
   * @returns Whether the list was still as read.
   */
  replacePriceList(read: unknown, next: PriceList, by: ObjectId, at: Date): Promise<boolean>;
}

/**
 * Builds the repository of the settings over `common.settings`.
 *
 * @param databases Database accessor.
 */
export function createSettingsRepository(databases: Databases): SettingsRepository {
  const settings = () => databases.common().collection('settings');
  return {
    readPriceList: async () => (await settings().findOne({ key: PRICE_LIST_KEY }, { projection: { value: 1 }, maxTimeMS: LIST_MAX_TIME_MS }))?.['value'] ?? null,

    replacePriceList: async (read, next, by, at) => {
      if (read === null) {
        try {
          await settings().insertOne({ key: PRICE_LIST_KEY, value: next, updatedAt: at, updatedBy: by });
          return true;
        } catch (error) {
          if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
            return false;
          }
          throw error;
        }
      }
      return (await settings().updateOne({ key: PRICE_LIST_KEY, value: read }, { $set: { value: next, updatedAt: at, updatedBy: by } })).matchedCount === 1;
    },
  };
}
