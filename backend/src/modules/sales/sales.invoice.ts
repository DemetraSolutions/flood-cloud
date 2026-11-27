import type { Document, ObjectId } from 'mongodb';
import { HUB } from '../companies/hubs.ts';
import type { NumberReservation } from '../document-numbering/numbering.service.ts';
import { amountOf, listOf, recordOf, textOrNull } from './sales.document.ts';

/** The hub a company sends its invoices through: its `fattura_elettronica.hub` when it has the form of a hub (`aruba` or `aruba__<dealer>`); `null` when it has none (or one of another form). Only with a hub the invoice can go to the send queue and consume a `progressivo_invio`. */
export function hubOf(company: Document): string | null {
  const hub = recordOf(company['fattura_elettronica'])['hub'];
  return typeof hub === 'string' && HUB.test(hub) ? hub : null;
}

/**
 * Whether the hub of a company may carry the invoices of its group: `aruba` (the account of the platform) always; `aruba__<dealer>` (the account of a dealer, which sends only the invoices of the companies that have it) only when that dealer is the one of the group. An invoice
 * with a hub of another dealer would be sent with the account of someone else.
 *
 * @param hub A hub as {@link hubOf} gives it.
 * @param dealerId The dealer of the group; `null` when it has none.
 */
export function isHubAllowed(hub: string, dealerId: ObjectId | null): boolean {
  const owner = HUB.exec(hub)?.[1];
  return owner === undefined || (dealerId !== null && dealerId.toHexString() === owner);
}

/** The type of electronic document of an invoice: the one the till asked for, else `TD24` for the deferred invoice that gathers unpaid sales, else `TD01`. */
export function invoiceTypeOf(requested: string | undefined, gathersUnpaid: boolean): string {
  return requested ?? (gathersUnpaid ? 'TD24' : 'TD01');
}

/** What building the document of an invoice needs: the sale, the number it was given, and what was read from the database. */
export interface InvoiceInput {
  readonly documentId: ObjectId;
  readonly sale: Document;
  readonly reservation: NumberReservation;
  /** The `progressivo_invio` of the electronic invoice; `null` when the invoice is not sent (no hub), which consumed none. */
  readonly progressive: number | null;
  readonly type: string;
  /** The company as read from the database (the fixed projection). */
  readonly company: Document;
  /** The customer as read from the database (the fixed projection); `null` when the sale has none. */
  readonly counterpart: Document | null;
  readonly storageId: ObjectId | null;
  readonly xml: Document | null;
  /** The sales this deferred invoice gathered (`metadata.unpaidIds`, as the legacy keeps them: texts); empty for any other invoice. */
  readonly unpaidIds: readonly string[];
  /** The state of sending the document starts with: `notQueued` when it goes through a hub (until it is in the queue), `null` otherwise. */
  readonly sendStatus: 'notQueued' | null;
  /** The group, written in the document only when it goes to the send queue. */
  readonly groupId: ObjectId | null;
  readonly now: Date;
}

/**
 * Builds the document of an invoice in the shape of the legacy `doc3` (its names, its types: ids as `ObjectId`, dates as `Date`, totals as numbers), plus `insertDate`. The copies of the company and of the customer are the ones the server read from the database,
 * never the ones of the client; the totals and the `records` are the ones the sale already saved. Its state of sending starts as the input says.
 *
 * @param input The sale and what was read.
 * @returns The document to insert.
 */
export function buildInvoiceDocument(input: InvoiceInput): Document {
  const { sale } = input;
  return {
    _id: input.documentId,
    userId: sale['userId'] ?? null,
    date: sale['date'],
    number: input.reservation.number,
    prefixSuffix: input.reservation.prefixSuffix,
    type: 'invoice',
    companyId: sale['companyId'],
    placeId: sale['placeId'],
    storageId: input.storageId,
    company: input.company,
    counterpart: input.counterpart,
    customerType: sale['customerType'] ?? null,
    note: sale['savedCheckoutsNote'] ?? null,
    adjustmentType: sale['adjustmentType'] ?? null,
    discountPercentage: amountOf(sale['discountPercentage']),
    discountValue: amountOf(sale['discountValue']),
    totalTaxableWithoutDiscount: amountOf(sale['finalTotalTaxableWithoutDiscount']),
    totalTaxable: amountOf(sale['finalTotalTaxable']),
    totalTax: amountOf(sale['finalTotalTax']),
    totalWithoutDiscount: amountOf(sale['finalTotalCheckoutWithoutDiscount']),
    total: amountOf(sale['finalTotalCheckout']),
    totalLastPrices: 0,
    records: listOf(sale['products']),
    saleId: sale['_id'],
    saleTimestampId: sale['timestampId'],
    fattura_elettronica: { tipo: input.type, progressivo_invio: input.progressive },
    XML: input.xml,
    ...(input.unpaidIds.length === 0 ? {} : { metadata: { unpaidIds: [...input.unpaidIds] } }),
    sendStatus: input.sendStatus,
    ...(input.groupId === null ? {} : { groupId: input.groupId }),
    insertDate: input.now,
    updateDate: input.now,
  };
}

/**
 * The record of the send queue of a document, in the shape the legacy gave it: the dealer of the group, the document as it was inserted and the fields of the sale the consumer reads (`fullMeal`: the invoice of a split table prints one line for the whole meal). The `_id` is the
 * one of the document, so the record is written once whoever asks. `sendStatus` is `null` in the queue: the consumer is the one that moves it.
 *
 * @param document The document of the invoice as stored (with the `groupId` of a document that goes to the queue).
 * @param sale The sale of the invoice: only `_id` and `fullMeal` are copied.
 * @param dealerId The dealer of the group; `null` when the group has none.
 */
export function queueRecordOf(document: Document, sale: Document, dealerId: ObjectId | null): Document {
  return { _id: document['_id'], dealerId, ...document, sendStatus: null, sale: { _id: sale['_id'], fullMeal: sale['fullMeal'] ?? null } };
}

/** The part of the invoice of a sale the till shows: where to find the document, its number as printed, and whether it went to the send queue. */
export interface SaleInvoiceView {
  readonly documentId: string;
  readonly number: number;
  readonly prefixSuffix: string;
  /** Where the sectional goes in the printed number. */
  readonly prefixSuffixPosition: 'prefix' | 'suffix' | null;
  readonly year: number;
  /** `queued`, `notQueued` (the invoice is sent through a hub and is not in the queue yet), the state the e-invoicing moved it to, or `null` (no hub: it is never sent from here). */
  readonly sendStatus: string | null;
}

/**
 * The view of the invoice document of a sale.
 *
 * @param document The document as stored.
 * @param year The fiscal year the number was given for; `null` for a document of the legacy (the year of its date).
 */
export function invoiceViewOf(document: Document, year: number | null): SaleInvoiceView {
  const position = recordOf(document['company'])['invoicesPS'];
  const date = document['date'];
  return {
    documentId: (document['_id'] as ObjectId).toHexString(),
    number: amountOf(document['number']),
    prefixSuffix: textOrNull(document['prefixSuffix']) ?? '',
    prefixSuffixPosition: position === 'prefix' || position === 'suffix' ? position : null,
    year: year ?? (date instanceof Date ? date.getUTCFullYear() : 0),
    sendStatus: textOrNull(document['sendStatus']),
  };
}
