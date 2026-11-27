import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { dateOf } from '../groups/catalogs/kit.ts';
import { amountOf, cardCodeOf, listOf, numberOrNull, recordOf, textOrNull, versionOf } from './sales.document.ts';

/** A line of a sale as the point of sale that made it sees it: the position the refunds use, and what the till needs to print a refund. */
export interface StoreSaleLine {
  readonly index: number;
  readonly productId: string | null;
  readonly lineId: string | null;
  readonly code: string | null;
  readonly name: Readonly<Record<string, string>> | null;
  readonly quantity: number;
  readonly unitPrice: { readonly net: number; readonly gross: number };
  readonly discountPercent: number;
  readonly taxRate: number | null;
  readonly taxId: string | null;
  readonly barcode: string | null;
  /** How much of the line was returned (by the refunds of this backend). */
  readonly returned: number;
}

/** A refund (or a cancellation) of a sale. */
export interface StoreSaleRefund {
  readonly timestampId: string | null;
  readonly canceled: boolean;
  readonly date: string | null;
  readonly products: readonly { readonly index: number | null; readonly productId: string | null; readonly quantity: number }[];
  readonly value: { readonly taxable: number; readonly tax: number; readonly total: number };
  readonly fiscalReceiptInfo: StoreFiscalInfo | null;
}

/** The fiscal receipt of a sale or of a refund. */
export interface StoreFiscalInfo {
  readonly date: string | null;
  readonly report: number | null;
  readonly number: number | null;
  readonly amount: number | null;
}

/** A sale as the point of sale that made it sees it, in the names of the domain and with importes in currency units. The customer is only the id of the contact. Never the checks of the server or the anomalies' details: only their count. */
export interface StoreSaleView {
  readonly id: string;
  readonly timestampId: string | null;
  readonly date: string | null;
  readonly receiptType: 'receipt' | 'invoice' | 'charge' | 'partitioned' | null;
  readonly nonFiscal: boolean;
  readonly fiscalState: 'refunded' | 'canceled' | null;
  readonly operatorId: string | null;
  readonly customer: { readonly contactId: string } | null;
  readonly fidelityCardCode: string | null;
  readonly lotteryCode: string | null;
  readonly note: string | null;
  readonly products: readonly StoreSaleLine[];
  readonly totals: { readonly taxable: number; readonly tax: number; readonly total: number; readonly discount: { readonly adjustment: string | null; readonly kind: string | null; readonly percentage: number; readonly value: number } };
  readonly payments: { readonly cash: number; readonly electronic: number; readonly cheque: number; readonly tickets: number; readonly fidelityCredit: number; readonly unpaid: number };
  readonly fiscalReceiptInfo: StoreFiscalInfo | null;
  readonly refunds: readonly StoreSaleRefund[];
  readonly checks: { readonly status: 'ok' | 'differences' | null; readonly anomalies: number };
  /** The version of the sale: the `ETag` of the response and the value of `If-Match` of the next write. */
  readonly version: string;
}

const text = textOrNull;
const idText = (raw: unknown): string | null => (raw instanceof ObjectId ? raw.toHexString() : typeof raw === 'string' && /^[0-9a-fA-F]{24}$/.test(raw) ? raw.toLowerCase() : null);

function fiscalOf(raw: unknown): StoreFiscalInfo | null {
  const info = recordOf(raw);
  const view = { date: dateOf(info['date']), report: numberOrNull(info['reportNumber']), number: numberOrNull(info['number']), amount: numberOrNull(info['amount']) };
  return Object.values(view).every((value) => value === null) ? null : view;
}

