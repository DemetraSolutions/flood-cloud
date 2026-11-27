/**
 * Invoice arithmetic following the SdI calculation rules ("Elenco dei controlli" version 2.1, checks 00421, 00422
 * and 00423): the line total, with discounts and surcharges, and the tax of a summary.
 *
 * All values are exact `Decimal`s; nothing is rounded until a function says so, which is what keeps the figures
 * inside the official tolerances (a cent for `PrezzoTotale` and `Imposta`, a euro for `ImponibileImporto`).
 *
 * @module
 */
import { add, decimal, mul, round, sub } from './decimal.ts';
import type { Decimal } from './decimal.ts';
import type { ScontoMaggiorazione } from './model.ts';

const ONE = decimal(1n);

/** Number of decimal digits of `PrezzoUnitario`, `PrezzoTotale` and `Quantita` (`Amount8DecimalType`). */
export const AMOUNT8_SCALE = 8;
/** Number of decimal digits of `ImponibileImporto`, `Imposta` and the other `Amount2DecimalType` values. */
export const AMOUNT2_SCALE = 2;

/** `percent` percent of `base`, exact (a missing percentage counts as zero). */
function percentOf(base: Decimal, percent: Decimal | undefined): Decimal {
  const product = mul(base, percent ?? decimal(0n));
  return decimal(product.units, product.scale + 2);
}

/**
 * Unit price after a percentage discount: `price x (100 - percent) / 100`, rounded to eight decimals.
 *
 * @param price Net unit price.
 * @param percent Discount in percent (0 to 100).
 * @returns The `PrezzoUnitario` with eight decimals.
 */
export function priceAfterPercent(price: Decimal, percent: Decimal): Decimal {
  return round(percentOf(price, sub(decimal(100n), percent)), AMOUNT8_SCALE);
}

/**
 * Applies the discounts and surcharges of a line, in order, to a unit price (rule of check 00423).
 *
 * Each block acts on the price left by the previous one (cascade): a percentage is computed on the running price,
 * an amount is subtracted (discount) or added (surcharge) as it is. When a block has both `Importo` and
 * `Percentuale` only the amount counts, as in the official example.
 *
 * @param unitPrice Price per unit before any adjustment.
 * @param adjustments Blocks `ScontoMaggiorazione` of the line.
 * @returns The exact unit price after all the adjustments (not rounded).
 */
export function adjustedUnitPrice(unitPrice: Decimal, adjustments: readonly ScontoMaggiorazione[]): Decimal {
  let price = unitPrice;
  for (const adjustment of adjustments) {
    const amount = adjustment.Importo ?? percentOf(price, adjustment.Percentuale);
    price = adjustment.Tipo === 'SC' ? sub(price, amount) : add(price, amount);
  }
  return price;
}

/**
 * Total of a line: `(PrezzoUnitario adjusted) x Quantita`, rounded to eight decimals.
 *
 * @param unitPrice Price per unit before the adjustments.
 * @param quantity Quantity; an absent quantity counts as one (check 00423).
 * @param adjustments Blocks `ScontoMaggiorazione` of the line.
 * @returns The `PrezzoTotale` with eight decimals.
 */
export function lineTotal(unitPrice: Decimal, quantity: Decimal | undefined, adjustments: readonly ScontoMaggiorazione[]): Decimal {
  return round(mul(adjustedUnitPrice(unitPrice, adjustments), quantity ?? ONE), AMOUNT8_SCALE);
}

/**
 * Tax of a VAT summary: `AliquotaIVA x ImponibileImporto / 100` rounded half away from zero to two decimals
 * (check 00421: 1500.2448 gives 1500.24, 1500.2458 gives 1500.25).
 *
 * @param taxable The `ImponibileImporto` as it is written in the summary (already rounded).
 * @param rate The `AliquotaIVA` in percent.
 * @returns The `Imposta` with two decimals.
 */
export function taxAmount(taxable: Decimal, rate: Decimal): Decimal {
  return round(percentOf(taxable, rate), AMOUNT2_SCALE);
}

/**
 * Taxable amount of a VAT summary: the sum of the line totals of the group, rounded to two decimals (check 00422).
 *
 * @param totals The `PrezzoTotale` of every line of the group.
 * @returns The `ImponibileImporto` with two decimals.
 */
export function taxableAmount(totals: readonly Decimal[]): Decimal {
  return round(totals.reduce((sum, total) => add(sum, total), decimal(0n)), AMOUNT2_SCALE);
}
