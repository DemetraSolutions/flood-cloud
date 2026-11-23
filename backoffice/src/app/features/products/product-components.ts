import { booleanAttribute, Component, computed, ElementRef, inject, input, model, signal } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { selectionNames } from '../groups/catalogs/reference-loaders';
import { ComponentRow, componentIssues } from './product-model';
import { PRODUCT_LIMITS } from './product.types';

/**
 * The bill of materials of a product: the products it is made of, each with its quantity (in the
 * load unit of the component) and its waste in percent. A component is added by searching the
 * products (never modifiers) on the server. It implements the Signal Forms value control contract
 * (`value`, `disabled`), so it binds to the `ComponentRow[]` of the form model.
 */
@Component({
  selector: 'fc-product-components',
  imports: [Button, SearchCombobox, TextField, TPipe],
  templateUrl: './product-components.html',
  styleUrl: './product-section.css',
})
export class ProductComponents {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly reference = inject(ReferenceApi);
  private readonly i18n = inject(I18nService);

  readonly groupId = input.required<string>();
  /** The components (two-way). */
  readonly value = model<ComponentRow[]>([]);
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-components');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = PRODUCT_LIMITS.components;
  /** Names of the products chosen in this session (the ones read from the server come from `stored`). */
  private readonly chosenNames = signal<Readonly<Record<string, string>>>({});
  private readonly stored = selectionNames(
    () => this.value().map((row) => row.productId),
    (ids) => this.reference.lookupNames(this.groupId(), 'products', ids),
  );
  protected readonly rows = computed(() =>
    this.value().map((row, index) => ({
      row,
      index,
      name: this.chosenNames()[row.productId] ?? this.stored()[row.productId] ?? this.i18n.t('REFERENCE_PICKER.UNKNOWN'),
      issues: componentIssues(row),
    })),
  );
  protected readonly search = (text: string): Promise<readonly SearchOption[]> =>
    this.reference.lookup(this.groupId(), 'products', { q: text, modifier: false, limit: 25 }).then((page) =>
      page.data
        .filter((item) => !this.value().some((row) => row.productId === item.id))
        .map((item) => ({ value: item.id, label: item.name })),
    );

  /** Focuses the first field (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected message(issue: string | undefined): string | null {
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected add(option: SearchOption | null): void {
    if (option === null || this.value().length >= this.limit) {
      return;
    }
    this.chosenNames.update((names) => ({ ...names, [option.value]: option.label }));
    this.value.update((rows) => [...rows, { productId: option.value, quantity: '1', waste: '' }]);
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
  }

  protected change(index: number, change: Partial<ComponentRow>): void {
    this.value.update((rows) => rows.map((row, position) => (position === index ? { ...row, ...change } : row)));
  }
}
