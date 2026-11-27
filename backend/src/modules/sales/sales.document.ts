import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { canonicalJson } from '../../shared/http/etag.ts';
import { isRefillCode, round2 } from '../loyalty/loyalty.compute.ts';
import type { SaleFacts } from '../loyalty/loyalty.compute.ts';
import { reduceLine } from './sales.lines.ts';
import type { CatalogProduct, LineIssue } from './sales.lines.ts';
import type { CancelSaleBody, CreateSaleBody, PatchSaleBody, RefundSaleBody } from './sales.write.schemas.ts';

/** Version of the shape of `floodCloud`. */
export const FLOOD_CLOUD_VERSION = 1;

/** Most anomalies and operations a sale keeps (the newest). */
export const MAX_KEPT = 200;

/** How far in the future a sale may be dated before the server says so (the till clocks are not exact). */
export const FUTURE_TOLERANCE_MS = 24 * 3_600_000;

/** An anomaly of a sale: what was found wrong and gone around, never a reason to refuse. */
export interface SaleAnomaly {
  readonly at: Date;
  readonly operation: 'create' | 'amend' | 'refund' | 'cancel' | 'delete';
  readonly source: 'sale' | 'stock' | 'loyalty';
  readonly code: string;
  readonly productId?: string;
  readonly collectionId?: string;
  readonly type?: string;
  /** The ids of the sales a deferred invoice could not gather (`unpaidSaleInvalid`). */
  readonly ids?: readonly string[];
  /** The paths of the fields of the invoice that were out of their domain (`invoiceXmlInvalid`, `invoiceIbanUnknown`, `invoiceSplitPaymentDenied`). */
  readonly fields?: readonly string[];
}

/** Who made a sale or an operation on it, as `floodCloud` keeps it. */
export type SaleActor = { readonly kind: 'store'; readonly storeKeyId: ObjectId } | { readonly kind: 'user'; readonly userId: ObjectId };

/** The hash of a body, to tell a reposting of the same sale from a different one with the same `timestampId`. */
export function bodyHashOf(body: unknown): string {
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(body)))).digest('base64url');
}

/** The key of a sale: the point of sale and the `timestampId` its till gave it. */
export const saleKeyOf = (placeId: ObjectId, timestampId: string): string => `${placeId.toHexString()}|${timestampId}`;

/** The version of a sale (its `ETag` and the value `If-Match` carries): it changes with every write of the new backend and of the legacy. */
export function versionOf(sale: Document): string {
  const cloud = recordOf(sale['floodCloud']);
  const updated = sale['updateDate'];
  return createHash('sha256')
    .update(canonicalJson({ id: (sale['_id'] as ObjectId).toHexString(), updated: updated instanceof Date ? updated.getTime() : null, operations: listOf(cloud['operations']).length, refunds: listOf(sale['refund']).length, state: sale['fiscalState'] ?? '' }))
    .digest('base64url');
}

/** A stored value as a list of objects: the objects of the list, none when it is not a list (a legacy document is read tolerantly). */
export const listOf = (raw: unknown): Document[] => (Array.isArray(raw) ? (raw as unknown[]).filter((item): item is Document => typeof item === 'object' && item !== null && !Array.isArray(item)) : []);

/** A stored value as a plain object: itself, or an empty one when it is anything else (a list, an id, a date, a text, `null`). */
export const recordOf = (raw: unknown): Document => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !(raw instanceof ObjectId) && !(raw instanceof Date) ? (raw as Document) : {});

/** A stored amount: a finite number, `0` for anything else (the legacy stores a `NaN` when a value was missing). */
export const amountOf = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0);

/** A stored text, `null` when it is not a text or is empty. */
export const textOrNull = (raw: unknown): string | null => (typeof raw === 'string' && raw !== '' ? raw : null);

/** A stored number, `null` for anything else. */
export const numberOrNull = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) ? raw : null);

/** A stored id as an `ObjectId`, `null` for anything else (the older documents may hold the text of an id: those are not users of this backend). */
export const objectIdOrNull = (raw: unknown): ObjectId | null => (raw instanceof ObjectId ? raw : null);

/**
 * What the check saved says is wrong with the products of each line (`productMissing`, `productTrashed`, `quantityMissing`), by position, so a new check after an amendment keeps them: they come from the catalog at the time of the sale, which an amendment does not read again.
 *
 * @param check The `serverCheck` saved in the sale (anything when the sale has none).
 * @param count How many lines the sale has.
 */
