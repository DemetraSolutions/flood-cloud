import type { ObjectId } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ApiKeyPrincipal } from '../../shared/security/scope/principal.ts';
import type { ApiKeyCallers } from '../public-catalog/public-catalog.caller.ts';
import { decodeSalesCursor, encodeSalesCursor } from '../sales/sales.cursor.ts';
import { salesFilter, salesPerimeter } from '../sales/sales.filters.ts';
import { toPublicSale } from './public-sales.mapper.ts';
import type { PublicSale } from './public-sales.mapper.ts';
import type { PublicSalesRepository } from './public-sales.repository.ts';
import { PUBLIC_SALES_DEFAULT_PAGE } from './public-sales.schemas.ts';
import type { PublicSalesQuery } from './public-sales.schemas.ts';

/** One page of sales of the public API. */
export interface PublicSalesPage {
  readonly items: PublicSale[];
  readonly page: PageInfo;
}

/**
 * The sales of the public API (`doc/Public-API.md`): what an integration with a public key reads (`sales:read`), read only. The sales that are not fiscal are never read; the parent bill of a table split into several receipts (`partitioned`)
 * is listed unless the request leaves it out. The restrictions of the key to companies and places are the perimeter of the read: a sale of another company or place is as if it did not exist. The customer is only an id, and nothing of the operator,
 * the loyalty card, the lottery code, the notes, the checks of the server or the costs is ever read.
 */
export interface PublicSalesService {
  /**
   * A page of the sales the key may read, the newest first.
   *
   * @throws {AppError} `NOT_FOUND` when the restrictions of the key match no place of the group; `VALIDATION_ERROR` on `cursor`/`format` for a cursor this server did not issue; `SERVICE_UNAVAILABLE` on a read that exceeds its time limit.
   */
  list(principal: ApiKeyPrincipal, access: GroupAccess, query: PublicSalesQuery): Promise<PublicSalesPage>;
  /** @throws {AppError} `NOT_FOUND` when the sale does not exist, is of another group, outside the perimeter of the key or not fiscal. */
  get(principal: ApiKeyPrincipal, access: GroupAccess, id: ObjectId): Promise<PublicSale>;
}

/** Collaborators of {@link createPublicSalesService}. */
export interface PublicSalesServiceDeps {
  readonly repository: PublicSalesRepository;
  readonly callers: ApiKeyCallers;
}

/**
 * Builds the sales service of the public API.
 *
 * @param deps The read repository and the factory of the callers of the keys.
 */
export function createPublicSalesService(deps: PublicSalesServiceDeps): PublicSalesService {
  const { repository, callers } = deps;
  return {
    list: async (principal, access, query) => {
      const caller = await callers.callerOf(principal);
      const limit = query.limit ?? PUBLIC_SALES_DEFAULT_PAGE;
      const after = query.cursor === undefined ? null : decodeSalesCursor(query.cursor);
      // One more than asked is read, to know whether another page follows.
      const documents = await repository.find(caller, access, salesFilter(caller.scope, query, after, query.partitioned ?? 'include'), limit + 1);
      const kept = documents.slice(0, limit);
      const final = kept[kept.length - 1];
      const next = documents.length > limit ? encodeSalesCursor({ date: final!['date'] as Date, id: final!['_id'] as ObjectId }) : null;
      return { items: kept.map(toPublicSale), page: { limit, next } };
    },

    get: async (principal, access, id) => {
      const caller = await callers.callerOf(principal);
      const document = await repository.findOne(caller, access, { $and: [salesPerimeter(caller.scope), { _id: id, sType: { $in: [false, null] } }] });
      if (document === null) {
        throw new AppError('NOT_FOUND');
      }
      return toPublicSale(document);
    },
  };
}
