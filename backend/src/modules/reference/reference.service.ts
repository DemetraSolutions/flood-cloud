import type { Document, Filter } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { REFERENCE_LIST } from './reference.list.ts';
import { toCompanyReference, toGroupReference, toPlaceReference } from './reference.mapper.ts';
import type { CompanyReference, GroupReference, PlaceReference } from './reference.mapper.ts';
import type { ReferenceRepository } from './reference.repository.ts';
import type { CompaniesQuery, GroupsQuery, PlacesQuery } from './reference.schemas.ts';

/** One page of mapped reference items. */
export interface ReferencePage<T> {
  readonly items: T[];
  readonly page: PageInfo;
}

/** Business rules of the reference lists. */
export interface ReferenceService {
  /**
   * Lists the groups of the caller's perimeter. Only a PSA may look at suspended or trashed groups
   * (a dealer or a group administrator reaches only active, untrashed ones).
   *
   * @param principal The authenticated caller.
   * @param query Validated query.
   * @throws {AppError} `FORBIDDEN` when a caller who is not a PSA asks for the `status` filter or for trashed groups.
   */
  listGroups(principal: AuthPrincipal, query: GroupsQuery): Promise<ReferencePage<GroupReference>>;
  /**
   * Lists the companies of a verified group inside the caller's perimeter (untrashed ones by default).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   */
  listCompanies(principal: AuthPrincipal, access: GroupAccess, query: CompaniesQuery): Promise<ReferencePage<CompanyReference>>;
  /**
   * Lists the places of a verified group inside the caller's perimeter (untrashed ones by default),
   * optionally of one company; a company outside the perimeter yields an empty page.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated query.
   */
  listPlaces(principal: AuthPrincipal, access: GroupAccess, query: PlacesQuery): Promise<ReferencePage<PlaceReference>>;
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
      if (principal.scope.kind !== 'platform' && (query.status !== undefined || query.trashed === 'true')) {
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
      const { items, page } = await repository.listGroups(principal, { $and: conditions }, listParamsOf(query, REFERENCE_LIST));
      return { items: items.map(toGroupReference), page };
    },

    listCompanies: async (principal, access, query) => {
      const { items, page } = await repository.listCompanies(principal, access, trashFilter(query.trashed), listParamsOf(query, REFERENCE_LIST));
      return { items: items.map(toCompanyReference), page };
    },

    listPlaces: async (principal, access, query) => {
      const conditions: Filter<Document>[] = [trashFilter(query.trashed)];
      if (query.companyId !== undefined) {
        conditions.push({ companyId: query.companyId });
      }
      const { items, page } = await repository.listPlaces(principal, access, { $and: conditions }, listParamsOf(query, REFERENCE_LIST));
      return { items: items.map(toPlaceReference), page };
    },
  };
}