function nameOf(raw: unknown): Readonly<Record<string, string>> | null {
  const entries = Object.entries(recordOf(raw)).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

/**
 * The view of a sale for the point of sale that made it, from the stored document (the legacy shape, read tolerantly: a field that is missing or of the wrong type is `null` or `0`).
 *
 * @param sale The stored sale.
 * @returns The view, with its version.
 */
export function storeSaleView(sale: Document): StoreSaleView {
  const lines = listOf(sale['products']);
  const returned = lines.map(() => 0);
  const refunds = listOf(sale['refund']);
  for (const refund of refunds) {
    for (const good of listOf(refund['returnedGoods'])) {
      const index = good['index'];
      if (refund['canceled'] !== true && typeof index === 'number' && index >= 0 && index < returned.length) {
        returned[index] = returned[index]! + amountOf(good['returnedQt']);
      }
    }
  }
  const cloud = recordOf(sale['floodCloud']);
  const status = recordOf(cloud['serverCheck'])['status'];
  const customerId = idText(recordOf(sale['customer'])['_id']);
  const adjustment = sale['adjustmentType'];
  return {
    id: (sale['_id'] as ObjectId).toHexString(),
    timestampId: text(sale['timestampId']),
    date: dateOf(sale['date']),
    receiptType: ['receipt', 'invoice', 'charge', 'partitioned'].includes(sale['receiptType'] as string) ? (sale['receiptType'] as StoreSaleView['receiptType']) : null,
    nonFiscal: Boolean(sale['sType']),
    fiscalState: sale['fiscalState'] === 'refunded' || sale['fiscalState'] === 'canceled' ? sale['fiscalState'] : null,
    operatorId: idText(sale['userId']),
    customer: customerId === null ? null : { contactId: customerId },
    fidelityCardCode: cardCodeOf(sale),
    lotteryCode: text(sale['lotteryId']),
    note: text(sale['savedCheckoutsNote']),
    products: lines.map((line, index) => {
      const price = recordOf(line['price']);
      return {
        index,
        productId: idText(line['_id']),
        lineId: text(line['timestampId']),
        code: text(line['code']),
        name: nameOf(line['name']),
        quantity: amountOf(line['qt']),
        unitPrice: { net: amountOf(price['price']), gross: amountOf(price['taxed']) },
        discountPercent: amountOf(price['discount']),
        taxRate: numberOrNull(price['tax']),
        taxId: text(recordOf(price['taxData'])['id']),
        barcode: text(line['barcodeRead']),
        returned: returned[index]!,
      };
    }),
    totals: {
      taxable: amountOf(sale['finalTotalTaxable']),
      tax: amountOf(sale['finalTotalTax']),
      total: amountOf(sale['finalTotalCheckout']),
      discount: { adjustment: text(adjustment), kind: text(sale['discountType']), percentage: amountOf(sale['discountPercentage']), value: amountOf(sale['discountValue']) },
    },
    payments: { cash: amountOf(sale['cashAmount']), electronic: amountOf(sale['electronicAmount']), cheque: amountOf(sale['chequeAmount']), tickets: amountOf(sale['ticketsAmount']), fidelityCredit: amountOf(sale['paymentDiscountAmount']), unpaid: amountOf(sale['unpaid']) },
    fiscalReceiptInfo: fiscalOf(sale['fiscalReceiptInfo']),
    refunds: refunds.map((refund) => {
      const value = recordOf(refund['returnedGoodsValue']);
      return {
        timestampId: text(refund['timestampId']),
        canceled: refund['canceled'] === true,
        date: dateOf(refund['date']),
        products: listOf(refund['returnedGoods']).map((good) => ({ index: numberOrNull(good['index']), productId: idText(good['_id']), quantity: amountOf(good['returnedQt']) })),
        value: { taxable: amountOf(value['totalNoTax']), tax: amountOf(value['taxValue']), total: amountOf(value['priceTaxed']) },
        fiscalReceiptInfo: fiscalOf(refund['fiscalReceiptInfo']),
      };
    }),
    checks: { status: status === 'ok' || status === 'differences' ? status : null, anomalies: listOf(cloud['anomalies']).length },
    version: versionOf(sale),
  };
}
