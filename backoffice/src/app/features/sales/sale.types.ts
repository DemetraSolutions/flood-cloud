/** Types, routes and request parameters of the sales read-only pages (`GET …/sales`, `doc/API.md` step V1). */

/** The kinds of receipt the server tells apart (any other value reaches the interface as `null`). */
export const RECEIPT_TYPES = ['receipt', 'invoice', 'charge'] as const;

/** Kind of a receipt. */
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** Fiscal state of a sale that is not simply sold. */
export type FiscalState = 'canceled' | 'refunded';

/** The report (closure) and the number of a fiscal receipt; either may be missing in old data. */
export interface ReceiptNumber {
  readonly report: number | string | null;
  readonly number: number | string | null;
}

/** A refund of the detail: the numbers of its receipt, its date and the amount returned. */
export interface SaleRefund extends ReceiptNumber {
  readonly date: string | null;
  readonly amount: number;
  /** The refund was canceled: it does not count in what was returned. */
  readonly canceled: boolean;
}

/** A sale as listed. */
export interface SaleRow {
  readonly id: string;
  readonly date: string | null;
  readonly receiptType: ReceiptType | null;
  /** A "Preventivo": a sale that is not fiscal (only read while the UM mode is on). */
  readonly nonFiscal: boolean;
  readonly number: ReceiptNumber | null;
  readonly fiscalState: FiscalState | null;
  readonly refunds: readonly ReceiptNumber[];
  /** The amount not paid, `0` when the sale is paid. */
  readonly unpaid: number;
  /** The sale is part of a deferred invoice. */
  readonly invoiced: boolean;
  readonly total: number;
  readonly companyId: string | null;
  readonly placeId: string | null;
  readonly cashDesk: string | null;
  readonly operator: { readonly id: string; readonly name: string } | null;
  readonly table: string | null;
  /** The copy of the contact stored in the sale. */
  readonly customer: { readonly id: string; readonly displayName: string } | null;
}

/** A line of the products of a sale. */
export interface SaleProduct {
  readonly productId: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly quantity: number;
  /** The price of one unit, taxes included. */
  readonly unitPrice: number;
  /** The discount of the line, in percent. */
  readonly discount: number;
  readonly variants: string | null;
  /** The position of the line in the sale (what a refund names). */
  readonly index: number;
  /** How much of the line the refunds that were not canceled returned: what can still be returned is `quantity - returned`. */
  readonly returned: number;
}

/** The totals of a sale. */
export interface SaleTotals {
  readonly total: number;
  readonly taxable: number;
  readonly tax: number;
  readonly discount: {
    readonly adjustment: 'discount' | 'surcharge' | null;
    readonly percentage: number;
    readonly value: number;
  };
}

/** How a sale was paid. */
export interface SalePayments {
  readonly cash: number;
  readonly electronic: number;
  readonly cheque: number;
  readonly tickets: number;
  readonly fidelityCredit: number;
  readonly unpaid: number;
}

/** A difference of a total between the point of sale and the server (`field`: `total`, `taxable`, `tax`, `payments`, `totalBeforeDiscount`). */
export interface SaleCheckTotal {
  readonly field: string;
  readonly pos: number | null;
  readonly server: number | null;
}

/** A difference of a line (`pos` and `server` only when the difference is of a number). */
export interface SaleCheckLine {
  readonly index: number;
  readonly code: string;
  readonly pos: number | null;
  readonly server: number | null;
}

/** The check the server made when the sale was written. */
export interface SaleServerCheck {
  readonly checkedAt: string | null;
  readonly status: 'ok' | 'differences' | null;
  readonly totals: readonly SaleCheckTotal[];
  readonly lines: readonly SaleCheckLine[];
  /** The sale has more differences of lines than the ones listed. */
  readonly linesTruncated: boolean;
}

/** An anomaly the server found and went around (never personal data). */
export interface SaleAnomaly {
  readonly at: string | null;
  readonly operation: string | null;
  readonly source: string | null;
  readonly code: string | null;
  readonly productId: string | null;
  readonly collectionId: string | null;
  readonly type: string | null;
  /** The sales a deferred invoice could not gather. */
  readonly ids: readonly string[];
  /** The paths of the fields of the invoice that were out of their domain. */
  readonly fields: readonly string[];
}

