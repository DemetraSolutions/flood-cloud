import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { PlaceState } from './place-state';

/**
 * The map from the product categories of the group to the categories of charge of TS Hospitality
 * (`integrations.tsh.categoriesMap`): one select for each product category, offering the copy of
 * the categories the place keeps (downloaded with the synchronization, never typed). A category
 * left empty has no entry; the entries of categories the user cannot see are kept. It is saved
 * with the integrations of the place.
 */
@Component({
  selector: 'fc-place-tsh-map',
  imports: [Select, TPipe],
  templateUrl: './place-tsh-map.html',
  styleUrl: './place-section.css',
})
export class PlaceTshMap {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  private readonly copy = computed(() => this.state.model().integrations.tshCategories);
  private readonly map = computed(() => this.state.model().integrations.tshMap);

  /** Whether the place has downloaded the categories of TS Hospitality. */
  protected readonly hasCopy = computed(() => this.copy().length > 0);

  /** One row for each product category, with the select options (the stored value always among them). */
  protected readonly rows = computed(() =>
    this.state.categories().map((category) => {
      const value = this.map()[category.id] ?? '';
      const options: SelectOption[] = this.copy().map((item) => ({
        value: item.id,
        label: item.name,
      }));
      if (value !== '' && !options.some((option) => option.value === value)) {
        options.push({ value, label: this.i18n.t('INTEGRATIONS.TSH_MAP.UNKNOWN', { name: value }) });
      }
      return { id: category.id, name: category.name, value, options };
    }),
  );

  constructor() {
    this.state.need('categories');
  }

  protected set(categoryId: string, value: string): void {
    this.state.edit('integrations', (block) => {
      const { [categoryId]: _previous, ...others } = block.tshMap;
      void _previous;
      return { ...block, tshMap: value === '' ? others : { ...others, [categoryId]: value } };
    });
  }
}
