import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { languageName } from '../groups/languages';
import { KeyedValues } from './keyed-values';
import { snake } from './place-fields';
import { PlaceFieldsView } from './place-fields-view';
import { KIOSK_TEXTS } from './place-model';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/** Most categories the kiosk can show. */
export const MAX_KIOSK_CATEGORIES = 500;

/**
 * Kiosk tab of the place: how the kiosk sells (mode, layout, placeholders, payments, receipts),
 * its colors and timeouts, the categories it shows and its five texts for each language of the
 * group.
 */
@Component({
  selector: 'fc-place-kiosk',
  imports: [KeyedValues, PlaceFieldsView, PlaceSave, RowsEditor, TPipe],
  templateUrl: './place-kiosk.html',
  styleUrl: './place-section.css',
})
export class PlaceKiosk {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly rows = this.state.form.kiosk.productsCategories;
  protected readonly max = MAX_KIOSK_CATEGORIES;
  protected readonly texts = KIOSK_TEXTS;
  /** The languages of the group; when the user cannot read the group only the stored ones (and Italian) show. */
  protected readonly languages = computed(() => {
    const languages = this.state.languages();
    return languages.length > 0 ? languages : ['it'];
  });
  protected readonly columns = computed<RowColumn[]>(() => [
    {
      key: '_id',
      type: 'select',
      label: this.i18n.t('PLACES.KIOSK.CATEGORY'),
      options: [
        { value: '', label: this.i18n.t('PLACES.NONE') },
        ...this.state.categories().map((item) => ({ value: item.id, label: item.name })),
      ],
    },
    { key: 'position', type: 'number', label: this.i18n.t('PLACES.KIOSK.POSITION') },
  ]);
  protected readonly languageLabel = (code: string): string =>
    `${languageName(code, this.i18n.language() ?? DEFAULT_LANGUAGE)} (${code})`;

  constructor() {
    this.state.need('categories');
    this.state.need('languages');
  }

  protected textLegend(name: string): string {
    return this.i18n.t(`PLACES.KIOSK.TEXT.${snake(name)}`);
  }

  protected add(): void {
    this.state.edit('kiosk', (block) => ({
      ...block,
      productsCategories: [...block.productsCategories, { _id: '', position: '' }],
    }));
  }

  protected remove(index: number): void {
    this.state.edit('kiosk', (block) => ({
      ...block,
      productsCategories: block.productsCategories.filter((_, at) => at !== index),
    }));
  }
}
