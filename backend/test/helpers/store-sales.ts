import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';

/** The warehouse rules of a group that moves the stock at the cash desks: the sale unloads, the return loads. */
export const SALES_WAREHOUSE_RULES = {
  d1: { id: 'd1', type: 'D', quantity: '-', value: '=', cashD: true, cashL: false, name: 'Sale', default: true },
  l1: { id: 'l1', type: 'L', quantity: '+', value: '=', cashL: true, cashD: false, name: 'Return', default: true },
};

/** The tax data a line of the till carries. */
export const LINE_TAX = Object.freeze({ id: 'tax-001', value: 22, natura: null, description: 'Ordinaria', department: 1 });

/**
 * A line of a sale as the till sends it: the product object with the price and the facts of the line (the catalog fields it also sends are in `extra`, with unknown ones: the server keeps only its allowlist).
 *
 * @param productId The product (`null` for a free product).
 * @param extra Fields that replace or add to the line.
 */
export function saleLine(productId: ObjectId | null, extra: Document = {}): Document {
  return { ...(productId === null ? {} : { _id: productId.toHexString() }), qt: 2, price: { price: 10, taxed: 12.2, discount: 0, tax: 22, listId: 'list-1', currency: 'EUR', taxData: { ...LINE_TAX } }, timestampId: 'line-1', ...extra };
}

/**
 * A creation body that adds up: two pieces at 12.20 with 22 percent tax, paid in cash, with its fiscal receipt.
 *
 * @param lines The lines (one product line when absent).
 * @param overrides Fields that replace those of the body.
 */
export function saleBody(lines: Document[], overrides: Document = {}): Document {
  return {
    timestampId: 'T-1',
    date: '2026-11-27T10:00:00.000Z',
    receiptType: 'receipt',
    products: lines,
    totals: { taxable: 20, tax: 4.4, total: 24.4 },
    payments: { cash: 24.4 },
    fiscalReceiptInfo: { date: '2026-11-27T10:00:04.000Z', report: 101, number: 12, amount: 24.4 },
    ...overrides,
  };
}
