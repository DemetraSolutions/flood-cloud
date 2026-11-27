import { array, boolean, enumOf, integer, integerString, isForbiddenKey, isoDate, nullable, number, object, objectId, optional, refine, string } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';

/** Largest body a sale of the point of sale may have (`413` above it). */
export const SALE_BODY_LIMIT = '1mb';

/** Most entries a sale may have, counting its lines, the modifiers of the lines and the selections of the menus: the limit the warehouse and the loyalty effects read. */
export const MAX_SALE_ENTRIES = 500;

/** Most results of a search of the store. */
export const STORE_SALES_MAX_LIMIT = 10;

/** What a product object of a line may be: the limits of the one place that takes unknown fields (decision 12 of step VS4). */
export const PRODUCT_OBJECT_LIMITS = Object.freeze({
  /** Deepest nesting of the object, itself included (level 1). */
  depth: 6,
  /** Most values (scalars, objects and arrays) in the whole object. */
  nodes: 2000,
  /** Longest text. */
  text: 2000,
  /** Most elements of a list. */
  list: 200,
});

/** A JSON object whose members are anything JSON. It is never stored or passed to the database as it is: the lines reduce it to an allowlist (`sales.lines.ts`). */
export type LooseObject = Readonly<Record<string, unknown>>;

/** Walks an untrusted JSON value, counting what it contains; returns `false` (after reporting) at the first limit it breaks. */
function walk(value: unknown, depth: number, count: { nodes: number }): 'depth' | 'tooMany' | 'type' | 'forbiddenKey' | 'format' | null {
  count.nodes += 1;
  if (count.nodes > PRODUCT_OBJECT_LIMITS.nodes) {
    return 'tooMany';
  }
  if (value === null || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : 'type';
  }
  if (typeof value === 'string') {
    return !value.isWellFormed() ? 'format' : value.length > PRODUCT_OBJECT_LIMITS.text ? 'tooMany' : null;
  }
  if (typeof value !== 'object') {
    return 'type';
  }
  if (depth > PRODUCT_OBJECT_LIMITS.depth) {
    return 'depth';
  }
  const children = Array.isArray(value) ? value : Object.entries(value);
  if (children.length > PRODUCT_OBJECT_LIMITS.list && Array.isArray(value)) {
    return 'tooMany';
  }
  for (const child of children) {
    if (!Array.isArray(value) && isForbiddenKey((child as [string, unknown])[0])) {
      return 'forbiddenKey';
    }
    const problem = walk(Array.isArray(value) ? child : (child as [string, unknown])[1], depth + 1, count);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

/**
 * The product object of a line, of a modifier or of a selection of a menu: the one place that accepts fields it does not know (the clients send the whole product, as they always did). It is bounded: JSON types only, at most
 * {@link PRODUCT_OBJECT_LIMITS} deep, with that many values and texts, and never a key that starts with `$` or has a `.`. Nothing of it reaches the database but what `reduceLine` keeps by its allowlist.
 */
export const looseProduct: Schema<LooseObject, false> = Object.freeze({
  optional: false as const,
  parse: ((value, path, context) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return context.report(path, 'type');
    }
    const problem = walk(value, 1, { nodes: 0 });
    return problem === null ? (value as LooseObject) : context.report(path, problem === 'depth' ? 'tooDeep' : problem);
  }) as Schema<LooseObject, false>['parse'],
});

/** An amount that cannot be negative (the credit of a card used to pay): a negative one would add credit to a card instead of taking it. */
const nonNegativeMoney = number({ min: 0, max: 1_000_000_000 });
const text = (max: number) => string({ min: 1, max, trim: true });
/** An amount in currency units (decimal, as the point of sale computes it). */
const money = number({ min: -1_000_000_000, max: 1_000_000_000 });
const fiscalCounter = integer({ min: 0, max: 1_000_000_000 });
const timestampId = string({ min: 1, max: 64, pattern: /^[A-Za-z0-9._:-]+$/ });
const positive = refine(number({ min: 0, max: 1_000_000_000 }), (value) => (value > 0 ? [] : ['']), 'minimum');

