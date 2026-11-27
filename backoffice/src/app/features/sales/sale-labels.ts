import { formatDate, formatMoney } from '../../core/i18n/format';
import { Language } from '../../core/i18n/language';
import { BadgeTone } from '../../shared/ui/status-badge/status-badge';
import { receiptLabel, ReceiptNumber } from './sale.types';

/** Translation function the label helpers take (the one of `I18nService`). */
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

/**
 * Every table of labels of the page of a sale lives in this file: the codes the server may write
 * in a sale and the dictionary key of their Italian label (`SALES.<GROUP>.<code>`). A code that is
 * not in a table is shown with a generic text that carries the code itself, so a code the server
 * learns before the backoffice does is never lost.
 */

/** The codes of the anomalies of a sale (`floodCloud.anomalies[].code`, `doc/API.md` VS4a and VS5). */
export const ANOMALY_CODES = [
  'operatorUnknown',
  'operatorInactive',
  'customerMissing',
  'customerTrashed',
  'dateInFuture',
  'duplicateDiffers',
  'refundExceedsSold',
  'refundAfterCancel',
  'cancelAfterRefund',
  'amendAfterInvoiced',
  'legacyStateApproximated',
  'legacyCardAfterSale',
  'partitionedLoyalty',
  'invoiceCounterpartMissing',
  'invoiceCompanyMissing',
  'invoiceDateOutOfRange',
  'invoiceTypeWithoutUnpaid',
  'invoiceXmlInvalid',
  'invoiceIbanUnknown',
  'invoiceHubMismatch',
  'invoiceSplitPaymentDenied',
  'unpaidSaleInvalid',
  'unpaidSaleRace',
  'prefixSuffixMissing',
  'timezoneInvalid',
  'productMissing',
  'productTrashed',
  'quantityMissing',
  'priceMissing',
  'invalidQuantity',
  'invalidRatio',
  'cycle',
  'tooDeep',
  'tooManyProducts',
  'noCashStorage',
  'multipleCashStorages',
  'ruleMissing',
  'cardInactive',
  'cardNotFound',
  'cardAmbiguous',
  'cardTypeMissing',
  'cardTypeDisabled',
  'simpleCardNotFound',
  'simpleCardAmbiguous',
  'simpleRuleMissing',
  'negativeBalance',
  'negativePoints',
  'refillNotInCatalog',
  'refillNotCovered',
  'refillMismatch',
] as const;

/** Where an anomaly comes from (`floodCloud.anomalies[].source`). */
export const ANOMALY_SOURCES = ['sale', 'stock', 'loyalty'] as const;

/** The kinds of operation the backend records on a sale. */
export const OPERATION_KINDS = ['create', 'amend', 'refund', 'cancel', 'delete'] as const;

/** The fields of the totals of a check (`serverCheck.totals[].field`). */
export const CHECK_FIELDS = ['total', 'taxable', 'tax', 'payments', 'totalBeforeDiscount'] as const;

/** The differences of a line of a check (`serverCheck.lines[].code`). */
export const CHECK_LINE_CODES = [
  'taxMissing',
  'taxRateDiffers',
  'lineTotalMismatch',
  'productMissing',
  'productTrashed',
  'quantityMissing',
  'priceMissing',
] as const;

/** The states of the sending of an invoice the interface knows; any other one is shown as it is. */
export const SEND_STATUSES = [
  'queued',
  'notQueued',
  'sent',
  'delivered',
  'accepted',
  'rejected',
  'refused',
  'processingError',
  'notDelivered',
  'deliveryImpossible',
  'effectiveDate',
  'error',
  'failed',
] as const;

/** Tone of the badge of each state of sending. */
const SEND_TONES: Readonly<Record<(typeof SEND_STATUSES)[number], BadgeTone>> = {
  queued: 'info',
  notQueued: 'warning',
  sent: 'info',
  delivered: 'success',
  accepted: 'success',
  rejected: 'danger',
  refused: 'danger',
  processingError: 'danger',
  notDelivered: 'danger',
  deliveryImpossible: 'danger',
  effectiveDate: 'success',
  error: 'danger',
  failed: 'danger',
};

function known(list: readonly string[], value: string | null): value is string {
  return value !== null && list.includes(value);
}

/**
 * Label of a code of a table, or the generic text with the code when it is not in the table
 * (`SALES.<group>.UNKNOWN`) or missing (`SALES.<group>.NONE`).
 */
function label(
  t: Translate,
  group: string,
  list: readonly string[],
  value: string | null,
): string {
  if (value === null) {
    return t(`SALES.${group}.NONE`);
  }
  return known(list, value) ? t(`SALES.${group}.${value}`) : t(`SALES.${group}.UNKNOWN`, { code: value });
}

/** Label of an anomaly code. */
export function anomalyLabel(t: Translate, code: string | null): string {
  return label(t, 'ANOMALY_CODE', ANOMALY_CODES, code);
}

