import type { Document } from 'mongodb';
import { round2 } from '../loyalty/loyalty.compute.ts';
import { recordOf } from './sales.document.ts';
import type { LineIssue } from './sales.lines.ts';

/** How far apart two amounts may be before the server calls them different (a cent: the till rounds each line, the server the sum). */
export const CHECK_TOLERANCE = 0.01;

/** Most lines the check lists; above it the check says it was cut. */
export const CHECK_MAX_LINES = 100;

/** One difference of a line: its position, what is wrong and, for a number, what the till said and what the server computes. */
export interface LineCheck {
  readonly index: number;
  readonly code: LineIssue | 'taxMissing' | 'taxRateDiffers' | 'lineTotalMismatch';
  readonly pos?: number;
  readonly server?: number;
}

/** One difference of a total of the sale. */
export interface TotalCheck {
  readonly field: 'total' | 'taxable' | 'tax' | 'payments' | 'totalBeforeDiscount';
  readonly pos: number;
  readonly server: number;
}

/** The result of recomputing a sale on the server: never a reason to refuse the sale, saved in it to be shown in the backoffice. */
export interface ServerCheck {
  readonly checkedAt: Date;
  readonly status: 'ok' | 'differences';
  /** Only the totals that differ. */
  readonly totals: TotalCheck[];
  /** At most {@link CHECK_MAX_LINES} differences of lines. */
  readonly lines: LineCheck[];
  readonly linesTruncated: boolean;
}

const finite = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0);
const differs = (pos: number, server: number): boolean => Math.abs(pos - server) > CHECK_TOLERANCE + 1e-9;

/**
 * Recomputes the arithmetic of a sale and its tax rates, and lists what the point of sale said differently. It is limited to the arithmetic of the lines, of the totals, of the tax and of the payments with a tolerance of {@link CHECK_TOLERANCE}:
 * the price is never compared with the price list (decision 6 of step VS4). Each line is worth `quantity × unit price × (1 - discount of the line)`, the tax of a line is its rate over the net price; the totals are the sums of the lines, scaled to the total of
 * the receipt when it carries a discount or a surcharge on the whole.
 *
 * @param sale The saved sale (its lines, totals and payments, in the legacy shape).
 * @param issues What the reduction of each line found, by position.
 * @param at The instant of the check.
 * @returns The check.
 */
export function serverCheckOf(sale: Document, issues: readonly (readonly LineIssue[])[], at: Date): ServerCheck {
  const lines: LineCheck[] = [];
  const push = (check: LineCheck): void => {
    lines.push(check);
  };
  let gross = 0;
  let net = 0;
  const products = Array.isArray(sale['products']) ? (sale['products'] as Document[]) : [];
  products.forEach((line, index) => {
    for (const code of issues[index] ?? []) {
      push({ index, code });
    }
    const quantity = finite(line['qt']);
    const price = recordOf(line['price']);
    const discount = 1 - finite(price['discount']) / 100;
    const unitNet = finite(price['price']);
    const unitGross = finite(price['taxed']);
    const rate = price['tax'];
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      push({ index, code: 'taxMissing' });
    } else {
      const declared = recordOf(price['taxData'])['value'];
      if (typeof declared === 'number' && differs(rate, declared)) {
        push({ index, code: 'taxRateDiffers', pos: rate, server: declared });
      }
      const expected = round2(unitNet * (1 + rate / 100));
      if (differs(unitGross, expected)) {
        push({ index, code: 'lineTotalMismatch', pos: unitGross, server: expected });
      }
    }
    gross += quantity * unitGross * discount;
    net += quantity * unitNet * discount;
  });
  gross = round2(gross);
  net = round2(net);
  const total = finite(sale['finalTotalCheckout']);
  const totals: TotalCheck[] = [];
  const compare = (field: TotalCheck['field'], pos: number, server: number): void => {
    if (differs(pos, server)) {
      totals.push({ field, pos, server: round2(server) });
    }
  };
  if (typeof sale['finalTotalCheckoutWithoutDiscount'] === 'number') {
    compare('totalBeforeDiscount', sale['finalTotalCheckoutWithoutDiscount'], gross);
  }
  const factor = gross === 0 ? 1 : total / gross;
  const adjustment = finite(sale['discountValue']);
  const expectedTotal = sale['adjustmentType'] === 'surcharge' ? gross + adjustment : sale['adjustmentType'] === 'discount' ? gross - adjustment : gross;
  compare('total', total, expectedTotal);
  compare('taxable', finite(sale['finalTotalTaxable']), net * factor);
  compare('tax', finite(sale['finalTotalTax']), (gross - net) * factor);
  const paid = round2(finite(sale['cashAmount']) + finite(sale['electronicAmount']) + finite(sale['chequeAmount']) + finite(sale['ticketsAmount']) + finite(sale['paymentDiscountAmount']) + finite(sale['unpaid']));
  compare('payments', paid, total);
  return { checkedAt: at, status: totals.length === 0 && lines.length === 0 ? 'ok' : 'differences', totals, lines: lines.slice(0, CHECK_MAX_LINES), linesTruncated: lines.length > CHECK_MAX_LINES };
}