/** The fiscal receipt of a sale or of a refund: its date, the number of the daily report, the number of the receipt and its amount. */
const fiscalReceiptInfo = object({
  date: optional(nullable(isoDate())),
  report: optional(nullable(fiscalCounter)),
  number: optional(nullable(fiscalCounter)),
  amount: optional(nullable(money)),
});

/** What is paid, by kind; every amount is optional (`0` when absent). */
const payments = object({
  cash: optional(money),
  electronic: optional(money),
  cheque: optional(money),
  tickets: optional(money),
  fidelityCredit: optional(nonNegativeMoney),
  unpaid: optional(money),
  paymentTypeId: optional(nullable(text(64))),
  posTerminalId: optional(nullable(text(64))),
  specific: optional(array(object({ type: optional(text(64)), name: optional(text(200)), amount: optional(money) }), { max: 20 })),
  ticketDetails: optional(array(object({ name: optional(text(200)), amount: optional(money), quantity: optional(number({ min: 0, max: 1_000_000 })) }), { max: 50 })),
});

/** The contact of the customer: the server builds the copy from the database. */
const customerRef = object({ contactId: objectId() });

const operatorId = optional(nullable(objectId()));

/** The types of electronic document a sale of type `invoice` may ask for: the invoice, its notes (debit, credit), the parcel, the deferred invoice (`TD24`, which gathers unpaid sales) and the other types the till uses (step VS5). */
export const INVOICE_TYPES = ['TD01', 'TD02', 'TD03', 'TD06', 'TD24', 'TD25', 'TD26'] as const;

/** Most unpaid sales a deferred invoice may gather. */
export const MAX_UNPAID_SALES = 500;

/**
 * What the till says of the invoice a sale of type `invoice` creates (step VS5): the type of document (`TD24` is assumed when the sale gathers unpaid ones, `TD01` otherwise) and the partial FatturaPA object it already builds (`xml`: bounded, with fields the
 * server does not know; only the sections the electronic invoice reads are kept, by allowlist: `sales.invoice.ts`).
 */
const invoiceOptions = object({ type: optional(enumOf(INVOICE_TYPES)), xml: optional(nullable(looseProduct)) });

/** How many entries (lines, modifiers and selections of the menus) a validated body has. */
function entriesOf(products: readonly LooseObject[]): number {
  const list = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  return products.reduce((sum, product) => {
    const variants = typeof product['selectedVariants'] === 'object' && product['selectedVariants'] !== null ? (product['selectedVariants'] as LooseObject) : {};
    const bundle = typeof product['modularBundleSelected'] === 'object' && product['modularBundleSelected'] !== null ? (product['modularBundleSelected'] as LooseObject) : {};
    return sum + 1 + list(variants['plus']) + list(variants['minus']) + list(variants['info']) + list(bundle['products']);
  }, 0);
}

/** The fields of the creation of a sale that the point of sale and the backoffice share (the identity of the writer and the key of the sale are theirs to add). */
const saleFields = {
  date: isoDate(),
  receiptType: enumOf(['receipt', 'invoice', 'charge', 'partitioned'] as const),
  nonFiscal: optional(boolean()),
  cashDesk: optional(nullable(object({ deviceId: optional(text(64)), name: optional(text(200)), serialNumber: optional(text(64)), driver: optional(text(64)) }))),
  customer: optional(nullable(customerRef)),
  fidelityCardCode: optional(nullable(text(64))),
  lotteryCode: optional(nullable(text(32))),
  products: array(looseProduct, { min: 1, max: MAX_SALE_ENTRIES }),
  totals: object({
    taxable: money,
    tax: money,
    total: money,
    taxableBeforeDiscount: optional(money),
    totalBeforeDiscount: optional(money),
    discount: optional(nullable(object({ adjustment: optional(nullable(enumOf(['discount', 'surcharge'] as const))), kind: optional(nullable(text(32))), percentage: optional(money), value: optional(money) }))),
  }),
  payments,
  fiscalReceiptInfo: optional(nullable(fiscalReceiptInfo)),
  table: optional(nullable(object({ tableId: optional(text(64)), roomId: optional(text(64)), name: optional(text(200)), startDate: optional(nullable(isoDate())), covers: optional(integer({ min: 0, max: 10_000 })), partition: optional(nullable(text(64))) }))),
  delivery: optional(nullable(object({ type: optional(text(64)), date: optional(nullable(isoDate())), sentAt: optional(nullable(isoDate())) }))),
  reservation: optional(nullable(object({ date: optional(nullable(isoDate())) }))),
  appointment: optional(nullable(object({ appointmentId: objectId(), customerId: optional(nullable(objectId())), services: optional(array(object({ serviceId: objectId(), staffId: optional(nullable(objectId())) }), { max: 50 })) }))),
  hotel: optional(nullable(object({ roomId: optional(nullable(text(64))), roomName: optional(nullable(text(200))) }))),
  fullMeal: optional(nullable(object({ status: optional(text(64)), quantity: optional(number({ min: 0, max: 1_000_000 })) }))),
  note: optional(nullable(string({ max: 2000, trim: true }))),
  checkoutStartedAt: optional(nullable(isoDate())),
  invoice: optional(nullable(invoiceOptions)),
  unpaidSaleIds: optional(array(objectId(), { max: MAX_UNPAID_SALES })),
  deliveryIds: optional(array(objectId(), { max: 100 })),
};

