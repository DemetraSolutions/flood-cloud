import type { Document } from 'mongodb';
import { integerOf, isRecord, recordsOf, textOf } from '../groups/catalogs/kit.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';
import { numberValue, plainOf } from '../product-categories/categories.mapper.ts';
import { taxCopyOf } from '../product-departments/product-departments.mapper.ts';

/** The tax rate a price carries, as the price holds it (a copy of the rate of the group at the time it was chosen), read tolerantly. */
export interface PriceTax {
  /** The percentage; `null` when it is not a number. */
  readonly rate: number | null;
  /** The number of the fiscal department of the tax rate: the POS matches the department of the cash register with it. */
  readonly department: number | null;
  readonly description: string | null;
  /** The code of the VAT nature, `null` for none. */
  readonly vatNature: string | null;
}

/** A price of a product (a rule of a price list), in the domain form. Amounts are decimal units of currency, never cents. */
export interface PriceView {
  /** Id of the rule (made by the server for a new one), `null` for a rule the legacy wrote without one. */
  readonly id: string | null;
  /** Id of the price list of the group; a list that no longer exists is shown by its id. */
  readonly priceListId: string | null;
  /** Currency code. */
  readonly currency: string | null;
  /** Id of the tax rate of the group the copy comes from. */
  readonly taxId: string | null;
  /** The copy of the tax rate the price holds; `null` when the stored value is not an object. Read only: it follows the rate of the group (it is realigned when that changes). */
  readonly tax: PriceTax | null;
  /** The price without tax. */
  readonly net: number | null;
  /** The price with tax, the one the cash register leads with. */
  readonly gross: number | null;
  /** The discount, in percent. */
  readonly discount: number | null;
  /** Start of the validity (an instant), `null` for none. */
  readonly validFrom: string | null;
  /** End of the validity (an instant), `null` for none. */
  readonly validTo: string | null;
  /** Start of the daily time window, `HH:mm`, `null` for none. */
  readonly dailyFrom: string | null;
  /** End of the daily time window, `HH:mm`, `null` for none. */
  readonly dailyTo: string | null;
  /** The days of the week the price is valid on, 0 (Sunday) to 6; empty for every day. */
  readonly weekDays: readonly number[];
  /** The smallest quantity the price applies from (tiered prices). */
  readonly fromQuantity: number | null;
  /** The largest quantity that can be sold at this price. */
  readonly maxSaleQuantity: number | null;
}

/** The instant a stored date holds, as an ISO 8601 string: a `Date` (the products' own dates) or a text the legacy backoffice wrote (`prices[].startDate` is mixed in the real data); `null` for anything else. */
export function instantOf(raw: unknown): string | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  }
  if (typeof raw === 'string' && raw !== '') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The time of day (`HH:mm`) a stored text holds, `null` for anything else. */
const timeOf = (raw: unknown): string | null => (typeof raw === 'string' && TIME.test(raw) ? raw : null);

/**
 * Reads a stored price tolerantly: `NaN`, a text where a number is expected and a missing key give `null`, a date is read in both forms, the days of the week keep the integers from 0 to 6, and nothing throws.
 *
 * @param raw One element of the stored `prices`.
 */
export function priceView(raw: Document): PriceView {
  const data: unknown = raw['taxData'];
  const days: unknown = raw['weekDays'];
  return {
    id: textOf(raw['id']),
    priceListId: textOf(raw['listId']),
    currency: textOf(raw['currency']),
    taxId: isRecord(data) ? textOf(data['id']) : null,
    tax: isRecord(data) ? { rate: numberValue(data['value']), department: integerOf(plainOf(data['department'])), description: textOf(data['description']), vatNature: textOf(data['natura']) } : null,
    net: numberValue(raw['price']),
    gross: numberValue(raw['taxed']),
    discount: numberValue(raw['discount']),
    validFrom: instantOf(raw['startDate']),
    validTo: instantOf(raw['endDate']),
    dailyFrom: timeOf(raw['startTimeDaily']),
    dailyTo: timeOf(raw['endTimeDaily']),
    weekDays: (Array.isArray(days) ? (days as unknown[]) : []).map(plainOf).filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6),
    fromQuantity: numberValue(raw['fromQt']),
    maxSaleQuantity: numberValue(raw['maxQtSell']),
  };
}

/** The prices of a stored document, in their order (the POS changes one by its index). */
export function pricesOf(raw: unknown): PriceView[] {
  return recordsOf(raw).map(priceView);
}

