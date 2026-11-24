import type { PriceView } from '../products/products.pricing.ts';
import { PRICE_SLOTS } from './catalog-xlsx.columns.ts';

/**
 * The rule of a price list the workbook represents: a price list can hold several rules of one product (by quantity, by period, by day), but a row of the workbook has one price per list, so the one that
 * applies always (a minimum quantity of 1, no dates, no days, no time of day) is the one, or else the first of the list. Export and import choose it the same way, so a price that is exported and imported
 * again is the same rule; the others are never touched.
 *
 * @param prices The prices of the product, in their stored order.
 * @param listId The price list.
 * @returns The index in `prices` of the rule, `-1` when the product has none in that list.
 */
export function baseRuleIndex(prices: readonly PriceView[], listId: string): number {
  const inList = prices.flatMap((price, index) => (price.priceListId === listId ? [index] : []));
  const always = inList.find((index) => {
    const price = prices[index]!;
    return price.fromQuantity === 1 && price.validFrom === null && price.validTo === null && price.dailyFrom === null && price.dailyTo === null && price.weekDays.length === 0;
  });
  return always ?? inList[0] ?? -1;
}

/**
 * The prices a row of the workbook shows: the rule of each price list the product has, in the order the lists first appear in its prices, at most {@link PRICE_SLOTS}. The prices beyond the fifteenth list and the
 * rules that are not the one of their list are not in the row (and stay as they are when the row is imported).
 *
 * @param prices The prices of the product, in their stored order.
 */
export function representedPrices(prices: readonly PriceView[]): PriceView[] {
  const lists = [...new Set(prices.flatMap((price) => price.priceListId ?? []))].slice(0, PRICE_SLOTS);
  return lists.map((listId) => prices[baseRuleIndex(prices, listId)]!);
}
