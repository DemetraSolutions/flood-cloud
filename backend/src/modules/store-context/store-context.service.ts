import { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { CompaniesPlacesWriter } from '../../shared/legacy-write/companies-places.writer.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';
import type { Catalog } from '../groups/catalogs/catalog.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { cardTypes } from '../groups/catalogs/card-types.ts';
import { pointsCollections } from '../groups/catalogs/points-collections.ts';
import { prizeCatalogues } from '../groups/catalogs/prize-catalogues.ts';
import { productFavorites } from '../groups/catalogs/product-favorites.ts';
import { promotions } from '../groups/catalogs/promotions.ts';
import { toResponse } from '../groups/group.mapper.ts';
import type { ManagedGroupsRepository } from '../groups/groups.repository.ts';
import { toCompany } from '../companies/company.mapper.ts';
import type { Company } from '../companies/company.types.ts';
import { toStorePlace } from '../places/place.mapper.ts';
import type { StorePlace } from '../places/place.types.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { USERS_LIST } from '../users/users.list.ts';
import { toStoreGroup, toStoreUser } from './store-context.mapper.ts';
import { storeUsersFilter } from './store-context.users.ts';
import type { StoreUsersQuery } from './store-context.users.ts';
import type { StoreContextRepository } from './store-context.repository.ts';
import type { ExtraGroupCatalogs, StoreGroup, StoreUser } from './store-context.types.ts';

/** The group as the server of a store reads it. A group has no stored version: the controller tags it with a keyed digest of the content. */
export interface StoreGroupResult {
  readonly group: StoreGroup;
}

/** The company with the version of its stored document: the strong `ETag`. */
export interface StoreCompanyResult {
  readonly company: Company;
  readonly version: string;
}

/** The place, credentials in clear, with the version of its stored document: the strong `ETag`. */
export interface StorePlaceResult {
  readonly place: StorePlace;
  readonly version: string;
}

/** A page of the users of the place of the store, with the PIN in clear. */
export interface StoreUsersResult {
  readonly users: readonly StoreUser[];
  /** The company the place has now, the one the filter used (for the audit). */
  readonly companyId: ObjectId;
  readonly page: PageInfo;
}

/** The complete configuration of the group, the company and the place of a store key, for the server of that point of sale. */
export interface StoreContextService {
  /**
   * The group of the store: the record, features, integrations (keys in clear), languages, statistics settings and every catalog of its document, each capped by its limit, plus the
   * temporary legacy key. The public API of the group, the reference to the dealer and the infrastructure are never part of it.
   *
   * @param store The store principal (the ids come from it alone).
   * @param access Verified access to the group of the store.
   * @throws {AppError} `NOT_FOUND` if the group disappeared since the key was authenticated.
   */
  getGroup(store: StorePrincipal, access: GroupAccess): Promise<StoreGroupResult>;
  /**
   * The company the place belongs to now, complete: the company id is read from the place document of the group database (the source of truth), not from the copy the principal was built from.
   *
   * @param store The store principal.
   * @param access Verified access to the group of the store.
   * @throws {AppError} `NOT_FOUND` if the place is gone, its company id is not an id, or the company is gone.
   */
  getCompany(store: StorePrincipal, access: GroupAccess): Promise<StoreCompanyResult>;
  /**
   * The place of the store, complete, with the credentials of its integrations and devices in clear and the dealer settings.
   *
   * @param store The store principal.
   * @param access Verified access to the group of the store.
   * @throws {AppError} `NOT_FOUND` if the place is gone.
   */
  getPlace(store: StorePrincipal, access: GroupAccess): Promise<StorePlaceResult>;
  /**
   * A page of the users involved in the place of the store, with their PIN in clear: the `E` and `PA` of the place, the `CA` of the company the place has now (read from the place document
   * of the group database) and the `SA` of the group, in the default order of the users list; never a PSA or a dealer, a trashed user or one of another group. Disabled users are included.
   *
   * @param store The store principal (the only source of the group and the place).
   * @param access Verified access to the group of the store.
   * @param query The validated `limit` and `cursor`.
   * @throws {AppError} `NOT_FOUND` if the place is gone or has no company id; `VALIDATION_ERROR` for a cursor that does not fit.
   */
  getUsers(store: StorePrincipal, access: GroupAccess, query: StoreUsersQuery): Promise<StoreUsersResult>;
}

/** Collaborators of {@link createStoreContextService}. */
export interface StoreContextServiceDeps {
  readonly groups: ManagedGroupsRepository;
  readonly repository: StoreContextRepository;
  readonly users: Pick<UsersRepository, 'listForStore'>;
  readonly catalogs: Pick<CatalogsService, 'list'>;
  /** The read of the companies and places of the store's own perimeter. */
  readonly readerFor: (store: StorePrincipal, access: GroupAccess) => Pick<CompaniesPlacesWriter, 'read'>;
  readonly logger: Logger;
}

/** The catalogs the group detail leaves to its sub-resources, by the name the response gives them. */
const EXTRA_CATALOGS: { readonly [Name in keyof ExtraGroupCatalogs]: Catalog } = { cardTypes, pointsCollections, prizeCatalogues, productFavorites, promotions };

/**
 * Builds the service of the store context. Every read is bounded (one document, or the catalogs of one document capped by their limits) and starts from the ids of the store principal:
 * nothing of a request chooses what is read.
 *
 * @param deps Repositories, the catalogs service, the reader of companies and places, and the logger.
 */
export function createStoreContextService(deps: StoreContextServiceDeps): StoreContextService {
  const { groups, repository, catalogs, readerFor, logger, users } = deps;
  const orNotFound = <T>(value: T | null): T => {
    if (value === null) {
      throw new AppError('NOT_FOUND');
    }
    return value;
  };
  const extraCatalogs = async (access: GroupAccess): Promise<ExtraGroupCatalogs> => {
    const names = Object.keys(EXTRA_CATALOGS) as Array<keyof ExtraGroupCatalogs>;
    const lists = await Promise.all(names.map(async (name) => (await catalogs.list(EXTRA_CATALOGS[name], access)).slice(0, EXTRA_CATALOGS[name].limit)));
    return Object.fromEntries(names.map((name, index) => [name, lists[index]])) as unknown as ExtraGroupCatalogs;
  };
  const read = async (store: StorePrincipal, access: GroupAccess, kind: 'companies' | 'places', id: ObjectId) => orNotFound(await readerFor(store, access).read(kind, id));
  /** The company the place has now, from the place document of the group database, and the store principal that names only that company. */
  const currentCompany = async (store: StorePrincipal, access: GroupAccess): Promise<{ readonly current: StorePrincipal; readonly companyId: ObjectId }> => {
    const { document: place } = await read(store, access, 'places', store.placeId);
    const companyId = place['companyId'];
    if (!(companyId instanceof ObjectId)) {
      throw new AppError('NOT_FOUND');
    }
    // The same store, with the company the place has now in the group database: nothing but the company of its own place can be named.
    return { current: Object.freeze({ ...store, companyId, scope: Object.freeze({ ...store.scope, companyId }) }), companyId };
  };
  return {
    getGroup: async (store, access) => {
      const mapped = orNotFound(await groups.findById(store.groupId));
      if (mapped.anomalies.length > 0) {
        logger.warn('group anomalies', { groupId: store.groupId.toHexString(), anomalies: mapped.anomalies });
      }
      const credentials = orNotFound(await repository.groupCredentials(store.groupId));
      return { group: toStoreGroup(toResponse(mapped.group, false, false), credentials, await extraCatalogs(access)) };
    },

    getCompany: async (store, access) => {
      const { current, companyId } = await currentCompany(store, access);
      const { document, version } = await read(current, access, 'companies', companyId);
      return { company: toCompany(document, access.groupId), version };
    },

    getUsers: async (store, access, query) => {
      const { companyId } = await currentCompany(store, access);
      const { users: found, page } = await users.listForStore(storeUsersFilter(store.groupId, store.placeId, companyId), listParamsOf(query, USERS_LIST));
      return { users: found.map(toStoreUser), page, companyId };
    },

    getPlace: async (store, access) => {
      const { document, version } = await read(store, access, 'places', store.placeId);
      return { place: toStorePlace(document, access.groupId), version };
    },
  };
}