export function lineIssuesOf(check: unknown, count: number): LineIssue[][] {
  const issues: LineIssue[][] = Array.from({ length: count }, () => []);
  for (const line of listOf(recordOf(check)['lines'])) {
    if (['productMissing', 'productTrashed', 'quantityMissing', 'priceMissing'].includes(line['code'] as string)) {
      issues[line['index'] as number]?.push(line['code'] as LineIssue);
    }
  }
  return issues;
}

const dateOrNull = (raw: Date | null | undefined): Date | null => raw ?? null;

/** The fiscal receipt as the legacy keeps it: the date, the number of the receipt, its amount and the number of the daily report. */
export function fiscalInfoOf(raw: { readonly date?: Date | null; readonly report?: number | null; readonly number?: number | null; readonly amount?: number | null } | null | undefined): Document {
  return { date: dateOrNull(raw?.date), number: raw?.number ?? null, amount: raw?.amount ?? null, reportNumber: raw?.report ?? null };
}

/** The customer of a sale as a copy of the contact in the database, and the kind of customer (`2` for a company, `1` for a person). */
export function customerOf(contact: { readonly copy: Document } | null): { readonly customer: Document | null; readonly customerType: number | null } {
  if (contact === null) {
    return { customer: null, customerType: null };
  }
  const company = typeof contact.copy['companyName'] === 'string' && contact.copy['companyName'].trim() !== '';
  return { customer: { ...contact.copy }, customerType: company ? 2 : 1 };
}

/** The payments of a sale in the names of the legacy, from a (possibly partial) body. */
export function paymentFields(payments: CreateSaleBody['payments'] | NonNullable<PatchSaleBody['payments']>): Document {
  const fields: Document = {};
  const number = (value: number | undefined, name: string): void => {
    if (value !== undefined) {
      fields[name] = value;
    }
  };
  number(payments.cash, 'cashAmount');
  number(payments.electronic, 'electronicAmount');
  number(payments.cheque, 'chequeAmount');
  number(payments.tickets, 'ticketsAmount');
  number(payments.fidelityCredit, 'paymentDiscountAmount');
  number(payments.unpaid, 'unpaid');
  if (payments.paymentTypeId !== undefined) {
    fields['paymentTypeId'] = payments.paymentTypeId;
  }
  if (payments.posTerminalId !== undefined) {
    fields['posTerminalId'] = payments.posTerminalId;
  }
  if (payments.specific !== undefined) {
    fields['specificPayments'] = payments.specific.map((entry) => ({ type: entry.type ?? null, name: entry.name ?? null, amount: entry.amount ?? 0 }));
  }
  if (payments.ticketDetails !== undefined) {
    fields['tickets'] = payments.ticketDetails.map((entry) => ({ name: entry.name ?? null, amount: entry.amount ?? 0, quantity: entry.quantity ?? 1 }));
  }
  if (payments.tickets === 0 && fields['tickets'] === undefined) {
    fields['tickets'] = [];
  }
  return fields;
}

/** What the refills of prepaid cards of a sale add up to: the lines that are products of the catalog and have the code of a refill, at their price with tax times their quantity. */
export function refillOf(sale: Document): number {
  return round2(listOf(sale['products']).reduce((sum, line) => (isCatalogLine(line) && typeof line['code'] === 'string' && isRefillCode(line['code']) ? sum + round2(amountOf(recordOf(line['price'])['taxed']) * amountOf(line['qt'])) : sum), 0));
}

/**
 * How much of the credit of the refills of a sale the refunds returned so far (cumulative): for each refill line that counted, the quantity returned (never above the quantity sold) at its price with tax. Never above {@link refillOf}.
 *
 * @param sale The saved sale.
 */
export function refillReturnedOf(sale: Document): number {
  const returned = returnedByLine(sale);
  // Each refill line gives back at most what was sold of it, at a price that is never negative; the total never goes below zero nor above the refills of the sale: a refund can never give credit.
  const total = listOf(sale['products']).reduce((sum, line, index) => (isCatalogLine(line) && typeof line['code'] === 'string' && isRefillCode(line['code']) ? sum + Math.max(0, Math.min(returned[index]!, amountOf(line['qt']))) * Math.max(0, amountOf(recordOf(line['price'])['taxed'])) : sum), 0);
  return round2(Math.min(Math.max(0, total), Math.max(0, refillOf(sale))));
}

/** What building a sale found and needs to be kept next to it. */
export interface BuiltSale {
  readonly sale: Document;
  /** What each line was found wrong, by position (`serverCheck` lists them). */
  readonly lineIssues: LineIssue[][];
  readonly anomalies: SaleAnomaly[];
}

