import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { clearText } from '../contacts/contacts.document.ts';
import { DETAIL_PROJECTION, ROW_PROJECTION } from './sales.mapper.ts';

/** What the sales of a query add up to: how many, what they brought in and what was refunded of it. */
export interface SalesTotals {
  readonly count: number;
  /** The sum of the totals of the sales, refunds not subtracted. */
  readonly gross: number;
  /** The sum of the amounts returned by the refunds of the sales that were refunded. */
  readonly refunded: number;
}

/** The reads of the sales of a group (the legacy owns them: nothing is ever written) and the names of the operators who made them. */
export interface SalesRepository {
  /**
   * A page of sales, the newest first (by date, then by id).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter The perimeter, the filters and the position of the page, from `salesFilter`.
   * @param limit How many sales to read.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  find(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>, limit: number): Promise<Document[]>;
  /**
   * What the sales of a query add up to, in one aggregation; the canceled sales are not counted.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter The perimeter and the filters, from `salesFilter`.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  totals(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>): Promise<SalesTotals>;
  /**
   * One sale with its lines and payments.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter The perimeter and the id, from `saleFilter`.
   * @returns The stored sale, or `null` when no sale matches.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  findOne(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>): Promise<Document | null>;
  /**
   * The document of the invoice of a sale, with only what shows its number and its state of sending (the e-invoicing moves `sendStatus` in it, so it is read from the document and not from the sale).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param filter From `invoiceFilterOf` over a sale the caller may read.
   * @returns The document, or `null` when it does not exist.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  findInvoice(principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>): Promise<Document | null>;
  /**
   * The names of the operators of a page of sales, read from the users of the group (an operator of another group is not found).
   *
   * @param access Verified access to the group.
   * @param ids The users, at most a page; none gives no names without a read.
   * @returns The name (first name and surname in clear, else the user name) by hexadecimal id; a user that does not exist, or has no name, is absent.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  operators(access: GroupAccess, ids: readonly ObjectId[]): Promise<Map<string, string>>;
}

/** `$cond` that keeps a number the aggregation can add (not a text, a `NaN` or an infinity) and gives `0` for any other value. */
function finite(expression: string): Document {
  return {
    $let: {
      vars: { value: expression },
      in: { $cond: [{ $and: [{ $in: [{ $type: '$$value' }, ['double', 'int', 'long']] }, { $gt: ['$$value', -Infinity] }, { $lt: ['$$value', Infinity] }] }, '$$value', 0] },
    },
  };
}

/** The sum of the amounts returned by the refunds of a sale (`refund[].returnedGoodsValue.priceTaxed`), `0` when `refund` is not a list. */
const REFUNDED_OF_SALE: Document = {
  $reduce: { input: { $cond: [{ $isArray: '$refund' }, '$refund', []] }, initialValue: 0, in: { $add: ['$$value', finite('$$this.returnedGoodsValue.priceTaxed')] } },
};

/**
 * Builds the repository of the sales. The `sales` collection of a group database is read through the verified group access; every read has a time limit and a bound, and the projections are fixed lists of fields. Nothing is written
 * to the collection; the only thing this backend creates on it is the index of the purchases of a customer (`createSalesIndexGuard`).
 *
 * @param databases Database accessor.
 */
export function createSalesRepository(databases: Databases): SalesRepository {
  const sales = (principal: AuthPrincipal, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('sales');
  return {
    find: (principal, access, filter, limit) => bounded(() => sales(principal, access).find(filter, { projection: { ...ROW_PROJECTION }, sort: { date: -1, _id: -1 }, limit, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),

    totals: async (principal, access, filter) => {
      const [found] = await bounded(() =>
        sales(principal, access)
          .aggregate(
            [
              { $match: { $and: [filter, { fiscalState: { $ne: 'canceled' } }] } },
              { $group: { _id: null, count: { $sum: 1 }, gross: { $sum: finite('$finalTotalCheckout') }, refunded: { $sum: { $cond: [{ $eq: ['$fiscalState', 'refunded'] }, REFUNDED_OF_SALE, 0] } } } },
            ],
            { maxTimeMS: LIST_MAX_TIME_MS },
          )
          .toArray(),
      );
      return found === undefined ? { count: 0, gross: 0, refunded: 0 } : { count: found['count'] as number, gross: found['gross'] as number, refunded: found['refunded'] as number };
    },

    findOne: (principal, access, filter) => bounded(() => sales(principal, access).findOne(filter, { projection: { ...DETAIL_PROJECTION }, maxTimeMS: LIST_MAX_TIME_MS })),

    findInvoice: (principal, access, filter) =>
      bounded(() => groupDatabaseFor(principal, access, databases).collection('documents').findOne(filter, { projection: { number: 1, prefixSuffix: 1, date: 1, sendStatus: 1 }, maxTimeMS: LIST_MAX_TIME_MS })),

    operators: async (access, ids) => {
      if (ids.length === 0) {
        return new Map();
      }
      const found = await bounded(() => databases.common().collection('users').find({ _id: { $in: [...ids] }, groupId: access.groupId }, { projection: { name: 1, surname: 1, userName: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      const names = found.map((user): [string, string] => [(user['_id'] as ObjectId).toHexString(), `${clearText(user['name'])} ${clearText(user['surname'])}`.trim() || clearText(user['userName'])]);
      return new Map(names.filter(([, name]) => name !== ''));
    },
  };
}
