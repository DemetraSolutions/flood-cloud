import type { ObjectId } from 'mongodb';
import { enumOf, integerString, isoDate, object, objectId, optional, refine, string } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';

/** Largest page of the sales table. */
export const SALES_MAX_LIMIT = 100;

/** Default page of the sales table. */
export const SALES_DEFAULT_LIMIT = 20;

/** The kinds of receipt a request may filter by (`partitioned`, the parent bill of a split table, is never listed nor counted). */
export const SALE_RECEIPT_TYPES = ['receipt', 'invoice', 'charge'] as const;

/** The fiscal states a request may filter by: `none` is a sale that was neither canceled nor refunded. */
export const SALE_FISCAL_STATES = ['none', 'canceled', 'refunded'] as const;

/** Whether the sales that are not fiscal (the "Preventivo" of the legacy) are left out (the default) or listed too. */
export const SALE_NON_FISCAL_MODES = ['exclude', 'include'] as const;

/** The filters the table, its summary and the customer purchases share. */
const filters = {
  contactId: optional(objectId()),
  companyId: optional(objectId()),
  placeId: optional(objectId()),
  from: optional(isoDate()),
  to: optional(isoDate()),
  receiptType: optional(enumOf(SALE_RECEIPT_TYPES)),
  fiscalState: optional(enumOf(SALE_FISCAL_STATES)),
  unpaid: optional(enumOf(['true'] as const)),
  invoiced: optional(enumOf(['true'] as const)),
  nonFiscal: optional(enumOf(SALE_NON_FISCAL_MODES)),
};

/** The longest period a read without a customer may cover, in years. */
const MAX_PERIOD_YEARS = 1;

/** The filters the rules between the filters look at. */
interface Period {
  readonly contactId?: ObjectId;
  readonly from?: Date;
  readonly to?: Date;
}

/** A read without a customer needs a bounded period: `from` and `to` are both required then (the whole collection is never read). */
const periodRequired = (value: Period): string[] => (value.contactId !== undefined ? [] : [value.from === undefined ? 'from' : null, value.to === undefined ? 'to' : null].filter((field): field is string => field !== null));

/** The period runs forward: `to` is after `from`. */
const periodOrdered = (value: Period): string[] => (value.from !== undefined && value.to !== undefined && value.to.getTime() <= value.from.getTime() ? ['to'] : []);

/** Without a customer the period is at most one year long. */
const periodShort = (value: Period): string[] => {
  if (value.contactId !== undefined || value.from === undefined || value.to === undefined) {
    return [];
  }
  const limit = new Date(value.from);
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_PERIOD_YEARS);
  return value.to.getTime() > limit.getTime() ? ['to'] : [];
};

/** Adds the rules between the filters to a query schema (the first problem found stops the others). */
export function withPeriodRules<T extends Period>(schema: Schema<T, false>): Schema<T, false> {
  return refine(refine(refine(schema, periodRequired, 'required'), periodOrdered, 'incorrect'), periodShort, 'maximum');
}

/** Query of `GET /v1/groups/{groupId}/sales`: the filters and the cursor pagination. Unknown parameters are refused. */
export const salesQuery = withPeriodRules(
  object({
    limit: optional(integerString({ min: 1, max: SALES_MAX_LIMIT })),
    cursor: optional(string({ min: 1, max: 100, normalize: false })),
    ...filters,
  }),
);

/** Validated query of the sales table. */
export type SalesQuery = Infer<typeof salesQuery>;

/** Query of `GET /v1/groups/{groupId}/sales/summary`: the same filters, with no pagination. */
export const salesSummaryQuery = withPeriodRules(object({ ...filters }));

/** Validated query of the summary. */
export type SalesSummaryQuery = Infer<typeof salesSummaryQuery>;

/** The filters both reads share, after validation. */
export type SalesFilters = SalesSummaryQuery;

/** Query of `GET /v1/groups/{groupId}/sales/{saleId}`: only `nonFiscal`, the signal of the UM mode (a sale that is not fiscal is `404` without `include`). */
export const saleQuery = object({ nonFiscal: optional(enumOf(SALE_NON_FISCAL_MODES)) });

/** Validated query of one sale. */
export type SaleQuery = Infer<typeof saleQuery>;

/** Path of `GET /v1/groups/{groupId}/sales/{saleId}`; the group was already verified by the route. */
export const saleParams = object({ saleId: objectId() }, { allowUnknown: true });

/** Validated path of one sale. */
export type SaleParams = Infer<typeof saleParams>;
