import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/** Most shift names the cash settings can have. */
export const MAX_WORKSHIFT_NAMES = 20;

/**
 * "Impostazioni generali" of the settings menu: the behavior of the POS (login, cart, shifts,
 * receipts, warehouse and report) and the names of the work shifts.
 */
@Component({
  selector: 'fc-place-cash',
  imports: [PlaceFieldsView, RowsEditor, TPipe],
  templateUrl: './place-cash.html',
  styleUrl: './place-section.css',
})
export class PlaceCash {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly rows = this.state.form.cashSettings.workshiftNames;
  protected readonly max = MAX_WORKSHIFT_NAMES;
  protected readonly columns = computed<RowColumn[]>(() => [
    { key: 'name', type: 'text', label: this.i18n.t('PLACES.CASH.SHIFT_NAME') },
  ]);

  protected add(): void {
    this.state.edit('cashSettings', (block) => ({
      ...block,
      workshiftNames: [...block.workshiftNames, { name: '' }],
    }));
  }

  protected remove(index: number): void {
    this.state.edit('cashSettings', (block) => ({
      ...block,
      workshiftNames: block.workshiftNames.filter((_, at) => at !== index),
    }));
  }
}
