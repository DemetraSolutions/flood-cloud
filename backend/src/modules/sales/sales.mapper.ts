import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { dateOf } from '../groups/catalogs/kit.ts';
import { clearText, displayNameOf } from '../contacts/contacts.document.ts';

/** Most product lines the detail of a sale shows. */
export const SALE_MAX_LINES = 500;

/** Longest note of a sale shown. */
const MAX_NOTE_LENGTH = 2000;

/** Longest text of a name or of a code of a line shown. */
const MAX_TEXT_LENGTH = 200;

/** The kinds of receipt a sale can have in the table (any other value, `partitioned` included, is shown as unknown). */
const RECEIPT_TYPES: readonly string[] = ['receipt', 'invoice', 'charge'];

/** A number of a fiscal report and of a receipt: the number of the daily closure and the number of the receipt in it. */
export interface FiscalNumber {
  readonly report: number | null;
  readonly number: number | null;
}

/** A refund of a sale as the table shows it: the fiscal numbers of the receipt of the refund. */
export type SaleRefundRow = FiscalNumber;

/** The row of the sales table: what is needed to recognize a sale and nothing of the customer beyond his name. */
export interface SaleRow {
  readonly id: string;
  readonly date: string | null;
  readonly receiptType: 'receipt' | 'invoice' | 'charge' | null;
  /** A sale that is not fiscal (the "Preventivo" of the legacy). */
  readonly nonFiscal: boolean;
  /** The fiscal numbers of the receipt, `null` when the sale has none. */
  readonly number: FiscalNumber | null;
  readonly fiscalState: 'canceled' | 'refunded' | null;
  readonly refunds: readonly SaleRefundRow[];
  /** The amount not paid (an addebito or a credit), `0` when it was paid. */
  readonly unpaid: number;
  /** The sale was included in a deferred invoice. */
  readonly invoiced: boolean;
  /** What the customer paid in the end (`finalTotalCheckout`), `0` when the sale has none. */
  readonly total: number;
  readonly companyId: string | null;
  readonly placeId: string | null;
  readonly cashDesk: string | null;
  readonly operator: { readonly id: string; readonly name: string } | null;
  readonly table: string | null;
  readonly customer: { readonly id: string; readonly displayName: string | null } | null;
}

/** A refund in the detail of a sale: the numbers of its receipt, when it was made and how much it returned. */
export interface SaleRefundDetail extends SaleRefundRow {
  readonly date: string | null;
  readonly amount: number;
}

/** A product line of a sale. */
export interface SaleLine {
  readonly productId: string | null;
  readonly code: string | null;
  /** The name in the language of the user, else the first one the line has. */
  readonly name: string | null;
  readonly quantity: number;
  /** The unit price with tax. */
  readonly unitPrice: number;
  /** The discount of the line, a percentage. */
  readonly discount: number;
  /** The modifiers of the line as text (`+ extra cheese, - onion`), for information. */
  readonly variants: string | null;
}

/** A sale as the detail shows it. */
export interface SaleDetail extends Omit<SaleRow, 'refunds'> {
  readonly refunds: readonly SaleRefundDetail[];
  readonly products: readonly SaleLine[];
  /** How many lines the sale has, the shown ones included (the detail shows at most {@link SALE_MAX_LINES}). */
  readonly productsCount: number;
  readonly totals: {
    readonly total: number;
    readonly taxable: number;
    readonly tax: number;
    /** The discount (or the surcharge) on the whole total. */
    readonly discount: { readonly adjustment: 'discount' | 'surcharge' | null; readonly percentage: number; readonly value: number };
  };
  readonly payments: { readonly cash: number; readonly electronic: number; readonly cheque: number; readonly tickets: number; readonly fidelityCredit: number; readonly unpaid: number };
  readonly fiscalReceiptInfo: { readonly date: string | null; readonly report: number | null; readonly number: number | null; readonly amount: number | null } | null;
  /** The code of the loyalty card used; `null` for a caller without `fidelity:read` (see `fidelityCardUsed`). */
  readonly fidelityCardCode: string | null;
  /** Whether the sale used a loyalty card, shown to everyone. */
  readonly fidelityCardUsed: boolean;
  readonly note: string | null;
}