/**
 * The rules between the fields of a sale: the entries (lines, modifiers and selections) are at most {@link MAX_SALE_ENTRIES}; the options of the invoice and the unpaid sales it gathers belong to a sale of type `invoice`; the delivery notes an invoice gathers
 * (`deliveryIds`) come with the module of the documents and are refused until then, never silently dropped.
 */
export function withSaleRules<T extends { readonly products: readonly LooseObject[]; readonly receiptType: string; readonly unpaidSaleIds?: readonly unknown[] | undefined; readonly deliveryIds?: readonly unknown[] | undefined; readonly invoice?: unknown }>(schema: Schema<T, false>): Schema<T, false> {
  return refine(
    refine(
      refine(schema, (body) => (entriesOf(body.products) > MAX_SALE_ENTRIES ? ['products'] : []), 'tooMany'),
      (body) => (body.receiptType !== 'invoice' ? [...((body.unpaidSaleIds ?? []).length > 0 ? ['unpaidSaleIds'] : []), ...(body.invoice === undefined || body.invoice === null ? [] : ['invoice'])] : []),
      'incorrect',
    ),
    (body) => ((body.deliveryIds ?? []).length > 0 ? ['deliveryIds'] : []),
    'notAllowed',
  );
}

/**
 * The body of the creation of a sale, in domain names. Every property is by allowlist (an unknown one is `422 unknown`), except the product objects of the lines, which take unknown fields and are reduced later. Nothing here is refused
 * for a business rule: only the shape, the types and the limits.
 */
export const createSaleBody = withSaleRules(object({ timestampId, operatorId, ...saleFields }));

/**
 * The body of the creation of a sale from the backoffice (step VS4b): the same, with the company and the point of sale the sale belongs to (the server verifies them in the group and in the perimeter of the user), no operator (it is the
 * user who writes) and a `timestampId` the server makes up when it is missing. The parent bill of a split table (`partitioned`) is the till's alone: here it is `422`.
 */
export const adminCreateSaleBody = withSaleRules(object({ timestampId: optional(timestampId), companyId: objectId(), placeId: objectId(), ...saleFields, receiptType: enumOf(['receipt', 'invoice', 'charge'] as const) }));

/** The validated body of the creation of a sale from the backoffice. */
export type AdminCreateSaleBody = Infer<typeof adminCreateSaleBody>;

/** The validated body of the creation of a sale. */
export type CreateSaleBody = Infer<typeof createSaleBody>;

/**
 * The body of the amendment of a sale: a merge patch of the payments (an amount that is not sent stays), the customer, the loyalty card, the fiscal receipt, the lottery code and the operator. The lines and the totals never change
 * (only a refund or a cancellation does it). At least one property is needed.
 */
export const patchSaleBody = refine(
  object({
    operatorId,
    payments: optional(payments),
    customer: optional(nullable(customerRef)),
    fidelityCardCode: optional(nullable(text(64))),
    fiscalReceiptInfo: optional(nullable(fiscalReceiptInfo)),
    lotteryCode: optional(nullable(text(32))),
  }),
  (body) => (Object.keys(body).length === 0 ? [''] : []),
  'required',
);

