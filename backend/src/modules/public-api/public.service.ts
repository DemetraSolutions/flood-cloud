import type { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';
import { PUBLIC_QUOTA_BUCKET, QUOTA_WINDOW_SECONDS } from '../api-keys/authenticate-api-key.ts';
import type { ManagedGroupsRepository } from '../groups/groups.repository.ts';
import { toMe, toPublicCompany, toPublicCurrency, toPublicMeasureUnit, toPublicPlace, toPublicPriceList, toPublicTax } from './public.mapper.ts';
import { PUBLIC_NAME_LIST } from './public.list.ts';
import type { PublicRepository } from './public.repository.ts';
import type { PublicListQuery } from './public.schemas.ts';

/** A page of public items. */
export interface PublicPage<T> {
  readonly items: readonly T[];
  readonly page: PageInfo;
}

/** The reads of the public API, for the integration of one group (`doc/Public-API.md`). */
export interface PublicService {
  /** The key that is calling, its group, its limits and what it used today. */
  me(principal: ApiKeyPrincipal): Promise<ReturnType<typeof toMe>>;
  /** A page of the places the key sees. */
  places(principal: ApiKeyPrincipal, query: PublicListQuery): Promise<PublicPage<ReturnType<typeof toPublicPlace>>>;
  /** One place; `404` when the key does not see it (it does not exist, is in the trash, is of another group or is outside the restrictions). */
  place(principal: ApiKeyPrincipal, placeId: ObjectId): Promise<ReturnType<typeof toPublicPlace>>;
  /** A page of the companies the key sees. */
  companies(principal: ApiKeyPrincipal, query: PublicListQuery): Promise<PublicPage<ReturnType<typeof toPublicCompany>>>;
  /** One company; `404` as for a place. */
  company(principal: ApiKeyPrincipal, companyId: ObjectId): Promise<ReturnType<typeof toPublicCompany>>;
  /** The price lists of the group of the key. */
  priceLists(principal: ApiKeyPrincipal): Promise<Array<ReturnType<typeof toPublicPriceList>>>;
  /** The tax rates of the group of the key. */
  taxes(principal: ApiKeyPrincipal): Promise<Array<ReturnType<typeof toPublicTax>>>;
  /** The currencies of the group of the key. */
  currencies(principal: ApiKeyPrincipal): Promise<Array<ReturnType<typeof toPublicCurrency>>>;
  /** The measure units of the group of the key. */
  measureUnits(principal: ApiKeyPrincipal): Promise<Array<ReturnType<typeof toPublicMeasureUnit>>>;
}

/** Collaborators of {@link createPublicService}. */
export interface PublicServiceDeps {
  readonly repository: PublicRepository;
  /** The group, for its catalogs. */
  readonly groups: Pick<ManagedGroupsRepository, 'findById'>;
  /** The counter of the daily quota, which `me` only reads. */
  readonly rateLimiter: Pick<RateLimiter, 'peek'>;
}

/**
 * Builds the service of the public reads.
 *
 * @param deps Repository, group reader and the counter of the daily quota.
 */
export function createPublicService(deps: PublicServiceDeps): PublicService {
  const { repository, groups, rateLimiter } = deps;

  const catalogs = async (principal: ApiKeyPrincipal) => {
    const found = await groups.findById(principal.groupId);
    if (found === null) {
      throw new AppError('NOT_FOUND');
    }
    return found.group.catalogs;
  };

  return {
    me: async (principal) => {
      const quota = await rateLimiter.peek(PUBLIC_QUOTA_BUCKET, principal.keyId.toHexString(), principal.dailyQuota, QUOTA_WINDOW_SECONDS);
      return toMe(principal, principal.dailyQuota - quota.remaining);
    },

    places: async (principal, query) => {
      const { items, page } = await repository.listPlaces(principal, listParamsOf(query, PUBLIC_NAME_LIST));
      return { items: items.map(toPublicPlace), page };
    },

    place: async (principal, placeId) => {
      const place = await repository.findPlace(principal, placeId);
      if (place === null) {
        throw new AppError('NOT_FOUND');
      }
      return toPublicPlace(place);
    },

    companies: async (principal, query) => {
      const { items, page } = await repository.listCompanies(principal, listParamsOf(query, PUBLIC_NAME_LIST));
      return { items: items.map(toPublicCompany), page };
    },

    company: async (principal, companyId) => {
      const company = await repository.findCompany(principal, companyId);
      if (company === null) {
        throw new AppError('NOT_FOUND');
      }
      return toPublicCompany(company);
    },

    priceLists: async (principal) => (await catalogs(principal)).priceLists.map(toPublicPriceList),

    taxes: async (principal) => (await catalogs(principal)).taxes.map(toPublicTax),

    currencies: async (principal) => (await catalogs(principal)).currencies.map(toPublicCurrency),

    measureUnits: async (principal) => (await catalogs(principal)).measureUnits.map(toPublicMeasureUnit),
  };
}