/** The fields the rows of the table read: never the whole sale. */
export const ROW_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  date: 1,
  receiptType: 1,
  sType: 1,
  'fiscalReceiptInfo.reportNumber': 1,
  'fiscalReceiptInfo.number': 1,
  fiscalState: 1,
  'refund.fiscalReceiptInfo.reportNumber': 1,
  'refund.fiscalReceiptInfo.number': 1,
  unpaid: 1,
  status: 1,
  finalTotalCheckout: 1,
  companyId: 1,
  placeId: 1,
  'device.settings.name': 1,
  userId: 1,
  'table.originalTable.name': 1,
  'customer._id': 1,
  'customer.companyName': 1,
  'customer.name': 1,
  'customer.surname': 1,
});

/** The fields the detail of a sale reads besides the ones of the rows: the lines, the totals, the payments and the fiscal data of the receipt and of the refunds (never the customer's data, the lottery code, the delivery or the terminal). */
export const DETAIL_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  ...ROW_PROJECTION,
  'refund.fiscalReceiptInfo.date': 1,
  'refund.fiscalReceiptInfo.amount': 1,
  'refund.returnedGoodsValue.priceTaxed': 1,
  'products._id': 1,
  'products.code': 1,
  'products.name': 1,
  'products.qt': 1,
  'products.price.taxed': 1,
  'products.price.discount': 1,
  'products.selectedVariants.plus.name': 1,
  'products.selectedVariants.plus.qt': 1,
  'products.selectedVariants.minus.name': 1,
  'products.selectedVariants.minus.qt': 1,
  'products.selectedVariants.info.name': 1,
  'products.selectedVariants.info.qt': 1,
  finalTotalTaxable: 1,
  finalTotalTax: 1,
  adjustmentType: 1,
  discountPercentage: 1,
  discountValue: 1,
  cashAmount: 1,
  electronicAmount: 1,
  chequeAmount: 1,
  ticketsAmount: 1,
  paymentDiscountAmount: 1,
  'fiscalReceiptInfo.date': 1,
  'fiscalReceiptInfo.amount': 1,
  'fidelityCard.code': 1,
  savedCheckoutsNote: 1,
});

/** A plain object, or `null` for anything else (a list, a text, a missing value). */
function objectOf(raw: unknown): Document | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !(raw instanceof ObjectId) && !(raw instanceof Date) ? (raw as Document) : null;
}

/** A finite number; `null` for a text, a `NaN` (the legacy stores one when a value was missing) and anything else. */
function numberOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** An amount: a finite number, `0` for anything else. */
const amountOf = (raw: unknown): number => numberOf(raw) ?? 0;

