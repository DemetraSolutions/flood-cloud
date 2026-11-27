import { SaleDetail, SaleProduct } from '../app/features/sales/sale.types';

/** Identifiers the sale fixtures use. */
export const SALE_GROUP = '665f1c2e9b1d4a0012ab34a1';
export const SALE_ID = '665f1c2e9b1d4a0012ab4001';
export const SALE_CONTACT = '665f1c2e9b1d4a0012ab3a01';
export const SALE_COMPANY = '665f1c2e9b1d4a0012ab3411';
export const SALE_PLACE = '665f1c2e9b1d4a0012ab3421';

/** A line of a sale (fictitious values); override what the test cares about. */
export function aSaleProduct(over: Partial<SaleProduct> = {}): SaleProduct {
  return {
    productId: 'p1',
    code: 'C1',
    name: 'Caffè',
    quantity: 2,
    unitPrice: 1.2,
    discount: 0,
    variants: null,
    index: 0,
    returned: 0,
    ...over,
  };
}

/** A complete sale as the page reads it (fictitious values); override what the test cares about. */
export function aSaleDetail(over: Partial<SaleDetail> = {}): SaleDetail {
  return {
    id: SALE_ID,
    date: '2026-11-20T10:30:00.000Z',
    receiptType: 'receipt',
    nonFiscal: false,
    number: { report: 12, number: 345 },
    fiscalState: null,
    refunds: [],
    unpaid: 0,
    invoiced: false,
    total: 30,
    companyId: SALE_COMPANY,
    placeId: SALE_PLACE,
    cashDesk: 'Cassa 1',
    operator: { id: 'u1', name: 'Mario Verdi' },
    table: 'T4',
    customer: { id: SALE_CONTACT, displayName: 'Verdi srl' },
    products: [
      aSaleProduct(),
      aSaleProduct({
        productId: null,
        code: null,
        name: null,
        quantity: 1.5,
        unitPrice: 20,
        discount: 10,
        variants: '+ Extra x2',
        index: 1,
      }),
    ],
    productsCount: 2,
    totals: { total: 30, taxable: 24.59, tax: 5.41, discount: { adjustment: null, percentage: 0, value: 0 } },
    payments: { cash: 30, electronic: 0, cheque: 0, tickets: 0, fidelityCredit: 0, unpaid: 0 },
    fiscalReceiptInfo: { date: '2026-11-20T10:31:00.000Z', report: 12, number: 345, amount: 30 },
    fidelityCardCode: 'CARD1',
    fidelityCardUsed: true,
    note: 'Senza cipolla',
    canceled: false,
    returnedValue: 0,
    serverCheck: null,
    anomalies: [],
    invoice: null,
    operations: [],
    version: 'v1',
    ...over,
  };
}
