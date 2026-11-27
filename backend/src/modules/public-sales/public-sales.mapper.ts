import type { Document, ObjectId } from 'mongodb';
import { dateOf } from '../groups/catalogs/kit.ts';
import { amountOf, fiscalNumberOf, idOf, listOf, localizedOf, numberOf, objectOf, refundsOf, textOf } from '../sales/sales.mapper.ts';
import type { FiscalNumber } from '../sales/sales.mapper.ts';

/** Most lines of a sale the public API shows. */
export const PUBLIC_SALE_MAX_LINES = 500;

/** The fields a public read takes from a sale: never the operator, the customer's data, the card, the lottery code, the notes, the checks, the costs or the device (not even its name). */
export const PUBLIC_SALE_PROJECTION: Readonly<Record<string, 1>> = Object.freeze({
  date: 1,
  receiptType: 1,
  'fiscalReceiptInfo.reportNumber': 1,
  'fiscalReceiptInfo.number': 1,
  fiscalState: 1,
  'refund.date': 1,
  'refund.fiscalReceiptInfo.date': 1,
  'refund.fiscalReceiptInfo.reportNumber': 1,
  'refund.fiscalReceiptInfo.number': 1,
  'refund.returnedGoodsValue.priceTaxed': 1,
  status: 1,
  unpaid: 1,
  companyId: 1,
  placeId: 1,
  'customer._id': 1,
  'products._id': 1,
  'products.code': 1,
  'products.name': 1,
  'products.qt': 1,
  'products.price.taxed': 1,
  'products.price.discount': 1,
  'products.price.tax': 1,
  'products.price.taxData.value': 1,
  finalTotalCheckout: 1,
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
});

/** A refund of a sale as the public API shows it. */
export interface PublicRefund {
  readonly date: string | null;
  readonly number: FiscalNumber | null;
  readonly amountCents: number;
}

/** A line of a sale as the public API shows it. */
export interface PublicSaleLine {
  readonly productId: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly discountPercent: number;
  readonly taxRatePercent: number | null;
}

/** A sale as the public API shows it: amounts in whole cents, the customer only by its id. */
export interface PublicSale {
  readonly id: string;
  readonly date: string | null;
  /** `partitioned` is the parent bill of a table split into several receipts: it is not a receipt (it must not be counted nor summed as revenue) and it carries the products of the whole table. */
  readonly receiptType: 'receipt' | 'invoice' | 'charge' | 'partitioned' | null;
  readonly number: FiscalNumber | null;
  readonly fiscalState: 'canceled' | 'refunded' | null;
  readonly refunds: readonly PublicRefund[];
  readonly invoiced: boolean;
  readonly companyId: string | null;
  readonly placeId: string | null;
  readonly customerId: string | null;
  readonly products: readonly PublicSaleLine[];
  readonly productsCount: number;
  readonly totals: { readonly totalCents: number; readonly taxableCents: number; readonly taxCents: number; readonly discount: { readonly adjustment: 'discount' | 'surcharge' | null; readonly percentage: number; readonly valueCents: number } };
  readonly payments: { readonly cashCents: number; readonly electronicCents: number; readonly chequeCents: number; readonly ticketsCents: number; readonly fidelityCreditCents: number };
  readonly unpaidCents: number;
}

/** An amount in currency units as whole cents (a finite number, `0` for anything else). */
const centsOf = (raw: unknown): number => Math.round(Number((amountOf(raw) * 100).toPrecision(15))) + 0;

/** The kinds of receipt the public API names. */
const RECEIPT_TYPES: readonly string[] = ['receipt', 'invoice', 'charge', 'partitioned'];

/**
 * A sale of the public API, read tolerantly from the stored document (the legacy's, written by the point of sale): a field that is missing or has the wrong type is `null`, `0` or an empty list.
 *
 * @param document The stored sale, read with {@link PUBLIC_SALE_PROJECTION}.
 */
export function toPublicSale(document: Document): PublicSale {
  const receiptType = RECEIPT_TYPES.find((type) => type === document['receiptType']);
  const fiscalState = document['fiscalState'];
  const adjustment = document['adjustmentType'];
  const lines = listOf(document['products']);
  const customer = objectOf(document['customer']);
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    date: dateOf(document['date']),
    receiptType: receiptType === undefined ? null : (receiptType as PublicSale['receiptType']),
    number: fiscalNumberOf(document['fiscalReceiptInfo']),
    fiscalState: fiscalState === 'canceled' || fiscalState === 'refunded' ? fiscalState : null,
    refunds: refundsOf(document['refund']).map((refund) => ({
      date: dateOf(refund['date']) ?? dateOf(objectOf(refund['fiscalReceiptInfo'])?.['date']),
      number: fiscalNumberOf(refund['fiscalReceiptInfo']),
      amountCents: centsOf(objectOf(refund['returnedGoodsValue'])?.['priceTaxed']),
    })),
    invoiced: document['status'] === 'invoiced',
    companyId: idOf(document['companyId']),
    placeId: idOf(document['placeId']),
    customerId: idOf(customer?.['_id']),
    products: lines.slice(0, PUBLIC_SALE_MAX_LINES).map((raw) => {
      const line = objectOf(raw);
      const price = objectOf(line?.['price']);
      return {
        productId: idOf(line?.['_id']),
        code: textOf(line?.['code']),
        name: localizedOf(line?.['name'], null),
        quantity: amountOf(line?.['qt']),
        unitPriceCents: centsOf(price?.['taxed']),
        discountPercent: amountOf(price?.['discount']),
        taxRatePercent: numberOf(objectOf(price?.['taxData'])?.['value']) ?? numberOf(price?.['tax']),
      };
    }),
    productsCount: lines.length,
    totals: {
      totalCents: centsOf(document['finalTotalCheckout']),
      taxableCents: centsOf(document['finalTotalTaxable']),
      taxCents: centsOf(document['finalTotalTax']),
      discount: { adjustment: adjustment === 'discount' || adjustment === 'surcharge' ? adjustment : null, percentage: amountOf(document['discountPercentage']), valueCents: centsOf(document['discountValue']) },
    },
    payments: { cashCents: centsOf(document['cashAmount']), electronicCents: centsOf(document['electronicAmount']), chequeCents: centsOf(document['chequeAmount']), ticketsCents: centsOf(document['ticketsAmount']), fidelityCreditCents: centsOf(document['paymentDiscountAmount']) },
    unpaidCents: centsOf(document['unpaid']),
  };
}
