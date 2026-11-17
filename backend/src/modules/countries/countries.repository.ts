import type { Document, Filter, ObjectId, UpdateFilter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import { codeVariants } from '../../shared/validation/code-variants.ts';
import { readCountryUsage } from '../../shared/security/scope/group-mirror.ts';
import type { CountryUsage } from '../../shared/security/scope/group-mirror.ts';
import { COUNTRY_PROJECTION } from './countries.mapper.ts';

/** Most ids of each kind a refused deletion lists. */
export const MAX_REPORTED_USERS = 20;

/** A stored country as the updates see it (the keys of the legacy this backend does not own are not listed, and stay untouched). */
type CountryDocument = {
  _id: ObjectId;
  code: string;
  name: string;
  areas: Array<{ code: string; name: string }>;
  insertDate: Date;
  updateDate: Date | null;
};

/** The `countries` collection of the common database (`doc/Tasks.md` 9-ter), and the companies and places of the copies that use a country. */
export interface CountriesRepository {
  /**
   * A country with its areas, or `null`. The code is matched in its four spellings (`IT`, `it`, `It`, `iT`), so a legacy country stored in another case is found.
   *
   * @param code The country code, two uppercase letters.
   */
  findByCode(code: string): Promise<Document | null>;
  /**
   * Inserts a whole new country and makes sure the code is still unique afterwards: without a unique index two requests could both pass a check made before, so after the insert the documents with the code (in any
   * of its spellings) are counted and, if there is another one, this one is removed again. If that removal fails the failure is logged as an error and thrown.
   *
   * @param document The document, in the legacy shape, with the code in upper case, built by the service.
   * @returns `inserted`, or `taken` when a country with that code exists (or appeared meanwhile).
   */
  insert(document: Document): Promise<'inserted' | 'taken'>;
  /**
   * Sets the name of a country and the date of the change, only if the name is still the one that was read (an absent name is `undefined`): a change made meanwhile is never overwritten.
   *
   * @param id Id of the country.
   * @param readName The stored name as it was read, whatever its type.
   * @param name The new name.
   * @param updateDate The date of the change.
   * @returns Whether the country was found with that name.
   */
  setName(id: ObjectId, readName: unknown, name: string, updateDate: Date): Promise<boolean>;
  /**
   * Deletes a country, only if it is still exactly as it was read (code, name and areas, an absent field being `undefined`): an area added meanwhile keeps it.
   *
   * @param read The stored `code`, `name` and `areas` as they were read.
   * @returns Whether the country was found as read.
   */
  remove(id: ObjectId, read: { readonly code: unknown; readonly name: unknown; readonly areas: unknown }): Promise<boolean>;
  /**
   * Adds an area to a country with one atomic update that applies only if no area of the country has that code (in any spelling): the list is never read and rewritten, so two requests that add different areas at
   * the same time both survive, and two that add the same one give one `added` and one `taken`. A country whose `areas` is not a list (the legacy has `null` and `'none'` countries) gets a list of one.
   *
   * @param id Id of the country.
   * @param area The area, `{ code, name }`, the code in upper case.
   * @param updateDate The date of the change.
   * @returns `added`, `taken` when an area has that code, or `missing` when the country is not there.
   */
  addArea(id: ObjectId, area: { readonly code: string; readonly name: string }, updateDate: Date): Promise<'added' | 'taken' | 'missing'>;
  /**
   * Sets the name of one area (matched by its code in any spelling and by the name that was read; every other key of the area and the other areas are untouched).
   *
   * @param id Id of the country.
   * @param areaCode Code of the area, in upper case.
   * @param readName The name of the area as it was read, `undefined` when it had none.
   * @param name The new name.
   * @param updateDate The date of the change.
   * @returns Whether the area was found with that name.
   */
  setAreaName(id: ObjectId, areaCode: string, readName: unknown, name: string, updateDate: Date): Promise<boolean>;
  /**
   * Removes one area from the list (every element with that code, in any spelling, which is also what duplicates of the legacy lose), only if the area still has the name that was read.
   *
   * @param id Id of the country.
   * @param areaCode Code of the area, in upper case.
   * @param readName The name of the area as it was read, `undefined` when it had none.
   * @param updateDate The date of the change.
   * @returns Whether the area was found with that name.
   */
  removeArea(id: ObjectId, areaCode: string, readName: unknown, updateDate: Date): Promise<boolean>;
  /**
   * The companies and places, of any group, trashed ones included, that use a country or one of its areas, read from the copies.
   *
   * @param countryCode The country code.
   * @param areaCode The area code, or `null` for the whole country.
   * @returns At most {@link MAX_REPORTED_USERS} ids of each kind.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  usageOf(countryCode: string, areaCode: string | null): Promise<CountryUsage>;
}

/** A condition on a stored value as it was read: the value itself, or the absence of the field when it was absent. */
const exactly = (value: unknown): unknown => (value === undefined ? { $exists: false } : value);

/**
 * Builds the repository of the countries. Every write is a targeted `$set`, `$push` or `$pull` (or the insertion of a whole new document) of the fields the registry says are owned, guarded by the values that were
 * read, so the keys of a country or of an area that the legacy keeps are never touched and a change made in between is never overwritten.
 *
 * @param databases Database accessor.
 * @param logger Logger of the application.
 */
export function createCountriesRepository(databases: Databases, logger: Logger): CountriesRepository {
  const countries = () => databases.common().collection<CountryDocument>('countries');
  const sameCode = (code: string) => ({ $in: codeVariants(code) });
  return {
    findByCode: (code) => countries().findOne({ code: sameCode(code) }, { projection: COUNTRY_PROJECTION, maxTimeMS: LIST_MAX_TIME_MS }),

    insert: async (document) => {
      const code = document['code'] as string;
      if ((await countries().countDocuments({ code: sameCode(code) }, { limit: 1, maxTimeMS: LIST_MAX_TIME_MS })) > 0) {
        return 'taken';
      }
      await countries().insertOne(document as CountryDocument);
      if ((await countries().countDocuments({ code: sameCode(code) }, { limit: 2, maxTimeMS: LIST_MAX_TIME_MS })) > 1) {
        try {
          await countries().deleteOne({ _id: document['_id'] as ObjectId });
        } catch (error) {
          logger.error('countries: the compensating delete of a duplicated code failed, a duplicate remains', { code, id: (document['_id'] as ObjectId).toHexString(), error });
          throw error;
        }
        return 'taken';
      }
      return 'inserted';
    },

    setName: async (id, readName, name, updateDate) => (await countries().updateOne({ _id: id, name: exactly(readName) } as Filter<CountryDocument>, { $set: { name, updateDate } })).matchedCount === 1,

    remove: async (id, read) =>
      (await countries().deleteOne({ _id: id, code: exactly(read.code), name: exactly(read.name), areas: exactly(read.areas) } as Filter<CountryDocument>)).deletedCount === 1,

    addArea: async (id, area, updateDate) => {
      const pushed = await countries().updateOne({ _id: id, areas: { $type: 'array' }, 'areas.code': { $nin: codeVariants(area.code) } }, { $push: { areas: area }, $set: { updateDate } });
      if (pushed.matchedCount === 1) {
        return 'added';
      }
      const replaced = await countries().updateOne({ _id: id, areas: { $not: { $type: 'array' } } }, { $set: { areas: [area], updateDate } });
      if (replaced.matchedCount === 1) {
        return 'added';
      }
      return (await countries().countDocuments({ _id: id }, { limit: 1, maxTimeMS: LIST_MAX_TIME_MS })) === 1 ? 'taken' : 'missing';
    },

    setAreaName: async (id, areaCode, readName, name, updateDate) =>
      (
        await countries().updateOne(
          { _id: id, areas: { $elemMatch: { code: sameCode(areaCode), name: exactly(readName) } } } as Filter<CountryDocument>,
          { $set: { 'areas.$[area].name': name, updateDate } },
          { arrayFilters: [{ 'area.code': sameCode(areaCode) }] },
        )
      ).matchedCount === 1,

    removeArea: async (id, areaCode, readName, updateDate) =>
      (
        await countries().updateOne(
          { _id: id, areas: { $elemMatch: { code: sameCode(areaCode), name: exactly(readName) } } } as Filter<CountryDocument>,
          { $pull: { areas: { code: sameCode(areaCode) } }, $set: { updateDate } } as UpdateFilter<CountryDocument>,
        )
      ).matchedCount === 1,

    usageOf: (countryCode, areaCode) => readCountryUsage(databases, countryCode, areaCode, MAX_REPORTED_USERS),
  };
}
