import { Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField, ReadonlyFieldTree } from '@angular/forms/signals';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { TextField } from '../../shared/ui/text-field/text-field';
import { CoreModel } from './product-model';
import { PriceRow, priceSummary } from './product-prices';
import { Costs } from './product.types';

/** Which cost a margin is computed on. */
export type CostBasis = 'SIMPLE' | 'LAST' | 'AVERAGE' | 'WEIGHTED_AVERAGE';

/** The margin of a price rule on a cost: all amounts without tax. */
export interface MarginLine {
  /** Position of the rule in the list, from 1. */
  readonly rule: number;
  readonly basis: CostBasis;
  readonly cost: number;
  /** Net price after the discount. */
  readonly price: number;
  /** Price minus cost. */
  readonly markup: number;
  /** Markup over the cost, in percent; `null` when the cost is zero. */
  readonly markupPercentage: number | null;
  /** Cost over the price, in percent; `null` when the price is zero. */
  readonly foodCostPercentage: number | null;
}

/**
 * The margins of the price rules, as the legacy form showed them: for every rule that has a price
 * and every cost the product has (the simple cost the user types and, with the warehouse, the last,
 * average and weighted average ones), the markup and the food cost.
 *
 * @param rules The price rules of the form.
 * @param costs The costs by basis (`null` for one the product does not have).
 */
export function marginLines(rules: readonly PriceRow[], costs: Readonly<Record<CostBasis, number | null>>): MarginLine[] {
  const bases = Object.keys(costs) as CostBasis[];
  return rules.flatMap((rule, index) => {
    const price = priceSummary(rule).discountedNet;
    return price === null
      ? []
      : bases.flatMap((basis) => {
          const cost = costs[basis];
          return cost === null
            ? []
            : [
                {
                  rule: index + 1,
                  basis,
                  cost,
                  price,
                  markup: price - cost,
                  markupPercentage: cost === 0 ? null : ((price - cost) / cost) * 100,
                  foodCostPercentage: price === 0 ? null : (cost / price) * 100,
                },
              ];
        });
  });
}

/**
 * The margin tab of a product: the simplified cost, which can be edited, and, read only, the
 * markup of every price rule on each cost and, with `rooms`, its food cost.
 */
@Component({
  selector: 'fc-product-margin',
  imports: [FormField, TextField, TPipe],
  templateUrl: './product-margin.html',
  styleUrl: './product-section.css',
})
export class ProductMargin {
  private readonly i18n = inject(I18nService);

  readonly form = input.required<FieldTree<CoreModel>>();
  /** The price rules of the form. */
  readonly prices = input.required<readonly PriceRow[]>();
  /** The costs of the warehouse (read only); absent without the `warehouse` feature. */
  readonly costs = input<Costs | undefined>();
  /** Shows the food cost (`rooms`). */
  readonly rooms = input(false);

  protected readonly lines = computed(() => {
    const simple = this.form().simpleCost().value().trim();
    const costs = this.costs();
    return marginLines(this.prices(), {
      SIMPLE: simple === '' || !Number.isFinite(Number(simple)) ? null : Number(simple),
      LAST: costs?.last ?? null,
      AVERAGE: costs?.average ?? null,
      WEIGHTED_AVERAGE: costs?.weightedAverage ?? null,
    });
  });

  protected error(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  /** A number with two decimals in the language of the user (`''` for none). */
  protected number(value: number | null): string {
    return value === null ? '' : formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
