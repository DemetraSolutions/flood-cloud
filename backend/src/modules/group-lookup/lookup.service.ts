import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { ListPage } from '../../shared/http/list.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { LOOKUP_LIST, LOOKUP_NAME } from './lookup.list.ts';
import { parseIds } from './lookup.schemas.ts';
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
  /**
   * The price lists of the group (`id`, `name`, `enabled`, `isDefault`), read from the group document with the mapping of the price-list catalog and
   * without any other field. The catalog is bounded (at most 50 lists), so the answer is not paginated; `NOT_FOUND` if the group does not exist.
   */
  priceLists(access: GroupAccess): Promise<PriceList[]>;
  /** E-mail templates of the group (`id`, `name`), by name. */
  emailTemplates(principal: AuthPrincipal, access: GroupAccess, query: LookupQuery): Promise<LookupPage<LookupItem>>;
  /** The languages of the group as `[{ code }]` (the codes that are texts, as stored; `it` when the group lists none). Bounded by the document of the group. */
  languages(access: GroupAccess): Promise<readonly { readonly code: string }[]>;
}

/** Collaborators of {@link createLookupService}. */
export interface LookupDeps {
  readonly lookup: LookupRepository;
  /** Reads the language of the caller. */
  readonly users: Pick<UsersRepository, 'findById'>;
  /** Reads the catalogs stored in the group document. */
  readonly catalogs: Pick<CatalogsService, 'list'>;
}

/** The ids of `ids` (already shape-checked by the schema) as distinct ObjectIds, or `null` when the parameter is absent. */
function idsOf(query: LookupQuery): ObjectId[] | null {
  return parseIds(query.ids);
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
    emailTemplates: async (principal, access, query) => pageOfItems(await deps.lookup.emailTemplates(principal, access, listParamsOf(query, LOOKUP_LIST), idsOf(query)), itemOf),
    languages: async (access) => {
      const codes = ((await deps.lookup.languages(access)) ?? []).filter((code): code is string => typeof code === 'string' && code !== '');
      return (codes.length === 0 ? ['it'] : codes).map((code) => ({ code }));
    },
    priceLists: async (access) =>
      ((await deps.catalogs.list(priceLists, access)) as PriceList[]).map(({ id, name, enabled, isDefault }) => ({ id, name, enabled, isDefault })),
  };
}
