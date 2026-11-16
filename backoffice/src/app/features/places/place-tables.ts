import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/** Most tip suggestions a place can have. */
export const MAX_TIP_VALUES = 20;

/**
 * Tables tab of the place (rooms and tables of the restaurant): the behavior of the tables, the
 * table groups and the tip suggestions, each an amount or a percentage.
 */
@Component({
  selector: 'fc-place-tables',
  imports: [PlaceFieldsView, PlaceSave, RowsEditor, TPipe],
  templateUrl: './place-tables.html',
  styleUrl: './place-section.css',
})
export class PlaceTables {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly rows = this.state.form.tables.tipValues;
  protected readonly max = MAX_TIP_VALUES;
  protected readonly columns = computed<RowColumn[]>(() => [
    {
      key: 'type',
      type: 'select',
      label: this.i18n.t('PLACES.TABLES.TIP_TYPE'),
      options: [
        { value: 'v', label: this.i18n.t('PLACES.TABLES.TIP_VALUE') },
        { value: 'p', label: this.i18n.t('PLACES.TABLES.TIP_PERCENT') },
      ],
    },
    { key: 'value', type: 'number', label: this.i18n.t('PLACES.TABLES.TIP_AMOUNT') },
  ]);

  protected add(): void {
    this.state.edit('tables', (block) => ({
      ...block,
      tipValues: [...block.tipValues, { type: 'v', value: '' }],
    }));
  }

  protected remove(index: number): void {
    this.state.edit('tables', (block) => ({
      ...block,
      tipValues: block.tipValues.filter((_, at) => at !== index),
    }));
  }
}
