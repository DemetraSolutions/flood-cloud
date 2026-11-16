import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { groupsOf } from './place-fields';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/** Most time blocks the reservations can have. */
export const MAX_TIME_BLOCKS = 50;

/**
 * Reservations tab of the place: whether tables can be reserved, for how long, the time blocks
 * of the week, "suspended today" (the POS also writes it), the web widget and the five emails of
 * the reservation, each with its template.
 */
@Component({
  selector: 'fc-place-reservations',
  imports: [PlaceFieldsView, PlaceSave, RowsEditor, TPipe],
  templateUrl: './place-reservations.html',
  styleUrl: './place-section.css',
})
export class PlaceReservations {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly rows = this.state.form.reservations.timeBlocks;
  protected readonly max = MAX_TIME_BLOCKS;
  protected readonly general = ['GENERAL'];
  protected readonly others = groupsOf('reservations').filter((group) => group !== 'GENERAL');
  protected readonly columns = computed<RowColumn[]>(() => [
    { key: 'weekDays', type: 'days', label: this.i18n.t('PLACES.RESERVATIONS.WEEK_DAYS') },
    { key: 'start', type: 'time', label: this.i18n.t('PLACES.RESERVATIONS.START') },
    { key: 'end', type: 'time', label: this.i18n.t('PLACES.RESERVATIONS.END') },
  ]);

  protected add(): void {
    this.state.edit('reservations', (block) => ({
      ...block,
      timeBlocks: [...block.timeBlocks, { weekDays: [], start: '', end: '' }],
    }));
  }

  protected remove(index: number): void {
    this.state.edit('reservations', (block) => ({
      ...block,
      timeBlocks: block.timeBlocks.filter((_, at) => at !== index),
    }));
  }
}
