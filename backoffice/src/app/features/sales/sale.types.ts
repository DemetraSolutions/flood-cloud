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