/** A price as the body of a write sends it. */
export interface PriceInput {
  readonly id?: string | null | undefined;
  readonly priceListId: string;
  readonly currency: string;
  readonly taxId: string;
  readonly gross?: number | undefined;
  readonly net?: number | undefined;
  readonly discount?: number | undefined;
  readonly validFrom?: string | null | undefined;
  readonly validTo?: string | null | undefined;
  readonly dailyFrom?: string | null | undefined;
  readonly dailyTo?: string | null | undefined;
  readonly weekDays?: readonly number[] | undefined;
  readonly fromQuantity?: number | null | undefined;
  readonly maxSaleQuantity?: number | null | undefined;
}

/** A number rounded to a number of decimals (never `NaN`: the amounts are finite and bounded by the schema). */
function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * The net price of a gross one: `gross / (1 + rate / 100)`, to eight decimals, the way the legacy backoffice and the import compute it.
 *
 * @param gross The price with tax.
 * @param rate The tax rate, in percent.
 */
export function netOf(gross: number, rate: number): number {
  return round(gross / (1 + rate / 100), 8);
}

/**
 * The gross price of a net one: `net * (1 + rate / 100)`, to two decimals (the form of the legacy backoffice).
 *
 * @param net The price without tax.
 * @param rate The tax rate, in percent.
 */
export function grossOf(net: number, rate: number): number {
  return round(net * (1 + rate / 100), 2);
}

/**
 * The rate of a stored price copy as a number, for the price shown in a list: `tax`, else the `value` of the copy.
 *
 * @param raw One element of the stored `prices`.
 */
function rateOf(raw: Document): number | null {
  const data: unknown = raw['taxData'];
  return numberValue(raw['tax']) ?? (isRecord(data) ? numberValue(data['value']) : null);
}

/**
 * The price a list shows for a product: the rule of the default price list with a minimum quantity of 1 and no dates (the rule the legacy backoffice picks), as `price * (1 + tax / 100)` minus the discount,
 * to two decimals; the gross price of the rule when the net one or the rate is not a number; `null` when there is no such rule.
 *
 * @param prices The stored `prices`.
 * @param priceListId Id of the default price list of the group.
 */
export function listedPrice(prices: unknown, priceListId: string | null): number | null {
  if (priceListId === null) {
    return null;
  }
  const rule = recordsOf(prices).find((price) => textOf(price['listId']) === priceListId && numberValue(price['fromQt']) === 1 && instantOf(price['startDate']) === null && instantOf(price['endDate']) === null);
  if (rule === undefined) {
    return null;
  }
  const net = numberValue(rule['price']);
  const rate = rateOf(rule);
  const amount = net !== null && rate !== null ? net * (1 + rate / 100) : numberValue(rule['taxed']);
  return amount === null ? null : round(amount * (1 - (numberValue(rule['discount']) ?? 0) / 100), 2);
}

/**
 * Builds the stored element of a price: the keys the legacy writes, with the tax rate copied from the group (`tax` and `taxData`, always written by the server) and the other amount computed. The gross price wins when
 * both are given (it is the one the cash register leads with); keys of the stored element this backend does not know stay.
 *
 * @param input The price of the request.
 * @param tax The tax rate of the group the price names.
 * @param id The id of the rule.
 * @param stored The stored element of the same rule, when there is one.
 */
export function priceDocument(input: PriceInput, tax: Tax, id: string, stored: Document | undefined): Document {
  const gross = input.gross ?? grossOf(input.net!, tax.rate);
  const net = input.gross === undefined ? input.net! : netOf(input.gross, tax.rate);
  const data: unknown = stored?.['taxData'];
  return {
    ...stored,
    id,
    listId: input.priceListId,
    price: net,
    taxed: gross,
    tax: tax.rate,
    taxData: { ...(isRecord(data) ? data : {}), ...taxCopyOf(tax) },
    discount: input.discount ?? 0,
    currency: input.currency,
    startDate: input.validFrom ?? null,
    endDate: input.validTo ?? null,
    startTimeDaily: input.dailyFrom ?? null,
    endTimeDaily: input.dailyTo ?? null,
    weekDays: [...(input.weekDays ?? [])],
    fromQt: input.fromQuantity === undefined ? 1 : input.fromQuantity,
    maxQtSell: input.maxSaleQuantity ?? null,
  };
}

/**
 * Whether a tax rate can be used to compute a price: a finite percentage above -100 (a rate of -100 or less would divide by zero or flip the sign). Legacy data can hold anything.
 *
 * @param rate The rate, in percent.
 */
export function usableRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > -100;
}