/** What building a sale needs besides its body: the ids, the catalog, the customer and the operator the server resolved. */
export interface BuildInput {
  readonly body: CreateSaleBody;
  readonly id: ObjectId;
  readonly companyId: ObjectId;
  readonly placeId: ObjectId;
  readonly userId: ObjectId | null;
  readonly now: Date;
  readonly catalog: ReadonlyMap<string, CatalogProduct>;
  /** The contact of the customer: `null` when the body names none or the group does not have it. */
  readonly contact: { readonly copy: Document; readonly trashed: boolean } | null;
  readonly customerNamed: boolean;
  readonly createdBy: SaleActor;
  readonly operatorAnomalies: readonly string[];
}

/**
 * Builds a whole sale in the shape the legacy `insertOne` writes (its names, its types: ids as `ObjectId`, dates as `Date`, amounts as numbers), from the body of the point of sale and what the server read from the database: the company
 * and the point of sale of the key, the customer as a copy of the contact, the identity of each product from the catalog. Nothing is refused here: what is wrong becomes an anomaly. The fields of this backend are added by the service.
 *
 * @param input The body and what was read.
 * @returns The sale, what each line was found wrong and the anomalies.
 */
export function buildSale(input: BuildInput): BuiltSale {
  const { body, now } = input;
  const anomalies: SaleAnomaly[] = input.operatorAnomalies.map((code) => ({ at: now, operation: 'create', source: 'sale', code }));
  const flag = (code: string): void => {
    anomalies.push({ at: now, operation: 'create', source: 'sale', code });
  };
  if (input.customerNamed && input.contact === null) {
    flag('customerMissing');
  } else if (input.contact?.trashed === true) {
    flag('customerTrashed');
  }
  if (body.date.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    flag('dateInFuture');
  }
  const reduced = body.products.map((product) => reduceLine(product, input.catalog));
  if (reduced.some(({ line }) => !isCatalogLine(line) && typeof line['code'] === 'string' && isRefillCode(line['code']))) {
    flag('refillNotInCatalog');
  }
  const { customer, customerType } = customerOf(input.contact);
  const totals = body.totals;
  const taxableBefore = totals.taxableBeforeDiscount ?? totals.taxable;
  const totalBefore = totals.totalBeforeDiscount ?? totals.total;
  const discount = totals.discount ?? null;
  const device = body.cashDesk ?? null;
  const sale: Document = {
    _id: input.id,
    userId: input.userId,
    timestampId: body.timestampId,
    companyId: input.companyId,
    placeId: input.placeId,
    customer,
    lotteryId: body.lotteryCode ?? null,
    fidelityCard: body.fidelityCardCode === undefined || body.fidelityCardCode === null ? null : { code: body.fidelityCardCode },
    products: reduced.map((entry) => entry.line),
    refund: [],
    receiptType: body.receiptType,
    paymentTypeId: null,
    specificPayments: [],
    customerType,
    cashAmount: 0,
    electronicAmount: 0,
    ticketsAmount: 0,
    tickets: [],
    chequeAmount: 0,
    paymentDiscountAmount: 0,
    unpaid: 0,
    posTerminalId: null,
    ...paymentFields(body.payments),
    adjustmentType: discount?.adjustment ?? null,
    discountType: discount?.kind ?? null,
    discountPercentage: discount?.percentage ?? 0,
    discountValue: discount?.value ?? 0,
    date: body.date,
    checkoutSessionStartedAt: body.checkoutStartedAt ?? null,
    finalTotalTaxableWithoutDiscount: taxableBefore,
    finalTotalTaxWithoutDiscount: round2(totalBefore - taxableBefore),
    finalTotalTaxable: totals.taxable,
    finalTotalTax: totals.tax,
    finalTotalCheckout: totals.total,
    finalTotalCheckoutWithoutDiscount: totalBefore,
    device: device === null ? null : { settings: { id: device.deviceId ?? null, name: device.name ?? null, serialNumber: device.serialNumber ?? null, driver: device.driver ?? null }, companyId: input.companyId.toHexString(), placeId: input.placeId.toHexString() },
    table:
      body.table === undefined || body.table === null
        ? null
        : { originalTable: { id: body.table.tableId ?? null, name: body.table.name ?? null, roomId: body.table.roomId ?? null }, startDate: body.table.startDate ?? null, covers: body.table.covers ?? null, partition: body.table.partition ?? null },
    appointment:
      body.appointment === undefined || body.appointment === null
        ? null
        : { _id: body.appointment.appointmentId, customerId: body.appointment.customerId ?? null, services: (body.appointment.services ?? []).map((service) => ({ _id: service.serviceId, staffSelected: service.staffId ?? null })) },
    savedCheckoutsNote: body.note ?? null,
    fiscalReceiptInfo: fiscalInfoOf(body.fiscalReceiptInfo),
    fullMeal: body.fullMeal === undefined || body.fullMeal === null ? null : { status: body.fullMeal.status ?? null, quantity: body.fullMeal.quantity ?? null },
    delivery: body.delivery === undefined || body.delivery === null ? null : { type: body.delivery.type ?? null, date: body.delivery.date ?? null, userId: null, sentAt: body.delivery.sentAt ?? null },
    reservation: body.reservation === undefined || body.reservation === null ? null : { date: body.reservation.date ?? null },
    hotel: { roomId: body.hotel?.roomId ?? null, roomName: body.hotel?.roomName ?? null },
    fiscalState: '',
    sType: body.nonFiscal === true,
    insertDate: now,
    updateDate: null,
  };
  // The mother sale of a split table carries the products, not the loyalty: the fiscal parts do. Whatever loyalty it carries is recorded and never applied.
  if (body.receiptType === 'partitioned' && (body.fidelityCardCode != null || (body.payments.fidelityCredit ?? 0) > 0 || reduced.some(({ line }) => typeof line['code'] === 'string' && isRefillCode(line['code'])))) {
    flag('partitionedLoyalty');
  }
  const refill = refillOf(sale);
  const nonCredit = amountOf(sale['cashAmount']) + amountOf(sale['electronicAmount']) + amountOf(sale['chequeAmount']) + amountOf(sale['ticketsAmount']);
  if (refill > nonCredit + 0.01) {
    flag('refillNotCovered');
  }
  return { sale, lineIssues: reduced.map((entry) => entry.issues), anomalies };
}

