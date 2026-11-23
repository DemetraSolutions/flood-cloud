import { dateIssue, datesReversed, fromLocalInput, numberIssue, numberOrNull, numberText, toLocalInput } from '../groups/catalogs/catalog-fields';
import { Price, PRODUCT_LIMITS } from './product.types';

/** A rule of the price of a product as the form edits it. */
export interface PriceRow {
  /** Id of the rule (made by the server for a new one), `null` for a new rule. */
  readonly id: string | null;
  readonly priceListId: string;
  readonly currency: string;
  readonly taxId: string;
  /** Price without tax, as typed. */
  readonly net: string;
  /** Price with tax, as typed. */
  readonly gross: string;
  /** Which of the two the user wrote last: that one is sent, the server computes the other. */
  readonly written: 'net' | 'gross';
  /** As typed. */
  readonly discount: string;
  /** `datetime-local` values (`''` for none). */
  readonly validFrom: string;
  readonly validTo: string;
  /** `HH:mm` values (`''` for none). */
  readonly dailyFrom: string;
  readonly dailyTo: string;
  readonly weekDays: readonly number[];
  readonly fromQuantity: string;
  readonly maxSaleQuantity: string;
}

/** The fields of a rule that have an error message. */
export type PriceField =
  | 'priceListId'
  | 'currency'
  | 'taxId'
  | 'net'
  | 'gross'
  | 'discount'
  | 'validFrom'
  | 'validTo'
  | 'dailyFrom'
  | 'dailyTo'
  | 'fromQuantity'
  | 'maxSaleQuantity';

/** The issue of a field of a rule, by the name of the backend. */
export type PriceIssues = Partial<Record<PriceField, string>>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Decimal places of the net price the server stores (it computes it from the gross one). */
const NET_DECIMALS = 8;

/** Decimal places of the gross price. */
const GROSS_DECIMALS = 2;