/** The invoice of a sale and where it is in the sending. */
export interface SaleInvoice {
  readonly documentId: string | null;
  readonly number: number | null;
  readonly prefixSuffix: string | null;
  readonly year: number | null;
  /** The state of sending of the document; `null` when it is not sent from here or the document is missing. */
  readonly sendStatus: string | null;
  /** The invoice goes through a hub and is not in the send queue yet. */
  readonly notQueued: boolean;
  /** `false` when the document does not exist any more (a reference left over). */
  readonly documentFound: boolean;
}

/**
 * The invoice goes through a hub and its sending did not start: the server says it, or the state
 * of the document does.
 *
 * @param invoice The invoice of the sale, `null` for none.
 */
export function invoiceNotQueued(invoice: SaleInvoice | null): boolean {
  return invoice !== null && (invoice.notQueued || invoice.sendStatus === 'notQueued');
}

/** An operation the backend made on the sale (never who made it). */
export interface SaleOperation {
  readonly kind: string | null;
  readonly at: string | null;
}

/** A sale as read by its own page. */
export interface SaleDetail extends SaleRow {
  readonly refunds: readonly SaleRefund[];
  readonly products: readonly SaleProduct[];
  /** How many lines the sale has (the list shows at most 500). */
  readonly productsCount: number;
  readonly totals: SaleTotals;
  readonly payments: SalePayments;
  readonly fiscalReceiptInfo: {
    readonly date: string | null;
    readonly report: number | string | null;
    readonly number: number | string | null;
    readonly amount: number;
  } | null;
  /** The code of the card; `null` for whoever cannot read the cards (see `fidelityCardUsed`). */
  readonly fidelityCardCode: string | null;
  /** A fidelity card was used in the sale. */
  readonly fidelityCardUsed: boolean;
  readonly note: string | null;
  /** The sale was canceled. */
  readonly canceled: boolean;
  /** What the refunds that were not canceled returned, taxes included. */
  readonly returnedValue: number;
  /** The check of the server; `null` for a sale of the legacy or without a check. */
  readonly serverCheck: SaleServerCheck | null;
  readonly anomalies: readonly SaleAnomaly[];
  /** The invoice of the sale; `null` when it has none. */
  readonly invoice: SaleInvoice | null;
  readonly operations: readonly SaleOperation[];
  /** The version of the sale: the `If-Match` of the writes, in quotes. */
  readonly version: string;
}

/** The totals of the sales that pass the filters (`GET …/sales/summary`), already net of the refunds. */
export interface SaleSummary {
  readonly total: number;
  readonly count: number;
  readonly average: number;
  readonly refunded: number;
}

/** The filters of the sales read by the page of a contact. */
export interface SaleFilter {
  readonly contactId: string;
  /** Store, `''` for every one. */
  readonly placeId: string;
  /** First day of the period (`YYYY-MM-DD`), `''` when not set. */
  readonly from: string;
  /** Last day of the period, included (`YYYY-MM-DD`), `''` when not set. */
  readonly to: string;
}

/** Route of the page of a sale. */
export function saleRoute(groupId: string, saleId: string): string[] {
  return ['/groups', groupId, 'sales', saleId];
}

/**
 * The numbers of a receipt as `report-number` (the missing one is left out), `''` for none.
 *
 * @param value The numbers, or `null`.
 */
export function receiptLabel(value: ReceiptNumber | null): string {
  if (value === null) {
    return '';
  }
  return [value.report, value.number].filter((part) => part !== null && part !== '').join('-');
}

/** First instant of the local day `YYYY-MM-DD`, shifted by `days`; `null` when it is not a date. */
function dayStart(day: string, days: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
}

/** Earliest instant the period sent when only its end is set (the server wants both bounds). */
const PERIOD_START = '1970-01-01T00:00:00.000Z';

/**
 * The instants of the period the user chose, as the server wants them (`from` included, `to`
 * excluded): the start of the first local day and the start of the day after the last one. When
 * only one end is set the other is open (the start of time, or tomorrow), because the server
 * takes the two together. No period when neither is set.
 *
 * @param filter The filters of the page.
 * @param now The current time (tests give it).
 */