/**
 * Whether a saved line is a product of the catalog: the lines this backend saves carry the categories read from the catalog (a free product, or an id the catalog does not have, has none). The code of a line that is not a product of the catalog is the till's word.
 *
 * @param line A saved line.
 */
export const isCatalogLine = (line: Document): boolean => line['freeProduct'] === false && Array.isArray(line['categories']);

/**
 * The facts of a saved sale the loyalty effects depend on. A refill of a prepaid card counts only on a line that is a product of the catalog (the code of a free product is whatever the till said): the others have no code here. `asStored` keeps the codes
 * of every line, as the legacy did (the adoption of a sale of the legacy).
 *
 * @param sale The saved sale.
 * @param asStored Keep the code of every line.
 */
export function loyaltyFactsOf(sale: Document, asStored = false): SaleFacts {
  const lines = listOf(sale['products']).map((line) => {
    const price = recordOf(line['price']);
    return { code: typeof line['code'] === 'string' && (asStored || isCatalogLine(line)) ? line['code'] : '', taxedPrice: amountOf(price['taxed']), quantity: amountOf(line['qt']) };
  });
  const place = sale['placeId'];
  return { placeId: place instanceof ObjectId ? place : ObjectId.createFromHexString(String(place)), date: sale['date'] as Date, finalTotalCheckout: amountOf(sale['finalTotalCheckout']), creditUsed: amountOf(sale['paymentDiscountAmount']), lines };
}

/** The currency of a saved sale: the one of its first line that has it, `EUR` otherwise. */
export function currencyOf(sale: Document): string {
  const currencies = listOf(sale['products']).map((line) => recordOf(line['price'])['currency']);
  return (currencies.find((currency): currency is string => typeof currency === 'string' && currency !== '')) ?? 'EUR';
}

/** The code of the loyalty card of a saved sale; `null` when it has none. */
export function cardCodeOf(sale: Document): string | null {
  const code = recordOf(sale['fidelityCard'])['code'];
  return typeof code === 'string' && code.trim() !== '' ? code : null;
}

/** The quantity returned of each line of a saved sale, by position, from the refunds this backend made (they carry the position of the lines; the ones the legacy made do not and are left out). */
export function returnedByLine(sale: Document): number[] {
  const returned = listOf(sale['products']).map(() => 0);
  for (const refund of listOf(sale['refund'])) {
    for (const good of listOf(refund['returnedGoods'])) {
      const index = good['index'];
      if (refund['canceled'] !== true && typeof index === 'number' && index >= 0 && index < returned.length) {
        returned[index] = round2(returned[index]! + amountOf(good['returnedQt']));
      }
    }
  }
  return returned;
}

/** How much of the sale, from 0 to 1, the refunds of this backend returned: what they returned over what the customer paid. */
export function refundedRatioOf(sale: Document): number {
  const total = amountOf(sale['finalTotalCheckout']);
  const returned = listOf(sale['refund']).reduce((sum, refund) => (refund['canceled'] === true || typeof refund['timestampId'] !== 'string' ? sum : sum + amountOf(recordOf(refund['returnedGoodsValue'])['priceTaxed'])), 0);
  return total <= 0 ? 0 : Math.min(1, Math.max(0, returned / total));
}