/** The validated body of the amendment of a sale. */
export type PatchSaleBody = Infer<typeof patchSaleBody>;

/** The body of a refund of a sale, whole or partial: what was returned (the position of the line, as saved, and the quantity), its value and its fiscal receipt. Repeatable: every refund has its own `timestampId`. */
export const refundSaleBody = object({
  timestampId,
  date: isoDate(),
  operatorId,
  products: array(object({ index: integer({ min: 0, max: MAX_SALE_ENTRIES - 1 }), productId: optional(objectId()), quantity: positive }), { min: 1, max: MAX_SALE_ENTRIES }),
  value: optional(nullable(object({ taxable: money, tax: money, total: money }))),
  fiscalReceiptInfo: optional(nullable(fiscalReceiptInfo)),
});

/** The validated body of a refund. */
export type RefundSaleBody = Infer<typeof refundSaleBody>;

/** The body of the cancellation of a sale. */
export const cancelSaleBody = object({ date: isoDate(), operatorId, fiscalReceiptInfo: optional(nullable(fiscalReceiptInfo)) });

/** The validated body of a cancellation. */
export type CancelSaleBody = Infer<typeof cancelSaleBody>;

/** The path parameters of a sale. */
export const saleIdParams = object({ saleId: objectId() });

/** The validated path parameters of a sale. */
export type SaleIdParams = Infer<typeof saleIdParams>;

/**
 * The search of the sales of the point of sale of a store: by the `timestampId` of the sale, by the numbers of its fiscal receipt (the receipt and the daily report, and the serial number of the printer when the numbers repeat) or by the
 * customer (the last purchases). Exactly one of the three searches is asked.
 */
export const storeSalesQuery = refine(
  object({
    timestampId: optional(timestampId),
    receiptNumber: optional(integerString({ min: 0, max: 1_000_000_000 })),
    reportNumber: optional(integerString({ min: 0, max: 1_000_000_000 })),
    serialNumber: optional(text(64)),
    contactId: optional(objectId()),
    limit: optional(integerString({ min: 1, max: STORE_SALES_MAX_LIMIT })),
  }),
  (query) => {
    const searches = [query.timestampId !== undefined, query.receiptNumber !== undefined || query.reportNumber !== undefined, query.contactId !== undefined].filter(Boolean).length;
    const dangling = query.serialNumber !== undefined && query.receiptNumber === undefined && query.reportNumber === undefined;
    return searches === 1 ? (dangling ? ['serialNumber'] : []) : [''];
  },
  'incorrect',
);

/** The validated search of the sales of a store. */
export type StoreSalesQuery = Infer<typeof storeSalesQuery>;

/** The body of the amendment of a sale from the backoffice: as the one of the store, with no operator (it is the user). */
export const adminPatchSaleBody = refine(
  object({
    payments: optional(payments),
    customer: optional(nullable(customerRef)),
    fidelityCardCode: optional(nullable(text(64))),
    fiscalReceiptInfo: optional(nullable(fiscalReceiptInfo)),
    lotteryCode: optional(nullable(text(32))),
  }),
  (body) => (Object.keys(body).length === 0 ? [''] : []),
  'required',
);

/** The body of a refund from the backoffice: as the one of the store, with no operator (it is the user). */
export const adminRefundSaleBody = object({
  timestampId,
  date: isoDate(),
  products: array(object({ index: integer({ min: 0, max: MAX_SALE_ENTRIES - 1 }), productId: optional(objectId()), quantity: positive }), { min: 1, max: MAX_SALE_ENTRIES }),
  value: optional(nullable(object({ taxable: money, tax: money, total: money }))),
  fiscalReceiptInfo: optional(nullable(fiscalReceiptInfo)),
});

/** The body of a cancellation from the backoffice: as the one of the store, with no operator (it is the user). */
export const adminCancelSaleBody = object({ date: isoDate(), fiscalReceiptInfo: optional(nullable(fiscalReceiptInfo)) });
