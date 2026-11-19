import type { Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS, listPipeline, listSearch, pageOf } from '../../shared/http/list.ts';
import type { ListPage, ListParams } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { readCrossGroupPage } from '../../shared/security/scope/cross-group.ts';
import type { CrossGroupFilters, CrossGroupPage } from '../../shared/security/scope/cross-group.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import { groupMirror } from '../../shared/security/scope/group-mirror.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { placesScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import type { CompaniesRepository } from '../companies/companies.repository.ts';
import { PLACE_SUMMARY_PROJECTION } from './place.mapper.ts';
import { PLACES_LIST } from './places.list.ts';

/** The reads of the place routes that are not the place itself: the list (from the copies), the users that refer to a place, and the countries and the price lists, which are the ones of the companies. */
export interface PlacesRepository extends Pick<CompaniesRepository, 'findCountry' | 'groupLists'> {
  /**
   * A page of the `places` of a verified group (read from the copies in `common.places`), inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter Resource filter of the request.
   * @param params Validated list parameters.
   */
  list(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>, params: ListParams): Promise<ListPage>;
  /**
   * A page of the places of every group of the caller's perimeter (read from the copies in `common.places`), with the names of the groups of the page: the platform reads every group, a dealer his groups.
   *
   * @param principal The authenticated caller (the platform or a dealer).
   * @param groups The group filters of the request.
   * @param filter Resource filter of the request.
   * @param params Validated list parameters.
   * @throws {AppError} `FORBIDDEN` for any other caller, `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  listAll(principal: AuthPrincipal, groups: CrossGroupFilters, filter: Filter<Document>, params: ListParams): Promise<CrossGroupPage>;
  /**
   * The ids of the places of a verified group that are in the trash, inside the caller's perimeter, in `_id` order, at most `limit`.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param limit Most ids returned (a positive integer).
   * @param after Only the ids greater than this one (the cursor of a repeated call), `null` for the first call.
   */
  trashedIds(principal: AuthPrincipal, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  /**
   * How many places of a verified group are in the trash, inside the caller's perimeter.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   */
  countTrashed(principal: AuthPrincipal, access: GroupAccess): Promise<number>;
  /**
   * Whether a user of the group has the place in his scope (`placeId` or `placesId`), whatever the state of the user: the reference that stops the deletion of a place.
   *
   * @param groupId Id of the group (from a verified access).
   * @param placeId Id of the place.
   */
  hasUsers(groupId: ObjectId, placeId: ObjectId): Promise<boolean>;
  /**
   * Tells which of the e-mail templates of a request do not exist in the group (`email_templates` of the group database, read only).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group, which fixes the database.
   * @param ids The ids to check, at most a few.
   * @returns The positions, in the list, of the ids that are missing.
   */
  missingTemplates(principal: AuthPrincipal, access: GroupAccess, ids: readonly ObjectId[]): Promise<Set<number>>;
  /**
   * Tells which users of a request cannot be assigned to a table of a place: one that does not exist in the group, is in the trash, or has nothing to do with the place (a group administrator
   * reaches every place; any other user must have the place in `placeId` or `placesId`, or be a company administrator of its company).
   *
   * @param groupId Id of the group (from a verified access).
   * @param placeId Id of the place.
   * @param companyId Id of the company of the place, `null` when it has none.
   * @param ids The ids to check.
   * @returns The positions, in the list, of the ids that are not valid.
   */
  missingUsers(groupId: ObjectId, placeId: ObjectId, companyId: ObjectId | null, ids: readonly ObjectId[]): Promise<Set<number>>;
  /**
   * The language codes of a group (`settings.languages`; `it` when the group lists none).
   *
   * @param groupId Id of the group (from a verified access).
   */
  groupLanguages(groupId: ObjectId): Promise<ReadonlySet<string>>;
}

/**
 * Builds the repository of the place routes.
 *
 * @param databases Database accessor.
 * @param companies The reads of the company routes that the places share (countries and price lists).
 */
export function createPlacesRepository(databases: Databases, companies: Pick<CompaniesRepository, 'findCountry' | 'groupLists'>): PlacesRepository {
  return {
    list: async (principal, access, filter, params) =>
      pageOf(
        await groupMirror(principal, access, databases, 'places').aggregate(
          listPipeline(withScope(placesScopeFilter(principal.scope), { $and: [filter, listSearch(params, PLACES_LIST)] }), params, PLACES_LIST, PLACE_SUMMARY_PROJECTION),
        ),
        params,
      ),

    listAll: (principal, groups, filter, params) => readCrossGroupPage(databases, principal, { name: 'places', config: PLACES_LIST, projection: PLACE_SUMMARY_PROJECTION }, groups, filter, params),

    trashedIds: async (principal, access, limit, after) =>
      (await groupMirror(principal, access, databases, 'places').find(withScope(placesScopeFilter(principal.scope), { trash: true, ...(after === null ? {} : { _id: { $gt: after } }) }), { projection: { _id: 1 }, sort: { _id: 1 }, limit })).map((document) => document['_id'] as ObjectId),

    countTrashed: (principal, access) => groupMirror(principal, access, databases, 'places').countDocuments(withScope(placesScopeFilter(principal.scope), { trash: true })),

    hasUsers: async (groupId, placeId) =>
      (await databases.common().collection('users').findOne({ groupId, $or: [{ placeId }, { placesId: placeId }] }, { projection: { _id: 1 }, maxTimeMS: LIST_MAX_TIME_MS })) !== null,

    missingTemplates: async (principal, access, ids) => {
      const found = await groupDatabaseFor(principal, access, databases)
        .collection<{ _id: ObjectId }>('email_templates')
        .find({ _id: { $in: [...ids] } }, { projection: { _id: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      const present = new Set(found.map((template) => template._id.toHexString()));
      return new Set(ids.flatMap((id, index) => (present.has(id.toHexString()) ? [] : [index])));
    },

    missingUsers: async (groupId, placeId, companyId, ids) => {
      const scope: Filter<Document>[] = [{ role: 'SA' }, { placeId }, { placesId: placeId }, ...(companyId === null ? [] : [{ companyId }])];
      const found = await databases
        .common()
        .collection('users')
        .find({ groupId, _id: { $in: [...ids] }, trash: { $ne: true }, $or: scope }, { projection: { _id: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray();
      const present = new Set(found.map((user) => (user['_id'] as ObjectId).toHexString()));
      return new Set(ids.flatMap((id, index) => (present.has(id.toHexString()) ? [] : [index])));
    },

    groupLanguages: async (groupId) => {
      const group = await databases.common().collection('groups').findOne({ _id: groupId }, { projection: { 'settings.languages': 1 }, maxTimeMS: LIST_MAX_TIME_MS });
      const languages: unknown = (group?.['settings'] as { languages?: unknown } | undefined)?.languages;
      const codes = (Array.isArray(languages) ? (languages as unknown[]) : []).filter((code): code is string => typeof code === 'string');
      return new Set(codes.length === 0 ? ['it'] : codes);
    },

    findCountry: (code) => companies.findCountry(code),
    groupLists: (groupId) => companies.groupLists(groupId),
  };
}
