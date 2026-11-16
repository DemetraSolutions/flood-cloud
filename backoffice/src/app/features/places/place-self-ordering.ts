import { Component, computed, inject } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { TextField } from '../../shared/ui/text-field/text-field';
import { PriceListConfigRow } from './place-model';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/** Most categories a price list of the self ordering can limit. */
export const MAX_CONFIG_CATEGORIES = 500;

/** The form of the limits of one price list. */
interface ConfigTree {
  roundTime: FieldTree<string>;
  roundMaxProducts: FieldTree<string>;
  totalMaxProducts: FieldTree<string>;
  variants: FieldTree<boolean>;
  freeVariants: FieldTree<boolean>;
  tableAutoClose: FieldTree<boolean>;
  productsCategories: FieldTree<unknown>;
}

/**
 * Self ordering tab of the place: the switch and the messages of the customers' ordering, and the
 * limits of each price list (the products of a round and of the order, the variants, closing the
 * table on its own) with the limits and the position of its categories.
 */
@Component({
  selector: 'fc-place-self-ordering',
  imports: [Button, Checkbox, FormField, PlaceFieldsView, PlaceSave, RowsEditor, TextField, TPipe],
  templateUrl: './place-self-ordering.html',
  styleUrl: './place-section.css',
})
export class PlaceSelfOrdering {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly max = MAX_CONFIG_CATEGORIES;
  protected readonly listsTree = this.state.form.selfOrdering.priceListsConfig;
  protected readonly configs = computed(() => this.state.model().selfOrdering.priceListsConfig);
  protected readonly trees = computed(() => [
    ...(this.listsTree as unknown as Iterable<ConfigTree>),
  ]);
  /** The enabled price lists of the group that have no limits yet. */
  protected readonly available = computed(() =>
    this.state
      .priceLists()
      .filter(
        (priceList) =>
          priceList.enabled && !this.configs().some((config) => config.listId === priceList.id),
      ),
  );
  protected readonly columns = computed<RowColumn[]>(() => [
    {
      key: '_id',
      type: 'select',
      label: this.i18n.t('PLACES.SELF_ORDERING.CATEGORY'),
      options: [
        { value: '', label: this.i18n.t('PLACES.NONE') },
        ...this.state.categories().map((item) => ({ value: item.id, label: item.name })),
      ],
    },
    {
      key: 'roundMaxProducts',
      type: 'number',
      label: this.i18n.t('PLACES.SELF_ORDERING.ROUND_MAX'),
    },
    {
      key: 'totalMaxProducts',
      type: 'number',
      label: this.i18n.t('PLACES.SELF_ORDERING.TOTAL_MAX'),
    },
    { key: 'position', type: 'number', label: this.i18n.t('PLACES.SELF_ORDERING.POSITION') },
    { key: 'purchasable', type: 'flag', label: this.i18n.t('PLACES.SELF_ORDERING.PURCHASABLE') },
  ]);

  constructor() {
    this.state.need('priceLists');
    this.state.need('categories');
  }

  /** The name of a price list of the group, its id when the group no longer has it. */
  protected listName(listId: string): string {
    return this.state.priceLists().find((priceList) => priceList.id === listId)?.name ?? listId;
  }

  protected categoriesLegend(listId: string): string {
    return this.i18n.t('PLACES.SELF_ORDERING.CATEGORIES', { list: this.listName(listId) });
  }

  protected addList(listId: string): void {
    this.state.edit('selfOrdering', (block) => ({
      ...block,
      priceListsConfig: [...block.priceListsConfig, emptyConfig(listId)],
    }));
  }

  protected removeList(index: number): void {
    this.state.edit('selfOrdering', (block) => ({
      ...block,
      priceListsConfig: block.priceListsConfig.filter((_, at) => at !== index),
    }));
  }

  protected addCategory(index: number): void {
    this.changeList(index, (config) => ({
      ...config,
      productsCategories: [
        ...config.productsCategories,
        { _id: '', roundMaxProducts: '', totalMaxProducts: '', position: '', purchasable: true },
      ],
    }));
  }

  protected removeCategory(index: number, category: number): void {
    this.changeList(index, (config) => ({
      ...config,
      productsCategories: config.productsCategories.filter((_, at) => at !== category),
    }));
  }

  private changeList(
    index: number,
    change: (config: PriceListConfigRow) => PriceListConfigRow,
  ): void {
    this.state.edit('selfOrdering', (block) => ({
      ...block,
      priceListsConfig: block.priceListsConfig.map((config, at) =>
        at === index ? change(config) : config,
      ),
    }));
  }
}

function emptyConfig(listId: string): PriceListConfigRow {
  return {
    listId,
    roundTime: '',
    roundMaxProducts: '',
    totalMaxProducts: '',
    variants: false,
    freeVariants: false,
    tableAutoClose: false,
    productsCategories: [],
  };
}
