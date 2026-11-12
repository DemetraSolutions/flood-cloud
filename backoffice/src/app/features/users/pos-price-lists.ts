import {
  booleanAttribute,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import { TPipe } from '../../core/i18n/t-pipe';
import { PosPriceList } from '../../core/users/pos.catalog';
import { uniqueId } from '../../shared/ui/unique-id';

/** A price list of the group the user can be given. */
export interface PriceListChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * Price lists a user can use on the POS: one row per price list of the group with "usable" and
 * the single "default" one (a radio group, at most one). It is a Signal Forms value control over
 * the list of `{ priceListId, enabled, isDefault }` the API stores; entries of price lists that
 * are not among `lists` are kept as they are.
 */
@Component({
  selector: 'fc-pos-price-lists',
  imports: [TPipe],
  templateUrl: './pos-price-lists.html',
  styleUrls: ['./user-section.css', './pos-price-lists.css'],
})
export class PosPriceLists {
  /** Legend of the group (already translated). */
  readonly label = input.required<string>();
  /** Message of a server error on the field. */
  readonly error = input<string | null>(null);
  /** Price lists of the group, with their names. */
  readonly lists = input.required<readonly PriceListChoice[]>();
  /** Stored entries (two-way). */
  readonly value = model<PosPriceList[]>([]);
  /** Disables every control. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Emitted when the focus leaves a control. */
  readonly blurred = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly name = uniqueId('fc-pos-price-list');
  protected readonly rows = computed(() =>
    this.lists().map((list) => {
      const entry = this.value().find((item) => item.priceListId === list.id);
      return {
        id: list.id,
        name: list.name,
        enabled: entry?.enabled === true,
        isDefault: entry?.isDefault === true,
      };
    }),
  );
  protected readonly noDefault = computed(() => !this.value().some((item) => item.isDefault));

  /** Focuses the first control (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected setEnabled(id: string, enabled: boolean): void {
    this.value.update((entries) => {
      const exists = entries.some((item) => item.priceListId === id);
      if (!exists) {
        return [...entries, { priceListId: id, enabled, isDefault: false }];
      }
      return entries.map((item) =>
        item.priceListId === id ? { ...item, enabled, isDefault: enabled && item.isDefault } : item,
      );
    });
  }

  protected setDefault(id: string | null): void {
    this.value.update((entries) =>
      entries.map((item) => ({ ...item, isDefault: item.priceListId === id })),
    );
  }
}
