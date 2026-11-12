import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { ListPage } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { LOOKUP_LIST, LOOKUP_NAME } from './lookup.list.ts';
import type { LookupProductsQuery, LookupQuery } from './lookup.schemas.ts';
import type { LookupRepository } from './lookup.repository.ts';

/** An element of a group in the compact form the selectors need. */
export interface LookupItem {
  readonly id: string;
  /** The name to show; empty when the element has none that can be shown. */
  readonly name: string;
}

/** A product in the compact form. */
export interface LookupProductItem extends LookupItem {
  /** Legacy product type, or `null` when the product has none. */
  readonly type: string | null;
}

/** A page of compact elements. */
export interface LookupPage<T extends LookupItem> {
  readonly items: readonly T[];
  readonly page: PageInfo;
}

/** The compact reads of the group catalogs. Every method throws `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit. */
export interface LookupService {
  /** Products of the group, by name in the language of the caller; `NOT_FOUND` if the caller disappeared since the authentication. */
  products(principal: AuthPrincipal, access: GroupAccess, query: LookupProductsQuery): Promise<LookupPage<LookupProductItem>>;
  /** Product categories of the group, by name in the language of the caller; `NOT_FOUND` if the caller disappeared since the authentication. */
  categories(principal: AuthPrincipal, access: GroupAccess, query: LookupQuery): Promise<LookupPage<LookupItem>>;
  /** Customers of the group, by display name. */
  customers(principal: AuthPrincipal, access: GroupAccess, query: LookupQuery): Promise<LookupPage<LookupItem>>;
  /** Contact groups of the group, by name. */
  contactGroups(principal: AuthPrincipal, access: GroupAccess, query: LookupQuery): Promise<LookupPage<LookupItem>>;
}

/** Collaborators of {@link createLookupService}. */
export interface LookupDeps {
  readonly lookup: LookupRepository;
  /** Reads the language of the caller. */
  readonly users: Pick<UsersRepository, 'findById'>;
}

/** The ids of `ids` (already shape-checked by the schema) as distinct ObjectIds, or `null` when the parameter is absent. */
function idsOf(query: LookupQuery): ObjectId[] | null {
  return query.ids === undefined ? null : [...new Set(query.ids.toLowerCase().split(','))].map((id) => ObjectId.createFromHexString(id));
}

function itemOf(document: Document): LookupItem {
  const name: unknown = document[LOOKUP_NAME];
  return { id: (document['_id'] as ObjectId).toHexString(), name: typeof name === 'string' ? name : '' };
}

function pageOfItems<T extends LookupItem>(read: ListPage, map: (document: Document) => T): LookupPage<T> {
  return { items: read.items.map(map), page: read.page };
}

/**
 * Builds the service of the compact reads of the group catalogs.
 *
 * @param deps Repository of the reads and of the users.
 */
export function createLookupService(deps: LookupDeps): LookupService {
  const languageOf = async (principal: AuthPrincipal): Promise<string> => {
    const caller = await deps.users.findById(principal.userId);
    if (caller === null) {
      throw new AppError('NOT_FOUND');
    }
    return caller.user.language;
  };
  return {
    products: async (principal, access, query) => {
      const params = listParamsOf(query, LOOKUP_LIST);
      const read = await deps.lookup.products(principal, access, params, await languageOf(principal), idsOf(query), query.type === undefined ? {} : { type: query.type });
      return pageOfItems(read, (document) => ({ ...itemOf(document), type: typeof document['type'] === 'string' ? document['type'] : null }));
    },
    categories: async (principal, access, query) => {
      const params = listParamsOf(query, LOOKUP_LIST);
      return pageOfItems(await deps.lookup.categories(principal, access, params, await languageOf(principal), idsOf(query)), itemOf);
    },
    customers: async (principal, access, query) => pageOfItems(await deps.lookup.customers(principal, access, listParamsOf(query, LOOKUP_LIST), idsOf(query)), itemOf),
    contactGroups: async (principal, access, query) => pageOfItems(await deps.lookup.contactGroups(principal, access, listParamsOf(query, LOOKUP_LIST), idsOf(query)), itemOf),
  };
}
