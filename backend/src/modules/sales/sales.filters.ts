import type { Document, Filter, ObjectId } from 'mongodb';
import type { Scope } from '../../shared/security/scope/scope.ts';
import type { SalesCursor } from './sales.cursor.ts';
import type { SalesFilters } from './sales.schemas.ts';

/** The filters of a read: those of the table of the backoffice, which never asks for a parent bill of a split table, or the ones of the public API, which can. */
export type ConditionFilters = Omit<SalesFilters, 'receiptType'> & { readonly receiptType?: SalesFilters['receiptType'] | 'partitioned' };

/** A filter that matches no sale. */
const NOTHING: Filter<Document> = { _id: { $in: [] } };

/** An id as the legacy stores it: an `ObjectId`, and as text in the old documents. */
const either = (id: ObjectId): Filter<Document> => ({ $in: [id, id.toHexString()] });

/**
 * The part of the group the caller may read, decided by the server from the authentication (never from the request): the whole group for a group administrator, a dealer and the platform administrator, only the sales
 * of his companies for a company administrator and only the sales of his places for a place administrator. Every other scope reads nothing. It is always combined with the filters of the request, which can only narrow it.
 *
 * @param scope Scope of the caller.
 * @returns A MongoDB filter on `companyId` and `placeId`.
 */
export function salesPerimeter(scope: Scope): Filter<Document> {
  switch (scope.kind) {
    case 'platform':
    case 'dealer':
    case 'group':
      return {};
    case 'companies':
      return { companyId: { $in: [...scope.companyIds].flatMap((id) => [id, id.toHexString()]) } };
    case 'places':
      return { placeId: { $in: [...scope.placeIds].flatMap((id) => [id, id.toHexString()]) } };
    case 'store':
    case 'none':
      return NOTHING;
  }
}

/**
 * The conditions a sale must meet to be listed or counted: the filters of the request, the sales that are not fiscal (`sType` anything but `false`, `null` or missing) left out unless asked, and the parent bill of a split table (`partitioned`) always left out. A sale
 * with no valid date is never read: the table is ordered by date.
 *
 * @param filters The validated filters.
 * @param partitioned `include` (the public API) to list the parent bills of split tables too when no `receiptType` is asked; they are left out by default.
 * @returns The conditions, to be combined with {@link salesPerimeter}.
 */
export function salesConditions(filters: ConditionFilters, partitioned: 'exclude' | 'include' = 'exclude'): Filter<Document>[] {
  const conditions: Filter<Document>[] = [{ date: { $type: 'date', ...(filters.from === undefined ? {} : { $gte: filters.from }), ...(filters.to === undefined ? {} : { $lt: filters.to }) } }];
  if (filters.receiptType !== undefined) {
    conditions.push({ receiptType: filters.receiptType });
  } else if (partitioned === 'exclude') {
    conditions.push({ receiptType: { $ne: 'partitioned' } });
  }
  if (filters.contactId !== undefined) {
    conditions.push({ 'customer._id': either(filters.contactId) });
  }
  if (filters.companyId !== undefined) {
    conditions.push({ companyId: either(filters.companyId) });
  }
  if (filters.placeId !== undefined) {
    conditions.push({ placeId: either(filters.placeId) });
  }
  if (filters.fiscalState !== undefined) {
    conditions.push({ fiscalState: filters.fiscalState === 'none' ? { $nin: ['canceled', 'refunded'] } : filters.fiscalState });
  }
  if (filters.unpaid !== undefined) {
    conditions.push({ unpaid: { $gt: 0 } });
  }
  if (filters.invoiced !== undefined) {
    conditions.push({ status: 'invoiced' });
  }
  if (filters.nonFiscal !== 'include') {
    // In doubt a sale is not fiscal: only an explicit `false`, `null` or a missing flag is a fiscal sale.
    conditions.push({ sType: { $in: [false, null] } });
  }
  return conditions;
}

/**
 * The whole condition of a read: the perimeter of the caller, the filters of the request and, for a page after the first, the position after the cursor (older, or the same instant with a smaller id).
 *
 * @param scope Scope of the caller.
 * @param filters The validated filters.
 * @param after Where the page continues from, `null` for the first page and for the summary.
 * @param partitioned As in {@link salesConditions}.
 */
export function salesFilter(scope: Scope, filters: ConditionFilters, after: SalesCursor | null = null, partitioned: 'exclude' | 'include' = 'exclude'): Filter<Document> {
  const conditions = [salesPerimeter(scope), ...salesConditions(filters, partitioned)];
  if (after !== null) {
    conditions.push({ $or: [{ date: { $lt: after.date } }, { date: after.date, _id: { $lt: after.id } }] });
  }
  return { $and: conditions };
}