/** An integer number of a receipt or of a report: a finite whole number, or a text of digits; `null` otherwise. */
function integerOf(raw: unknown): number | null {
  const value = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : numberOf(raw);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

/** The id of a reference as text: an `ObjectId`, or a text of 24 hexadecimal characters (the old documents); `null` otherwise. */
function idOf(raw: unknown): string | null {
  if (raw instanceof ObjectId) {
    return raw.toHexString();
  }
  return typeof raw === 'string' && /^[0-9a-fA-F]{24}$/.test(raw) ? raw.toLowerCase() : null;
}

/** A text of the sale: trimmed, cut to a safe length, `null` when it is missing, empty or not a text. */
function textOf(raw: unknown, max = MAX_TEXT_LENGTH): string | null {
  const text = typeof raw === 'string' ? raw.trim().slice(0, max) : '';
  return text === '' ? null : text;
}

/** The fiscal numbers of a `fiscalReceiptInfo`, `null` when it has none. */
function fiscalNumberOf(raw: unknown): FiscalNumber | null {
  const info = objectOf(raw);
  const report = integerOf(info?.['reportNumber']);
  const number = integerOf(info?.['number']);
  return report === null && number === null ? null : { report, number };
}

/** A name kept by language (`{ it: 'Pizza', en: 'Pizza' }`) in one language: the asked one, else the first text the object has; `null` for anything else. */
function localizedOf(raw: unknown, language: string | null): string | null {
  const names = objectOf(raw);
  if (names === null) {
    return null;
  }
  const preferred = language !== null && Object.hasOwn(names, language) ? textOf(names[language]) : null;
  return preferred ?? Object.values(names).map((value) => textOf(value)).find((text) => text !== null) ?? null;
}

/** A list of stored values: the list, or none when the value is not a list. */
const listOf = (raw: unknown): unknown[] => (Array.isArray(raw) ? (raw as unknown[]) : []);

/** The refunds of a sale: every element that is an object, with its fiscal numbers (`null` when it has none). */
function refundsOf(raw: unknown): Document[] {
  return listOf(raw).map(objectOf).filter((refund): refund is Document => refund !== null);
}

/** The name of a customer as the sale stored it: the company name, else the first name and the surname, in clear (the legacy encrypted texts are never shown). */
function customerOf(raw: unknown): SaleRow['customer'] {
  const customer = objectOf(raw);
  const id = idOf(customer?.['_id']);
  return id === null ? null : { id, displayName: displayNameOf(clearText(customer?.['companyName']), clearText(customer?.['name']), clearText(customer?.['surname'])) };
}

/**
 * A sale of the table. Every field is read tolerantly (the documents are the legacy's, written by the point of sale): a field that is missing or has the wrong type is `null`, `0` or an empty list, and
 * the shapes the legacy dropped (`paymentType`, `cashAmountValue`, `XML`, `returnedGoods`) are never read.
 *
 * @param document The stored sale, read with {@link ROW_PROJECTION}.
 * @param operators The names of the operators of the page, by hexadecimal id.
 */
export function saleRow(document: Document, operators: ReadonlyMap<string, string>): SaleRow {
  const operatorId = idOf(document['userId']);
  const operatorName = operatorId === null ? undefined : operators.get(operatorId);
  const receiptType = RECEIPT_TYPES.find((type) => type === document['receiptType']);
  const fiscalState = document['fiscalState'];
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    date: dateOf(document['date']),
    receiptType: receiptType === undefined ? null : (receiptType as SaleRow['receiptType']),
    nonFiscal: !(document['sType'] === false || document['sType'] === null || document['sType'] === undefined),
    number: fiscalNumberOf(document['fiscalReceiptInfo']),
    fiscalState: fiscalState === 'canceled' || fiscalState === 'refunded' ? fiscalState : null,
    refunds: refundsOf(document['refund']).map((refund) => fiscalNumberOf(refund['fiscalReceiptInfo']) ?? { report: null, number: null }),
    unpaid: amountOf(document['unpaid']),
    invoiced: document['status'] === 'invoiced',
    total: amountOf(document['finalTotalCheckout']),
    companyId: idOf(document['companyId']),
    placeId: idOf(document['placeId']),
    cashDesk: textOf(objectOf(objectOf(document['device'])?.['settings'])?.['name']),
    operator: operatorId === null || operatorName === undefined ? null : { id: operatorId, name: operatorName },
    table: textOf(objectOf(objectOf(document['table'])?.['originalTable'])?.['name']),
    customer: customerOf(document['customer']),
  };
}

/** The ids of the operators of some sales (the users who made them), without repeats. */
export function operatorIdsOf(documents: readonly Document[]): ObjectId[] {
  return [...new Map(documents.flatMap((document) => (document['userId'] instanceof ObjectId ? [[document['userId'].toHexString(), document['userId']] as const] : []))).values()];
}

