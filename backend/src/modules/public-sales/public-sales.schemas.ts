import { enumOf, integerString, isoDate, object, objectId, optional, refine, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { SALE_FISCAL_STATES, withPeriodRules } from '../sales/sales.schemas.ts';

/** Page of the sales a public key reads when it asks for none, and the largest it may ask for (each sale carries its lines). */
export const PUBLIC_SALES_DEFAULT_PAGE = 20;
export const PUBLIC_SALES_MAX_PAGE = 50;

/** The kinds of receipt a public key may filter by: `partitioned` is the parent bill of a table split into several receipts, not a receipt. */
export const PUBLIC_RECEIPT_TYPES = ['receipt', 'invoice', 'charge', 'partitioned'] as const;

/**
 * Query of `GET /public/v1/sales`: the cursor pagination and the filters (the customer, the company, the point of sale, the period, the kind of receipt, the fiscal state, and whether the parent bills of split tables are listed). Without a
 * customer the period is required and at most one year long. Nothing else is accepted: no incremental filter, no sales that are not fiscal.
 */
export const publicSalesQuery = withPeriodRules(
  refine(
    object({
      limit: optional(integerString({ min: 1, max: PUBLIC_SALES_MAX_PAGE })),
      cursor: optional(string({ min: 1, max: 100, normalize: false })),
      contactId: optional(objectId()),
      companyId: optional(objectId()),
      placeId: optional(objectId()),
      from: optional(isoDate()),
      to: optional(isoDate()),
      receiptType: optional(enumOf(PUBLIC_RECEIPT_TYPES)),
      fiscalState: optional(enumOf(SALE_FISCAL_STATES)),
      partitioned: optional(enumOf(['include', 'exclude'] as const)),
    }),
    // Asking for the parent bills and leaving them out at once contradicts itself.
    (query) => (query.partitioned === 'exclude' && query.receiptType === 'partitioned' ? ['partitioned'] : []),
    'incorrect',
  ),
);

/** The validated query of the public list of sales. */
export type PublicSalesQuery = Infer<typeof publicSalesQuery>;

/** Path parameter of the route on one sale. */
export const publicSaleParams = object({ saleId: objectId() });