/** The value of some returned quantities of the lines of a sale: the taxable, the tax and the total with tax, rounded to two decimals. */
function valueOf(lines: readonly Document[], quantities: ReadonlyMap<number, number>): { readonly totalNoTax: number; readonly taxValue: number; readonly priceTaxed: number } {
  let net = 0;
  let gross = 0;
  for (const [index, quantity] of quantities) {
    const price = recordOf(lines[index]!['price']);
    const discount = 1 - amountOf(price['discount']) / 100;
    net += quantity * amountOf(price['price']) * discount;
    gross += quantity * amountOf(price['taxed']) * discount;
  }
  return { totalNoTax: round2(net), taxValue: round2(gross - net), priceTaxed: round2(gross) };
}

/** A line the way a refund keeps it: its identity, its price and how much of it was returned, with its position in the sale. */
function returnedGoodOf(line: Document, index: number, returnedQt: number): Document {
  const price = recordOf(line['price']);
  return { index, _id: line['_id'], code: line['code'], name: line['name'], type: line['type'], freeProduct: line['freeProduct'] === true, qt: line['qt'], returnedQt, price: { price: price['price'], taxed: price['taxed'], discount: price['discount'], tax: price['tax'], taxData: price['taxData'] } };
}

/** What a refund may find wrong in its own lines: the position that is not a line of the sale, or the id that is not the one of the line. Reported as problems of the body (`422`), not as anomalies. */
export function refundLineProblems(sale: Document, body: RefundSaleBody): string[] {
  const lines = listOf(sale['products']);
  const problems: string[] = [];
  body.products.forEach((entry, position) => {
    const line = lines[entry.index];
    if (line === undefined || amountOf(line['qt']) <= 0) {
      // A position that is not a line, or a line that was not sold (a quantity that is not above zero, such as a return inside the receipt), cannot be returned.
      problems.push(`products.${String(position)}.index`);
    } else if (entry.productId !== undefined && !(line['_id'] instanceof ObjectId && line['_id'].equals(entry.productId))) {
      problems.push(`products.${String(position)}.productId`);
    }
  });
  return problems;
}

/**
 * The element of `refund[]` a refund adds, in the shape of the legacy (`returnedGoods`, `returnedGoodsValue`, `fiscalReceiptInfo`) with the `timestampId` of the refund, its date and its operator. The value is the one of the till when it sent it, the one computed
 * from the lines otherwise. `exceeds` says the refunds, with this one, return more of a line than was sold.
 */
export function refundEntryOf(sale: Document, body: RefundSaleBody, userId: ObjectId | null): { readonly entry: Document; readonly exceeds: boolean } {
  const lines = listOf(sale['products']);
  const already = returnedByLine(sale);
  const quantities = new Map<number, number>();
  for (const { index, quantity } of body.products) {
    quantities.set(index, round2((quantities.get(index) ?? 0) + quantity));
  }
  const exceeds = [...quantities].some(([index, quantity]) => quantity + already[index]! > amountOf(lines[index]!['qt']) + 1e-9);
  const computed = valueOf(lines, quantities);
  const value = body.value === undefined || body.value === null ? computed : { totalNoTax: body.value.taxable, taxValue: body.value.tax, priceTaxed: body.value.total };
  return {
    entry: { timestampId: body.timestampId, date: body.date, userId, returnedGoods: [...quantities].map(([index, quantity]) => returnedGoodOf(lines[index]!, index, quantity)), returnedGoodsValue: value, fiscalReceiptInfo: fiscalInfoOf(body.fiscalReceiptInfo) },
    exceeds,
  };
}

/** The element of `refund[]` a cancellation adds: what was left of every line, marked `canceled`. The refunds before it stay: the legacy replaced them. */
export function cancellationEntryOf(sale: Document, body: CancelSaleBody, userId: ObjectId | null): Document {
  const lines = listOf(sale['products']);
  const already = returnedByLine(sale);
  const quantities = new Map<number, number>();
  lines.forEach((line, index) => {
    const left = round2(amountOf(line['qt']) - already[index]!);
    if (left > 0) {
      quantities.set(index, left);
    }
  });
  return { timestampId: null, canceled: true, date: body.date, userId, returnedGoods: [...quantities].map(([index, quantity]) => returnedGoodOf(lines[index]!, index, quantity)), returnedGoodsValue: valueOf(lines, quantities), fiscalReceiptInfo: fiscalInfoOf(body.fiscalReceiptInfo) };
}