/** A number as text with at most `digits` decimals and no trailing zeros. */
function trimmed(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/**
 * The gross price of a net one, to two decimals; `''` when either is not a number.
 *
 * @param net The net price as typed.
 * @param rate Percentage of the tax rate, `null` when unknown.
 */
export function grossFromNet(net: string, rate: number | null): string {
  const value = net.trim() === '' ? Number.NaN : Number(net);
  return Number.isFinite(value) && rate !== null ? (value * (1 + rate / 100)).toFixed(GROSS_DECIMALS) : '';
}

/**
 * The net price of a gross one, to eight decimals (what the server stores); `''` when either is
 * not a number.
 *
 * @param gross The gross price as typed.
 * @param rate Percentage of the tax rate, `null` when unknown.
 */
export function netFromGross(gross: string, rate: number | null): string {
  const value = gross.trim() === '' ? Number.NaN : Number(gross);
  return Number.isFinite(value) && rate !== null ? trimmed(value / (1 + rate / 100), NET_DECIMALS) : '';
}

/**
 * The rule with a price the user wrote: the other price follows (the net one is shown to eight
 * decimals, the gross one to two) and the written one is the one that will be sent.
 *
 * @param row The rule.
 * @param field The price that was written.
 * @param text What the user typed.
 * @param rate Percentage of the tax rate of the rule, `null` when unknown.
 */
export function withWrittenPrice(row: PriceRow, field: 'net' | 'gross', text: string, rate: number | null): PriceRow {
  return field === 'net'
    ? { ...row, net: text, gross: grossFromNet(text, rate), written: 'net' }
    : { ...row, gross: text, net: netFromGross(text, rate), written: 'gross' };
}

/** The rule with another tax rate: the price that was not written follows the one that was. */
export function withTaxRate(row: PriceRow, taxId: string, rate: number | null): PriceRow {
  return row.written === 'net'
    ? { ...row, taxId, gross: rate === null ? row.gross : grossFromNet(row.net, rate) }
    : { ...row, taxId, net: rate === null ? row.net : netFromGross(row.gross, rate) };
}

/** The form row of a price of the server. */
export function priceRowOf(price: Price): PriceRow {
  return {
    id: price.id,
    priceListId: price.priceListId ?? '',
    currency: price.currency ?? '',
    taxId: price.taxId ?? '',
    net: numberText(price.net),
    gross: numberText(price.gross),
    written: 'net',
    discount: numberText(price.discount ?? 0),
    validFrom: toLocalInput(price.validFrom),
    validTo: toLocalInput(price.validTo),
    dailyFrom: price.dailyFrom ?? '',
    dailyTo: price.dailyTo ?? '',
    weekDays: [...price.weekDays],
    fromQuantity: numberText(price.fromQuantity),
    maxSaleQuantity: numberText(price.maxSaleQuantity),
  };
}

/**
 * A new rule, as the legacy form made one for every price list of a new product: price 0 and the
 * first tax rate.
 *
 * @param priceListId The price list.
 * @param currency The currency.
 * @param taxId The tax rate.
 * @param rate Percentage of the tax rate, `null` when unknown.
 */
export function newPriceRow(priceListId: string, currency: string, taxId: string, rate: number | null): PriceRow {
  return {
    id: null,
    priceListId,
    currency,
    taxId,
    net: '0',
    gross: grossFromNet('0', rate),
    written: 'net',
    discount: '0',
    validFrom: '',
    validTo: '',
    dailyFrom: '',
    dailyTo: '',
    weekDays: [],
    fromQuantity: '1',
    maxSaleQuantity: '',
  };
}

/** The issues of a rule, as the server would find them (the names are the ones of the backend). */
export function priceIssues(row: PriceRow): PriceIssues {
  const issues: Record<string, string | undefined> = {
    priceListId: row.priceListId === '' ? 'required' : undefined,
    currency: row.currency === '' ? 'required' : undefined,
    taxId: row.taxId === '' ? 'required' : undefined,
    net: numberIssue(row.net, { min: 0, max: PRODUCT_LIMITS.number, optional: row.gross.trim() !== '' }),
    gross: numberIssue(row.gross, { min: 0, max: PRODUCT_LIMITS.number, optional: true }),
    discount: numberIssue(row.discount, { min: 0, max: PRODUCT_LIMITS.percentage, optional: true }),
    validFrom: dateIssue(row.validFrom),
    validTo: dateIssue(row.validTo) ?? (datesReversed(row.validFrom, row.validTo) ? 'incorrect' : undefined),
    dailyFrom: row.dailyFrom !== '' && !TIME.test(row.dailyFrom) ? 'format' : undefined,
    dailyTo: row.dailyTo !== '' && !TIME.test(row.dailyTo) ? 'format' : undefined,
    fromQuantity: numberIssue(row.fromQuantity, { min: 0, max: PRODUCT_LIMITS.number, optional: true }),
    maxSaleQuantity: numberIssue(row.maxSaleQuantity, { min: 0, max: PRODUCT_LIMITS.number, optional: true }),
  };
  return Object.fromEntries(Object.entries(issues).filter(([, issue]) => issue !== undefined)) as PriceIssues;
}

/** The body of a rule: the price the user wrote last (the other one when it is empty), the rest as it is. */
export function priceBody(row: PriceRow): Record<string, unknown> {
  const sendGross = row.written === 'gross' ? row.gross.trim() !== '' : row.net.trim() === '';
  return {
    ...(row.id === null ? {} : { id: row.id }),
    priceListId: row.priceListId,
    currency: row.currency,
    taxId: row.taxId,
    ...(sendGross ? { gross: Number(row.gross) } : { net: Number(row.net) }),
    discount: row.discount.trim() === '' ? 0 : Number(row.discount),
    validFrom: fromLocalInput(row.validFrom),
    validTo: fromLocalInput(row.validTo),
    dailyFrom: row.dailyFrom === '' ? null : row.dailyFrom,
    dailyTo: row.dailyTo === '' ? null : row.dailyTo,
    weekDays: [...row.weekDays].sort((a, b) => a - b),
    fromQuantity: numberOrNull(row.fromQuantity),
    maxSaleQuantity: numberOrNull(row.maxSaleQuantity),
  };
}

/** The amounts a rule shows read only: the gross and net prices, before and after the discount. */
export interface PriceSummary {
  readonly gross: number | null;
  readonly net: number | null;
  readonly discountedGross: number | null;
  readonly discountedNet: number | null;
}

/** A number from a field, `null` when it is empty or not a number. */
function amountOf(text: string): number | null {
  const value = text.trim() === '' ? Number.NaN : Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The summary of a rule: the amounts and the same after the discount. */
export function priceSummary(row: PriceRow): PriceSummary {
  const gross = amountOf(row.gross);
  const net = amountOf(row.net);
  const discount = amountOf(row.discount) ?? 0;
  const factor = 1 - discount / 100;
  return {
    gross,
    net,
    discountedGross: gross === null ? null : gross * factor,
    discountedNet: net === null ? null : net * factor,
  };
}

/** A price as text with two decimals (`''` for none). */
export function moneyText(value: number | null): string {
  return value === null ? '' : value.toFixed(2);
}
