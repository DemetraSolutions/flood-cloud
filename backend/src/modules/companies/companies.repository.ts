import type { Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { groupMirror } from '../../shared/security/scope/group-mirror.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { companiesScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import type { CatalogsRepository } from '../groups/catalogs/catalogs.repository.ts';
import { currencies } from '../groups/catalogs/currencies.ts';
import { newElementId } from '../groups/catalogs/kit.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import { COMPANIES_LIST } from './companies.list.ts';
import { COMPANY_SUMMARY_PROJECTION } from './company.mapper.ts';

/** A country of the common database: its code and, when it lists areas, their codes. */
export interface Country {
  readonly code: string;
  /** The codes of the areas (provinces) of the country, `null` when the country lists none. */
  readonly areas: ReadonlySet<string> | null;
}

/** What a group offers to a company: the codes of its currencies and the ids of its enabled price lists. */
export interface GroupLists {
  readonly currencies: ReadonlySet<string>;
  readonly priceLists: ReadonlySet<string>;
}

/** The reads of the company routes that are not the company itself: the compact list (from the copies), the countries, the dealers and the lists of the group. */
export interface CompaniesRepository {
  /**
   * A page of the `companies` of a verified group (read from the copies in `common.companies`), inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter Resource filter of the request.
   * @param params Validated list parameters.
   */
  list(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /**
   * A country of `common.countries` by its code.
   *
   * @param code ISO 3166-1 alpha-2 code.
   * @returns The country, or `null` when the collection has none with that code.
   */
  findCountry(code: string): Promise<Country | null>;
  /**
   * Whether a user is a dealer (role `D`) that is active and not in the trash.
   *
   * @param userId Id of the user.
   */
  isDealer(userId: ObjectId): Promise<boolean>;
  /**
   * The active dealers (role `D`, enabled, not in the trash) with the label to show: the business name of his registry record, else his name. At most {@link MAX_DEALERS}, sorted by label.
   *
   * @param only Limits the result to one dealer (a dealer lists himself); `null` for all.
   */
  listDealers(only: ObjectId | null): Promise<ReadonlyArray<{ readonly id: string; readonly label: string }>>;
  /**
   * The currencies and the enabled price lists of a group, read through the catalogs of the group document.
   *
   * @param groupId Id of the group (from a verified access).
   * @returns The lists, or `null` when the group does not exist.
   */
  groupLists(groupId: ObjectId): Promise<GroupLists | null>;
}

/** Most dealers listed for the hub choice. */
export const MAX_DEALERS = 500;

/**
 * Builds the repository of the company routes.
 *
 * @param databases Database accessor.
 * @param catalogs Reads the containers of the group document.
 */
export function createCompaniesRepository(databases: Databases, catalogs: Pick<CatalogsRepository, 'read'>): CompaniesRepository {
  return {
    list: async (principal, access, filter, params) =>
      pageOf(
        await groupMirror(principal, access, databases, 'companies').aggregate(
          listPipeline(withScope(companiesScopeFilter(principal.scope), { $and: [filter, listSearch(params, COMPANIES_LIST)] }), params, COMPANIES_LIST, COMPANY_SUMMARY_PROJECTION),
        ),
        params,
      ),

    findCountry: async (code) => {
      const country = await databases.common().collection('countries').findOne({ code }, { projection: { code: 1, areas: 1 }, maxTimeMS: LIST_MAX_TIME_MS });
      if (country === null) {
        return null;
      }
      const areas: unknown = country['areas'];
      const codes = (Array.isArray(areas) ? areas : []).flatMap((area: unknown) => {
        const areaCode = (area as { code?: unknown } | null)?.code;
        return typeof areaCode === 'string' ? [areaCode] : [];
      });
      return { code, areas: codes.length === 0 ? null : new Set(codes) };
    },

    isDealer: async (userId) =>
      (await databases.common().collection('users').findOne({ _id: userId, role: 'D', status: true, trash: { $ne: true } }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS })) !== null,

    listDealers: async (only) => {
      const users = await databases
        .common()
        .collection('users')
        .find({ role: 'D', status: true, trash: { $ne: true }, ...(only === null ? {} : { _id: only }) }, { projection: { name: 1, surname: 1 }, limit: MAX_DEALERS, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      const registry = await databases
        .common()
        .collection('dealers')
        .find({ _id: { $in: users.map((user) => user._id) } }, { projection: { businessName: 1 }, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      const businessNames = new Map(registry.map((dealer) => [dealer._id.toHexString(), dealer['businessName']]));
      return users
        .map((user) => {
          const id = user._id.toHexString();
          const business: unknown = businessNames.get(id);
          const person = [user['name'], user['surname']].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
          return { id, label: typeof business === 'string' ? business : person !== '' ? person : id };
        })
        .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    },

    groupLists: async (groupId) => {
      const stored = await catalogs.read(groupId, ['currencies', 'priceLists']);
      if (stored === null) {
        return null;
      }
      const state = { raw: (path: string) => stored.values[path], newId: newElementId };
      return {
        currencies: new Set(currencies.list(state, []).map((currency) => currency.code)),
        priceLists: new Set(priceLists.list(state, []).filter((list) => list.enabled).map((list) => list.id)),
      };
    },
  };
}
