import { ObjectId } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { hasPermission } from '../../shared/security/rbac/policy.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import { decodeSalesCursor, encodeSalesCursor } from './sales.cursor.ts';
import { salesFilter, salesPerimeter } from './sales.filters.ts';
import { invoiceFilterOf, operatorIdsOf, saleDetail, saleRow } from './sales.mapper.ts';
import type { SaleDetail, SaleRow } from './sales.mapper.ts';
import type { SalesRepository } from './sales.repository.ts';
import type { SalesIndexGuard } from './sales.indexes.ts';
import { SALES_DEFAULT_LIMIT } from './sales.schemas.ts';
import type { SalesQuery, SalesSummaryQuery } from './sales.schemas.ts';

/** One page of sales. */
export interface SalesPage {
  readonly items: SaleRow[];
  readonly page: PageInfo;
}

/** What a set of sales adds up to, in the currency of the group (the sales do not carry one), rounded to two decimals. */
export interface SalesSummary {
  /** What the sales brought in, net of what the refunds returned. */
  readonly total: number;
  /** How many sales, the canceled ones and the parent bills of split tables left out. */
  readonly count: number;
  /** `total / count`, `0` when there is no sale. */
  readonly average: number;
  /** What the refunds returned, already taken from `total`. */
  readonly refunded: number;
}

/** Business rules of the sales: a read only view of what the legacy point of sale wrote. */
export interface SalesService {
  /**
   * A page of the sales the caller may read, the newest first. The perimeter of the role (a company administrator reads the sales of his companies, a place administrator those of his places) is always applied by the server; a company or a
   * place of the filters outside it gives an empty page. A read for a customer asks the group for the index of the purchases, without waiting for it.
   *
   * @param principal The authenticated caller (the route already requires `sales:read`).
   * @param access Verified access to the group.
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor this server did not issue; `SERVICE_UNAVAILABLE` on a read that exceeds its time limit.
   */
  list(principal: AuthPrincipal, access: GroupAccess, query: SalesQuery): Promise<SalesPage>;
  /**
   * What the sales of the same filters add up to, net of the refunds: the canceled sales and the parent bills of split tables are not counted, a partial refund takes away only the part returned.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param query Validated filters.
   * @throws {AppError} `SERVICE_UNAVAILABLE` on a read that exceeds its time limit.
   */
  summary(principal: AuthPrincipal, access: GroupAccess, query: SalesSummaryQuery): Promise<SalesSummary>;
  /**
   * One sale with its lines, totals, payments, refunds, the check and anomalies of the server, its invoice (with the state of sending read from the document) and what is still returnable. A sale that is not fiscal is readable by its id.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the sale.
   * @param nonFiscal `include` (the UM mode of the backoffice) to read a sale that is not fiscal; without it such a sale is `404`. It is a signal, not an access control by role.
   * @throws {AppError} `NOT_FOUND` when the sale does not exist, is outside the perimeter of the caller, is the parent bill of a split table or is not fiscal and `nonFiscal` is not `include`; `SERVICE_UNAVAILABLE` on a read that exceeds its time limit.
   */
  get(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, nonFiscal: 'exclude' | 'include'): Promise<SaleDetail>;
}

/** Dependencies of {@link createSalesService}. */
export interface SalesDeps {
  readonly repository: SalesRepository;
  /** The user, for his language (the names of the products are shown in it). */
  readonly users: Pick<UsersRepository, 'findById'>;
  /** Creates the index of the purchases of a customer. */
  readonly indexes: SalesIndexGuard;
}

/** An amount rounded to two decimals, with no negative zero. */
const rounded = (value: number): number => Math.round(value * 100) / 100 + 0;

/**
 * Builds the service of the sales.
 *
 * @param deps Repository, users and the guard of the index.
 */
export function createSalesService(deps: SalesDeps): SalesService {
  const { repository, users, indexes } = deps;

  /** The index is asked for before a read for a customer; the read does not wait for it (the promise never rejects). */
  const prepare = (principal: AuthPrincipal, access: GroupAccess, query: SalesSummaryQuery): void => {
    if (query.contactId !== undefined) {
      void indexes.ensure(principal, access);
    }
  };

  return {
    list: async (principal, access, query) => {
      const limit = query.limit ?? SALES_DEFAULT_LIMIT;
      const after = query.cursor === undefined ? null : decodeSalesCursor(query.cursor);
      prepare(principal, access, query);
      // One more than asked is read, to know whether another page follows.
      const documents = await repository.find(principal, access, salesFilter(principal.scope, query, after), limit + 1);
      const kept = documents.slice(0, limit);
      const operators = await repository.operators(access, operatorIdsOf(kept));
      const final = kept[kept.length - 1];
      const next = documents.length > limit ? encodeSalesCursor({ date: final!['date'] as Date, id: final!['_id'] as ObjectId }) : null;
      return { items: kept.map((document) => saleRow(document, operators)), page: { limit, next } };
    },

    summary: async (principal, access, query) => {
      prepare(principal, access, query);
      const { count, gross, refunded } = await repository.totals(principal, access, salesFilter(principal.scope, query));
      const net = gross - refunded;
      return { total: rounded(net), count, average: count === 0 ? 0 : rounded(net / count), refunded: rounded(refunded) };
    },

    get: async (principal, access, id, nonFiscal) => {
      const document = await repository.findOne(principal, access, { $and: [salesPerimeter(principal.scope), { _id: id, receiptType: { $ne: 'partitioned' } }, ...(nonFiscal === 'include' ? [] : [{ sType: { $in: [false, null] } }])] });
      if (document === null) {
        throw new AppError('NOT_FOUND');
      }
      const invoiceFilter = invoiceFilterOf(document);
      const [operators, user, invoice] = await Promise.all([repository.operators(access, operatorIdsOf([document])), users.findById(principal.userId), invoiceFilter === null ? null : repository.findInvoice(principal, access, invoiceFilter)]);
      return saleDetail(document, operators, user?.user.language ?? null, hasPermission(principal, 'fidelity:read'), invoice);
    },
  };
}
