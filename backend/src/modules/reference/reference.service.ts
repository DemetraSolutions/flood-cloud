import type { Document, Filter, ObjectId } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { parseIds } from '../group-lookup/lookup.schemas.ts';
import { REFERENCE_LIST } from './reference.list.ts';
import { toCountryReference, toGroupReference, toPlaceReference } from './reference.mapper.ts';
import type { CountryReference, GroupCounts, GroupReference, PlaceReference } from './reference.mapper.ts';
import type { ReferenceRepository } from './reference.repository.ts';
import type { GroupsQuery, PlacesQuery } from './reference.schemas.ts';

/** One page of mapped reference items. */
export interface ReferencePage<T> {
  readonly items: T[];
  readonly page: PageInfo;
}

/** Business rules of the reference lists. */
export interface ReferenceService {
  /**
   * Lists the groups of the caller's perimeter. Only a PSA may look at suspended or trashed groups
   * (a dealer or a group administrator reaches only active, untrashed ones) and filter by dealer; `demo` is open to everybody.
   * Every item carries the counts of its companies, places and users (active and trashed), computed for the page only.
   *
   * @param principal The authenticated caller.
   * @param query Validated query.
   * @throws {AppError} `FORBIDDEN` when a caller who is not a PSA asks for the `status` or `dealerId` filter or for trashed groups.
   */
  listGroups(principal: AuthPrincipal, query: GroupsQuery): Promise<ReferencePage<GroupReference>>;
  /**
   * Lists the places of a verified group inside the caller's perimeter (untrashed ones by default),
   * optionally of one company or of the given `ids`; elements outside the perimeter are never returned (a company outside it yields an empty page).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   */
  listPlaces(principal: AuthPrincipal, access: GroupAccess, query: PlacesQuery): Promise<ReferencePage<PlaceReference>>;
  /**
   * The countries with their areas, sorted by name (then code), for the forms. The same for every caller.
   */
  listCountries(): Promise<ReferencePage<CountryReference>>;
}

/** The trash condition of a request: untrashed unless `trashed=true`. */
const trashFilter = (trashed: string | undefined): Filter<Document> => (trashed === 'true' ? { trash: true } : { trash: { $ne: true } });

/**
 * Builds the reference service.
 *
 * @param repository Reference repository.
 */
export function createReferenceService(repository: ReferenceRepository): ReferenceService {
  return {
    listGroups: async (principal, query) => {
      if (principal.scope.kind !== 'platform' && (query.status !== undefined || query.trashed === 'true' || query.dealerId !== undefined)) {
        throw new AppError('FORBIDDEN');
      }
      const conditions: Filter<Document>[] = [trashFilter(query.trashed)];
      if (principal.scope.kind !== 'platform') {
        // Defense in depth: whoever is not a PSA never sees a suspended group, whatever the scope holds.
        conditions.push({ status: true });
      }
      if (query.status !== undefined) {
        conditions.push({ status: query.status === 'active' ? true : { $ne: true } });
      }
      if (query.dealerId !== undefined) {
        conditions.push({ dealerId: query.dealerId });
      }
      if (query.demo !== undefined) {
        conditions.push({ demo: query.demo === 'true' ? true : { $ne: true } });
      }
      const { items, page } = await repository.listGroups(principal, { $and: conditions }, listParamsOf(query, REFERENCE_LIST));
      // One count per kind for the whole page (3 aggregations), only for the groups the caller was just allowed to list.
      const counts = items.length === 0 ? new Map<string, GroupCounts>() : await repository.countGroupsContents(items.map((item) => item['_id'] as ObjectId));
      return { items: items.map((item) => toGroupReference(item, counts.get((item['_id'] as ObjectId).toHexString())!)), page };
    },

    listPlaces: async (principal, access, query) => {
      const conditions: Filter<Document>[] = [trashFilter(query.trashed)];
      if (query.companyId !== undefined) {
        conditions.push({ companyId: query.companyId });
      }
      const ids = parseIds(query.ids);
      if (ids !== null) {
        conditions.push({ _id: { $in: ids } });
      }
      const { items, page } = await repository.listPlaces(principal, access, { $and: conditions }, listParamsOf(query, REFERENCE_LIST));
      return { items: items.map(toPlaceReference), page };
    },

    listCountries: async () => {
      const items = (await repository.listCountries())
        .flatMap((document) => toCountryReference(document) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
      return { items, page: { limit: items.length, next: null } };
    },
  };
}
