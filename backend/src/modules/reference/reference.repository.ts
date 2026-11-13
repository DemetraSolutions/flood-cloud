import type { Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { countByGroupPipeline, assertCountedGroups, countsByGroup } from '../../shared/security/scope/group-counts.ts';
import { countMirrorByGroups, groupMirror } from '../../shared/security/scope/group-mirror.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { groupsScopeFilter, placesScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import { COUNTRY_PROJECTION, GROUP_PROJECTION, PLACE_PROJECTION } from './reference.mapper.ts';
import type { GroupCounts } from './reference.mapper.ts';
import { REFERENCE_LIST } from './reference.list.ts';

/** Read-only pages of the reference data (`common.groups` and the copies `common.companies` and `common.places`); nothing is ever written here. */
export interface ReferenceRepository {
  /**
   * A page of `common.groups`, inside the caller's perimeter.
   *
   * @param principal The authenticated caller (his scope limits the result).
   * @param filter Resource filter of the request (state, status).
   * @param params Validated list parameters.
   */
  listGroups(principal: AuthPrincipal, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /**
   * Counts the companies, places and users of the groups of a page already returned by {@link ReferenceRepository.listGroups}
   * (so already inside the caller's perimeter): three aggregations in all, whatever the number of groups, each read from the common database.
   *
   * @param groupIds Ids of the groups of the page (never from the client): 1 to the maximum page size.
   * @returns For each group (hex id) the active and trashed counts of the three kinds, zeros included.
   * @throws {Error} If the list is empty, too long or holds something that is not an `ObjectId`.
   */
  countGroupsContents(groupIds: readonly ObjectId[]): Promise<Map<string, GroupCounts>>;
  /**
   * A page of the `places` of a verified group (read from the copies in `common.places`), inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter Resource filter of the request.
   * @param params Validated list parameters.
   */
  listPlaces(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /**
   * The countries of `common.countries` (a legacy collection, read only): at most {@link MAX_COUNTRIES} documents, with the code, the name and the areas only.
   */
  listCountries(): Promise<Document[]>;
}

/** Most countries read: the world has about 250, so the bound is never reached by real data. */
export const MAX_COUNTRIES = 400;

/**
 * Builds the reference repository. Every query combines the scope filter of the caller with the filter of
 * the request through `withScope` and projects an allowlist of fields, so credentials, integration settings
 * and the group API key are never loaded. Companies and places are read only through `groupMirror`, which
 * restricts every read to the verified group.
 *
 * @param databases Database accessor.
 */
export function createReferenceRepository(databases: Databases): ReferenceRepository {
  const read = async (aggregate: (pipeline: Document[]) => Promise<Document[]>, match: Filter<Document>, params: ListParams, projection: Readonly<Record<string, 1>>): Promise<ListPage> =>
    pageOf(await aggregate(listPipeline(match, params, REFERENCE_LIST, projection)), params);
  return {
    listCountries: () => databases.common().collection('countries').find({}, { projection: COUNTRY_PROJECTION, limit: MAX_COUNTRIES, maxTimeMS: LIST_MAX_TIME_MS }).toArray(),

    listGroups: (principal, filter, params) =>
      read(
        (pipeline) => databases.common().collection('groups').aggregate(pipeline, { maxTimeMS: LIST_MAX_TIME_MS }).toArray(),
        withScope(groupsScopeFilter(principal.scope), { $and: [filter, listSearch(params, REFERENCE_LIST)] }),
        params,
        GROUP_PROJECTION,
      ),

    countGroupsContents: async (groupIds) => {
      assertCountedGroups(groupIds);
      // Users are read by the same pipeline shape, on the `groupId_1_role_1` index (prefix `groupId`).
      const [companies, places, users] = await Promise.all([
        countMirrorByGroups(databases, 'companies', groupIds),
        countMirrorByGroups(databases, 'places', groupIds),
        databases.common().collection('users').aggregate(countByGroupPipeline(groupIds), { maxTimeMS: LIST_MAX_TIME_MS }).toArray(),
      ]);
      const userCounts = countsByGroup(groupIds, users);
      return new Map(
        groupIds.map((id) => {
          const key = id.toHexString();
          return [key, { companies: companies.get(key)!, places: places.get(key)!, users: userCounts.get(key)! }];
        }),
      );
    },

    listPlaces: (principal, access, filter, params) =>
      read(
        (pipeline) => groupMirror(principal, access, databases, 'places').aggregate(pipeline),
        withScope(placesScopeFilter(principal.scope), { $and: [filter, listSearch(params, REFERENCE_LIST)] }),
        params,
        PLACE_PROJECTION,
      ),
  };
}