/** Label of the source of an anomaly. */
export function anomalySourceLabel(t: Translate, source: string | null): string {
  return label(t, 'ANOMALY_SOURCE', ANOMALY_SOURCES, source);
}

/** Label of the kind of an operation (also the one an anomaly records). */
export function operationLabel(t: Translate, kind: string | null): string {
  return label(t, 'OPERATION', OPERATION_KINDS, kind);
}

/** Label of a field of the totals of a check. */
export function checkFieldLabel(t: Translate, field: string): string {
  return label(t, 'CHECK_FIELD', CHECK_FIELDS, field);
}

/** Label of the difference of a line of a check. */
export function checkLineLabel(t: Translate, code: string): string {
  return label(t, 'CHECK_LINE', CHECK_LINE_CODES, code);
}

/** Label of a state of sending (the state as it is when the interface does not know it). */
export function sendStatusLabel(t: Translate, status: string): string {
  return known(SEND_STATUSES, status) ? t(`SALES.SEND_STATUS.${status}`) : status;
}

/** Tone of the badge of a state of sending (neutral for a state the interface does not know). */
export function sendStatusTone(status: string): BadgeTone {
  return known(SEND_STATUSES, status) ? SEND_TONES[status as (typeof SEND_STATUSES)[number]] : 'neutral';
}

/**
 * Text of a `409` of a write of a sale: the label of the first detail the interface knows
 * (`field/issue`, a position in the field such as `products.0` ignored), or the generic one.
 * Each entry is the dictionary key `SALES.ACTION.CONFLICT.<name>`.
 */
const CONFLICTS: Readonly<Record<string, string>> = {
  'fiscalState/canceled': 'CANCELED',
  'canceled/canceled': 'CANCELED',
  'products/refundExceeds': 'REFUND_EXCEEDS',
  'status/invoiced': 'INVOICED',
  'nonFiscal/fiscal': 'FISCAL',
  'refund/refundsLimit': 'REFUNDS_LIMIT',
  'timestampId/deleted': 'DELETED',
  'payments/refillNotCovered': 'REFILL_NOT_COVERED',
};

/**
 * Dictionary key of the text of a `409` of a write of a sale.
 *
 * @param details The `details` of the error (`field` and `issue`).
 */
export function conflictKey(details: readonly { field: string; issue: string }[]): string {
  for (const { field, issue } of details) {
    const name = CONFLICTS[`${field.replace(/\.\d+/g, '')}/${issue}`];
    if (name !== undefined) {
      return `SALES.ACTION.CONFLICT.${name}`;
    }
  }
  return 'SALES.ACTION.CONFLICT.GENERIC';
}

/**
 * The number of a receipt as the interface shows it: `report-number`, or the text "without
 * number" for a receipt that has none. The one place that formats a number for the page, its
 * refunds and the dialogs.
 *
 * @param t Translation function.
 * @param value The numbers, or `null`.
 */
export function receiptNumberText(t: Translate, value: ReceiptNumber | null): string {
  return receiptLabel(value) || t('SALES.NO_NUMBER');
}

/** A date and time as the page shows it (`''` for none). */
export function dateTimeText(language: Language, date: string | null): string {
  return date === null ? '' : formatDate(date, language, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * How the dialogs name a sale: `n. 12-345` or, for a sale without a number, `del <date>` (and
 * `senza numero` when it has no date either).
 *
 * @param t Translation function.
 * @param language Language of the date.
 * @param sale The sale (its number and date).
 */
export function saleReference(
  t: Translate,
  language: Language,
  sale: { readonly number: ReceiptNumber | null; readonly date: string | null },
): string {
  const number = receiptLabel(sale.number);
  if (number !== '') {
    return t('SALES.REFERENCE.NUMBER', { number });
  }
  return sale.date === null
    ? t('SALES.REFERENCE.NONE')
    : t('SALES.REFERENCE.DATE', { date: dateTimeText(language, sale.date) });
}

/** Amount of the sale in the currency, as the page shows it. */
export function moneyText(language: Language, currency: string, value: number): string {
  return formatMoney(Math.round(value * 100), currency, language);
}

/**
 * The line of a dialog that says which sale it is about: date and total.
 *
 * @param t Translation function.
 * @param language Language of the date and the amount.
 * @param currency Currency of the amount.
 * @param sale The sale.
 */
export function saleSummary(
  t: Translate,
  language: Language,
  currency: string,
  sale: { readonly date: string | null; readonly total: number },
): string {
  return t('SALES.ACTION.SUMMARY', {
    date: dateTimeText(language, sale.date),
    total: moneyText(language, currency, sale.total),
  });
}

/**
 * The symbol of a currency in a language (`€`); the code itself when the language has no symbol.
 *
 * @param currency ISO 4217 code.
 * @param language Language of the symbol.
 */
export function currencySymbol(currency: string, language: Language): string {
  const parts = new Intl.NumberFormat(language, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')!.value;
}
