import { booleanAttribute, Component, computed, ElementRef, inject, input, model, resource } from '@angular/core';
import { issueMessageKey } from '../../core/api/field-issues';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi, ReferenceItem } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { uniqueId } from '../../shared/ui/unique-id';
import { SupplierListRow, SupplierRow, supplierIssues, supplierListIssues } from './product-model';
import { Costs, DELIVERY_UNITS, PRODUCT_LIMITS } from './product.types';

/**
 * The suppliers of a product: for each, the contact (chosen with a search the server runs), the code and the name the supplier gives the product, the minimum quantity, the
 * delivery time and its unit, whether it is the favorite one (only one is) and the cost and
 * discounts of each of its price lists; with the warehouse the last, average and weighted average
 * costs of the supplier are shown read only. It implements the Signal Forms value control
 * contract (`value`, `disabled`), so it binds to the `SupplierRow[]` of the form model.
 */
@Component({
  selector: 'fc-product-suppliers',
  imports: [Button, Checkbox, SearchCombobox, Select, TextField, TPipe],
  templateUrl: './product-suppliers.html',
  styleUrl: './product-section.css',
})
export class ProductSuppliers {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly i18n = inject(I18nService);
  private readonly reference = inject(ReferenceApi);

  readonly groupId = input.required<string>();
  /** The suppliers (two-way). */
  readonly value = model<SupplierRow[]>([]);
  /** The costs by supplier (read only). */
  readonly costs = input<Costs | undefined>();
  readonly error = input<string | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly id = uniqueId('fc-product-suppliers');
  protected readonly errorId = `${this.id}-error`;
  protected readonly limit = PRODUCT_LIMITS.suppliers;
  protected readonly units = computed<SelectOption[]>(() =>
    DELIVERY_UNITS.map((unit) => ({ value: unit, label: this.i18n.t(`PRODUCTS.SUPPLIERS.UNIT_${unit.toUpperCase()}`) })),
  );
  /** The suppliers the rows hold, read by id (their names and price lists). */
  private readonly known = resource({
    params: () => {
      const ids = [...new Set(this.value().map((row) => row.contactId.trim()).filter((id) => /^[0-9a-f]{24}$/.test(id)))];
      return ids.length === 0 ? undefined : { groupId: this.groupId(), ids };
    },
    loader: async ({ params }) => {
      const page = await this.reference.lookup(params.groupId, 'suppliers', { ids: params.ids, limit: 100 });
      return new Map<string, ReferenceItem>(page.data.map((item) => [item.id, item]));
    },
  });
  /** The suppliers are searched on the server by name. */
  protected readonly search = (text: string): Promise<readonly SearchOption[]> =>
    this.reference.lookup(this.groupId(), 'suppliers', { q: text, limit: 25 }).then((page) => page.data.map((item) => ({ value: item.id, label: item.name })));
  protected readonly rows = computed(() =>
    this.value().map((row, index) => {
      const cost = this.costs()?.bySupplier[row.contactId];
      const supplier = this.known.hasValue() ? this.known.value().get(row.contactId) : undefined;
      const offered = supplier?.priceLists ?? [];
      return {
        name: supplier === undefined ? null : supplier.name || this.i18n.t('PRODUCTS.SUPPLIERS.NO_NAME'),
        missing: offered.filter((list) => !row.priceLists.some((stored) => stored.id === list.id)),
        offered,
        row,
        index,
        issues: supplierIssues(row),
        lists: row.priceLists.map((list, position) => {
          const found = offered.find((item) => item.id === list.id);
          return {
            list,
            position,
            issues: supplierListIssues(list),
            label: found === undefined ? list.id : found.name || this.i18n.t('PRODUCTS.SUPPLIERS.LIST_NO_NAME'),
            gone: supplier !== undefined && found === undefined,
          };
        }),
        cost:
          cost === undefined
            ? null
            : [
                { key: 'LAST', value: this.number(cost.last) },
                { key: 'AVERAGE', value: this.number(cost.average) },
                { key: 'WEIGHTED_AVERAGE', value: this.number(cost.weightedAverage) },
              ],
      };
    }),
  );

  /** Focuses the first field (used by Signal Forms to focus an invalid field). */
  focus(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus();
  }

  protected message(issue: string | undefined): string | null {
    return issue === undefined ? null : this.i18n.t(issueMessageKey(issue));
  }

  protected add(): void {
    this.value.update((rows) => [
      ...rows,
      {
        contactId: '',
        code: '',
        name: '',
        minQuantity: '',
        deliveryTime: '',
        deliveryTimeUnit: 'days',
        favorite: false,
        priceLists: [],
      },
    ]);
  }

  /** A supplier was chosen (or cleared): its price lists are the ones of the new supplier, so the stored ones go. */
  protected choose(index: number, option: SearchOption | null): void {
    this.change(index, { contactId: option === null ? '' : option.value, priceLists: [] });
  }

  protected addList(index: number, id: string): void {
    this.value.update((rows) =>
      rows.map((row, at) =>
        at === index ? { ...row, priceLists: [...row.priceLists, { id, price: '', discount1: '', discount2: '', discount3: '' }] } : row,
      ),
    );
  }

  protected removeList(index: number, position: number): void {
    this.value.update((rows) =>
      rows.map((row, at) => (at === index ? { ...row, priceLists: row.priceLists.filter((_, listAt) => listAt !== position) } : row)),
    );
  }

  protected remove(index: number): void {
    this.value.update((rows) => rows.filter((_, position) => position !== index));
  }

  protected change(index: number, change: Partial<SupplierRow>): void {
    this.value.update((rows) => rows.map((row, position) => (position === index ? { ...row, ...change } : row)));
  }

  /** Only one supplier is the favorite one. */
  protected setFavorite(index: number, favorite: boolean): void {
    this.value.update((rows) => rows.map((row, position) => ({ ...row, favorite: position === index ? favorite : favorite ? false : row.favorite })));
  }

  protected changeList(index: number, position: number, change: Partial<SupplierListRow>): void {
    this.value.update((rows) =>
      rows.map((row, at) =>
        at === index ? { ...row, priceLists: row.priceLists.map((list, listAt) => (listAt === position ? { ...list, ...change } : list)) } : row,
      ),
    );
  }

  private number(value: number | null): string {
    return value === null ? '' : formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE, { maximumFractionDigits: 6 });
  }
}