export function periodOf(
  filter: Pick<SaleFilter, 'from' | 'to'>,
  now: Date = new Date(),
): { from: string; to: string } | null {
  const first = dayStart(filter.from, 0);
  const last = dayStart(filter.to, 1);
  if (first === null && last === null) {
    return null;
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // A first day after today still gives a period that ends after it starts.
  const open = first !== null && first >= tomorrow ? dayStart(filter.from, 1)! : tomorrow;
  return {
    from: first === null ? PERIOD_START : first.toISOString(),
    to: (last ?? open).toISOString(),
  };
}

/**
 * The query parameters the list and the summary of the sales share: the contact, the store, the
 * period and, while the UM mode is on, `nonFiscal=include`.
 *
 * @param filter The filters of the page.
 * @param nonFiscal Whether the non fiscal sales are asked for.
 * @param now The current time (tests give it).
 */
export function saleParams(
  filter: SaleFilter,
  nonFiscal: boolean,
  now: Date = new Date(),
): Record<string, string> {
  const params: Record<string, string> = { contactId: filter.contactId };
  if (filter.placeId !== '') {
    params['placeId'] = filter.placeId;
  }
  const period = periodOf(filter, now);
  if (period !== null) {
    params['from'] = period.from;
    params['to'] = period.to;
  }
  if (nonFiscal) {
    params['nonFiscal'] = 'include';
  }
  return params;
}

/** Kinds of a badge of a sale in the list and in its page. */
export type SaleBadgeKey =
  | 'INVOICE'
  | 'CHARGE'
  | 'NON_FISCAL'
  | 'UNPAID'
  | 'INVOICED'
  | 'CANCELED'
  | 'REFUNDED';

/** Every kind of badge (the texts `SALES.BADGE.<key>` exist for each). */
export const SALE_BADGE_KEYS: readonly SaleBadgeKey[] = [
  'INVOICE',
  'CHARGE',
  'NON_FISCAL',
  'UNPAID',
  'INVOICED',
  'CANCELED',
  'REFUNDED',
];

/** A badge of a sale: the text key, the tone and the numbers of the refunds that go with it. */
export interface SaleBadge {
  readonly key: SaleBadgeKey;
  readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  /** The numbers of the refund receipts (only for `REFUNDED`). */
  readonly detail: string;
}

/**
 * The badges of a sale: invoice, charge, non fiscal ("Preventivo"), unpaid, invoiced, canceled and
 * refunded (with the numbers of the refunds).
 *
 * @param row The sale.
 */
export function saleBadges(row: Pick<SaleRow, 'receiptType' | 'nonFiscal' | 'unpaid' | 'invoiced' | 'fiscalState' | 'refunds'>): SaleBadge[] {
  const badges: SaleBadge[] = [];
  const add = (key: SaleBadgeKey, tone: SaleBadge['tone'], detail = '') => badges.push({ key, tone, detail });
  if (row.receiptType === 'invoice') {
    add('INVOICE', 'info');
  }
  if (row.receiptType === 'charge') {
    add('CHARGE', 'info');
  }
  if (row.nonFiscal) {
    add('NON_FISCAL', 'neutral');
  }
  if (row.unpaid > 0) {
    add('UNPAID', 'warning');
  }
  if (row.invoiced) {
    add('INVOICED', 'neutral');
  }
  if (row.fiscalState === 'canceled') {
    add('CANCELED', 'danger');
  }
  if (row.fiscalState === 'refunded') {
    add('REFUNDED', 'warning', row.refunds.map(receiptLabel).filter((label) => label !== '').join(', '));
  }
  return badges;
}

/**
 * The text of a badge: a refund names its receipts when it has their numbers.
 *
 * @param t Translation function.
 * @param badge The badge.
 */
export function badgeText(
  t: (key: string, params?: Readonly<Record<string, string | number>>) => string,
  badge: SaleBadge,
): string {
  return badge.detail === ''
    ? t(`SALES.BADGE.${badge.key}`)
    : t(`SALES.BADGE.${badge.key}_NUMBERS`, { numbers: badge.detail });
}
