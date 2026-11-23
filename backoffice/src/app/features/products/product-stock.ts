import { booleanAttribute, Component, computed, effect, ElementRef, inject, input, model, signal, untracked } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceItem } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { PlaceSetupReader } from '../product-categories/category-place-setup';
import { stockIssues, StockRow } from './product-model';
import { Costs, StockByPlace } from './product.types';

/** The cost of a product in one of its forms, for the summary. */
interface CostFact {
  readonly key: 'LAST' | 'AVERAGE' | 'WEIGHTED_AVERAGE';
  readonly value: number | null;
}

/**
 * The stock of a product, store by store and storage by storage: the quantity (read only: the
 * warehouse moves it) and the minimum, maximum and location, which can be edited. A summary
 * shows the total quantity and the costs (last, average, weighted average and the last supplier),
 * all read only. The storages of a store are read only when its section is opened (or it already
 * has a limit). It implements the Signal Forms value control contract (`value`, `disabled`), so it
 * binds to the `StockRow[]` of the form model; rows of stores that are not listed are kept.
 */
@Component({
  selector: 'fc-product-stock',
  imports: [Button, TextField, TPipe],
  templateUrl: './product-stock.html',
  styleUrl: './product-section.css',
})
export class ProductStock {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly reader = inject(PlaceSetupReader);
  private readonly i18n = inject(I18nService);

  readonly groupId = input.required<string>();
  /** The stores to choose from. */
  readonly places = input.required<readonly ReferenceItem[]>();
  /** The limits of the storages (two-way). */
  readonly value = model<StockRow[]>([]);
  /** The quantities as the server has them (read only). */
  readonly quantities = input<StockByPlace>({});
  /** The costs as the server has them (read only). */
  readonly costs = input<Costs | undefined>();
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-stock');
  protected readonly errorId = `${this.id}-error`;
  protected readonly states = this.reader.states;
  /** The stores whose section is open. */
  protected readonly opened = signal<ReadonlySet<string>>(new Set());
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);
  /** The total quantity of the stores listed (the ones the user reaches). */
  protected readonly total = computed(() => {
    const quantities = Object.values(this.quantities()).flatMap((storages) =>
      Object.values(storages).flatMap((entry) => (entry.quantity === null ? [] : [entry.quantity])),
    );
    return quantities.length === 0 ? null : quantities.reduce((sum, quantity) => sum + quantity, 0);
  });
  protected readonly costFacts = computed<CostFact[]>(() => {
    const costs = this.costs();
    return costs === undefined
      ? []
      : [
          { key: 'LAST', value: costs.last },
          { key: 'AVERAGE', value: costs.average },
          { key: 'WEIGHTED_AVERAGE', value: costs.weightedAverage },
        ];
  });

  constructor() {
    // The stores that already have a limit start open.
    effect(() => {
      const rows = this.value();
      const quantities = this.quantities();
      const chosen = this.places()
        .map((place) => place.id)
        .filter((id) => rows.some((row) => row.placeId === id) || id in quantities);
      untracked(() => this.opened.update((current) => new Set([...current, ...chosen])));
    });
    // The storages of an open store are read once.
    effect(() => {
      const groupId = this.groupId();
      const opened = this.opened();
      untracked(() => opened.forEach((placeId) => this.reader.load(groupId, placeId)));
    });
  }

  /** Focuses the summary of the first store (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLElement>('summary')?.focus();
  }

  protected numberText(value: number | null): string {
    return value === null ? '' : formatNumber(value, this.language(), { maximumFractionDigits: 6 });
  }

  protected quantityOf(placeId: string, storageId: string): string {
    return this.numberText(this.quantities()[placeId]?.[storageId]?.quantity ?? null);
  }

  protected rowOf(placeId: string, storageId: string): StockRow {
    return (
      this.value().find((row) => row.placeId === placeId && row.storageId === storageId) ?? {
        placeId,
        storageId,
        min: '',
        max: '',
        location: '',
      }
    );
  }

  protected message(placeId: string, storageId: string, field: 'min' | 'max' | 'location'): string | null {
    const issue = stockIssues(this.rowOf(placeId, storageId))[field];
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected change(placeId: string, storageId: string, change: Partial<StockRow>): void {
    const next = { ...this.rowOf(placeId, storageId), ...change };
    this.value.update((rows) =>
      rows.some((row) => row.placeId === placeId && row.storageId === storageId)
        ? rows.map((row) => (row.placeId === placeId && row.storageId === storageId ? next : row))
        : [...rows, next],
    );
  }

  protected onToggle(placeId: string, event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.opened.update((current) => {
      const next = new Set(current);
      if (open) {
        next.add(placeId);
      } else {
        next.delete(placeId);
      }
      return next;
    });
  }

  protected retry(placeId: string): void {
    this.reader.load(this.groupId(), placeId);
  }
}