/** The modifiers of a line as one text: the added ones with `+`, the removed ones with `-`, the others as they are, each with its quantity when it is more than one. */
function variantsOf(raw: unknown, language: string | null): string | null {
  const selected = objectOf(raw);
  const signs: ReadonlyArray<readonly [string, string]> = [['plus', '+ '], ['minus', '- '], ['info', '']];
  const parts = signs.flatMap(([kind, sign]) =>
    listOf(selected?.[kind]).flatMap((entry) => {
      const variant = objectOf(entry);
      const name = localizedOf(variant?.['name'], language);
      const quantity = numberOf(variant?.['qt']);
      return name === null ? [] : [`${sign}${name}${quantity !== null && quantity > 1 ? ` x${String(quantity)}` : ''}`];
    }),
  );
  return parts.length === 0 ? null : parts.join(', ').slice(0, MAX_NOTE_LENGTH);
}

/** A product line of a sale. */
function lineOf(raw: unknown, language: string | null): SaleLine {
  const line = objectOf(raw);
  const price = objectOf(line?.['price']);
  return {
    productId: idOf(line?.['_id']),
    code: textOf(line?.['code']),
    name: localizedOf(line?.['name'], language),
    quantity: amountOf(line?.['qt']),
    unitPrice: amountOf(price?.['taxed']),
    discount: amountOf(price?.['discount']),
    variants: variantsOf(line?.['selectedVariants'], language),
  };
}

/**
 * The detail of a sale. The customer is only the name the row shows, the lottery code, the delivery data, the reservation and the terminal of the payment are never read, and the lines are at most {@link SALE_MAX_LINES}.
 *
 * @param document The stored sale, read with {@link DETAIL_PROJECTION}.
 * @param operators The name of the operator of the sale, by hexadecimal id.
 * @param language The language of the user, for the names of the products; the first one of each name when it has none.
 * @param showCardCode Whether the caller may see the code of the loyalty card (`fidelity:read`).
 */
export function saleDetail(document: Document, operators: ReadonlyMap<string, string>, language: string | null, showCardCode: boolean): SaleDetail {
  const { refunds: _refunds, ...row } = saleRow(document, operators);
  const receipt = objectOf(document['fiscalReceiptInfo']);
  const adjustment = document['adjustmentType'];
  const lines = listOf(document['products']);
  const cardCode = textOf(objectOf(document['fidelityCard'])?.['code']);
  return {
    ...row,
    refunds: refundsOf(document['refund']).map((refund) => {
      const info = objectOf(refund['fiscalReceiptInfo']);
      return { ...(fiscalNumberOf(info) ?? { report: null, number: null }), date: dateOf(info?.['date']), amount: amountOf(objectOf(refund['returnedGoodsValue'])?.['priceTaxed']) };
    }),
    products: lines.slice(0, SALE_MAX_LINES).map((line) => lineOf(line, language)),
    productsCount: lines.length,
    totals: {
      total: row.total,
      taxable: amountOf(document['finalTotalTaxable']),
      tax: amountOf(document['finalTotalTax']),
      discount: { adjustment: adjustment === 'discount' || adjustment === 'surcharge' ? adjustment : null, percentage: amountOf(document['discountPercentage']), value: amountOf(document['discountValue']) },
    },
    payments: {
      cash: amountOf(document['cashAmount']),
      electronic: amountOf(document['electronicAmount']),
      cheque: amountOf(document['chequeAmount']),
      tickets: amountOf(document['ticketsAmount']),
      fidelityCredit: amountOf(document['paymentDiscountAmount']),
      unpaid: row.unpaid,
    },
    fiscalReceiptInfo: receipt === null ? null : { date: dateOf(receipt['date']), report: integerOf(receipt['reportNumber']), number: integerOf(receipt['number']), amount: numberOf(receipt['amount']) },
    fidelityCardCode: showCardCode ? cardCode : null,
    fidelityCardUsed: cardCode !== null,
    note: textOf(document['savedCheckoutsNote'], MAX_NOTE_LENGTH),
  };
}
