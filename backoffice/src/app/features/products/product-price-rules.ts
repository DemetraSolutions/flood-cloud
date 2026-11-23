import { booleanAttribute, Component, computed, ElementRef, inject, input, model, signal } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { withCurrent } from '../companies/company-options';
import { GroupTax, taxLabel } from '../product-catalog/product-catalog.types';
import {
  moneyText,
  newPriceRow,
  PriceRow,
  priceIssues,
  priceSummary,
  withTaxRate,
  withWrittenPrice,
} from './product-prices';
import { PRODUCT_LIMITS } from './product.types';

/** The days of the week, Sunday first (the numbers the server stores). */
const WEEK_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The rules of the price of a product, as the legacy form edited them: a card for each with the
 * price list, the currency, the tax rate, the net and gross prices (writing one sets the other
 * and the written one is the one sent), the discount, the validity by date, by time of day and by
 * weekday, the quantities and, read only, the discounted amounts. The rules can be reordered with
 * "up" and "down" buttons (the order is kept: the cash register changes the prices by position)
 * and removed. It implements the Signal Forms value control contract (`value`, `disabled`), so it
 * binds to the `PriceRow[]` of the form model.
 */
@Component({
  selector: 'fc-product-price-rules',
  imports: [Button, Checkbox, Select, TextField, TPipe],
  templateUrl: './product-price-rules.html',
  styleUrl: './product-section.css',
})
export class ProductPriceRules {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);

  /** The rules (two-way). */
  readonly value = model<PriceRow[]>([]);
  /** The price lists to choose from (a rule's list that is not among them is kept). */
  readonly priceLists = input.required<readonly SelectOption[]>();
  /** The currencies to choose from. */
  readonly currencies = input.required<readonly string[]>();
  /** The tax rates of the group. */
  readonly taxes = input.required<readonly GroupTax[]>();
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-price-rules');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = PRODUCT_LIMITS.prices;
  /** Announcement of the last move, for screen readers. */
  protected readonly moved = signal('');
  protected readonly weekDays = computed(() =>
    WEEK_DAYS.map((day) => ({
      day,
      name: new Intl.DateTimeFormat(this.i18n.language() ?? DEFAULT_LANGUAGE, { weekday: 'long' }).format(
        new Date(2024, 0, 7 + day),
      ),
    })),
  );
  private readonly taxOptions = computed<SelectOption[]>(() =>
    this.taxes().map((tax) => ({ value: tax.id, label: taxLabel(tax) })),
  );
  protected readonly rules = computed(() =>
    this.value().map((row, index) => {
      const summary = priceSummary(row);
      return {
        row,
        index,
        issues: priceIssues(row),
        lists: withCurrent(this.priceLists(), row.priceListId, (id) => id),
        currencyOptions: withCurrent(
          this.currencies().map((code) => ({ value: code, label: code })),
          row.currency,
          (code) => code,
        ),
        taxes: withCurrent(this.taxOptions(), row.taxId, (id) => id),
        gross: moneyText(summary.gross),
        discountedNet: moneyText(summary.discountedNet),
        discountedGross: moneyText(summary.discountedGross),
      };
    }),
  );

  /** Focuses the first field (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLElement>('select, input')?.focus();
  }

  protected message(issue: string | undefined): string | null {
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected rateOf(taxId: string): number | null {
    return this.taxes().find((tax) => tax.id === taxId)?.rate ?? null;
  }

  protected add(): void {
    const tax = this.taxes()[0];
    this.value.update((rows) => [
      ...rows,
      newPriceRow(this.priceLists()[0]?.value ?? '', this.currencies()[0] ?? '', tax?.id ?? '', tax?.rate ?? null),
    ]);
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
  }

  protected move(index: number, step: -1 | 1): void {
    this.value.update((rows) => {
      const next = [...rows];
      [next[index], next[index + step]] = [next[index + step], next[index]];
      return next;
    });
    this.moved.set(this.i18n.t('PRODUCTS.PRICES.MOVED', { from: index + 1, to: index + step + 1 }));
  }

  protected change(index: number, change: Partial<PriceRow>): void {
    this.update(index, (row) => ({ ...row, ...change }));
  }

  protected write(index: number, field: 'net' | 'gross', text: string): void {
    this.update(index, (row) => withWrittenPrice(row, field, text, this.rateOf(row.taxId)));
  }

  protected setTax(index: number, taxId: string): void {
    this.update(index, (row) => withTaxRate(row, taxId, this.rateOf(taxId)));
  }

  protected toggleDay(index: number, day: number, on: boolean): void {
    this.update(index, (row) => ({
      ...row,
      weekDays: on ? [...row.weekDays.filter((other) => other !== day), day] : row.weekDays.filter((other) => other !== day),
    }));
  }

  private update(index: number, change: (row: PriceRow) => PriceRow): void {
    this.value.update((rows) => rows.map((row, position) => (position === index ? change(row) : row)));
  }
}
