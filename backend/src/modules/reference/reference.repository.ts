import type { Collection, Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { companiesScopeFilter, groupsScopeFilter, placesScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import { COMPANY_PROJECTION, GROUP_PROJECTION, PLACE_PROJECTION } from './reference.mapper.ts';
import { REFERENCE_LIST } from './reference.list.ts';

/** Read-only pages of the reference data (`legacy-read` collections); nothing is ever written here. */
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
   * A page of the `companies` of a verified group, inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter Resource filter of the request.
   * @param params Validated list parameters.
   */
  listCompanies(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /**
   * A page of the `places` of a verified group, inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter Resource filter of the request.
   * @param params Validated list parameters.
   */
  listPlaces(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
}

/**
 * Builds the reference repository. Every query combines the scope filter of the caller with the filter of
 * the request through `withScope` and projects an allowlist of fields, so credentials, integration settings
 * and the group API key are never loaded.
 *
 * @param databases Database accessor.
 */
export function createReferenceRepository(databases: Databases): ReferenceRepository {
  const read = async (collection: Collection<Document>, match: Filter<Document>, params: ListParams, projection: Readonly<Record<string, 1>>): Promise<ListPage> => {
    const documents = await collection.aggregate(listPipeline(match, params, REFERENCE_LIST, projection), { maxTimeMS: LIST_MAX_TIME_MS }).toArray();
    return pageOf(documents, params);
  };
  return {
    listGroups: (principal, filter, params) =>
      read(databases.common().collection('groups'), withScope(groupsScopeFilter(principal.scope), { $and: [filter, listSearch(params, REFERENCE_LIST)] }), params, GROUP_PROJECTION),

    listCompanies: (principal, access, filter, params) =>
      read(
        groupDatabaseFor(principal, access, databases).collection('companies'),
        withScope(companiesScopeFilter(principal.scope), { $and: [filter, listSearch(params, REFERENCE_LIST)] }),
        params,
        COMPANY_PROJECTION,
      ),

    listPlaces: (principal, access, filter, params) =>
      read(
        groupDatabaseFor(principal, access, databases).collection('places'),
        withScope(placesScopeFilter(principal.scope), { $and: [filter, listSearch(params, REFERENCE_LIST)] }),
        params,
        PLACE_PROJECTION,
      ),
  };
}
