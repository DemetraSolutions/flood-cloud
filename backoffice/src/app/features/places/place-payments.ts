import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/** Most payment types a place can have. */
export const MAX_PAYMENT_TYPES = 50;

/** The codes of the payment method of the electronic invoice (`MP01` to `MP23`). */
export const PAYMENT_MODES: readonly string[] = Array.from(
  { length: 23 },
  (_, index) => `MP${String(index + 1).padStart(2, '0')}`,
);

/**
 * Payments tab of the place: the default payment type and the options, and the payment types the
 * POS offers (their ids are stable: the sales refer to them, so a type keeps its id when edited).
 */
@Component({
  selector: 'fc-place-payments',
  imports: [PlaceFieldsView, RowsEditor, TPipe],
  templateUrl: './place-payments.html',
  styleUrl: './place-section.css',
})
export class PlacePayments {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly rows = this.state.form.payments.paymentTypes;
  protected readonly max = MAX_PAYMENT_TYPES;
  protected readonly columns = computed<RowColumn[]>(() => [
    { key: 'name', type: 'text', label: this.i18n.t('PLACES.PAYMENTS.NAME') },
    { key: 'cash', type: 'flag', label: this.i18n.t('PLACES.PAYMENTS.CASH') },
    { key: 'electronic', type: 'flag', label: this.i18n.t('PLACES.PAYMENTS.ELECTRONIC') },
    { key: 'cheque', type: 'flag', label: this.i18n.t('PLACES.PAYMENTS.CHEQUE') },
    { key: 'tickets', type: 'flag', label: this.i18n.t('PLACES.PAYMENTS.TICKETS') },
    {
      key: 'electronicInvoiceMode',
      type: 'select',
      label: this.i18n.t('PLACES.PAYMENTS.INVOICE_MODE'),
      options: [
        { value: '', label: this.i18n.t('PLACES.NONE') },
        ...PAYMENT_MODES.map((mode) => ({ value: mode, label: mode })),
      ],
    },
  ]);

  protected add(): void {
    this.state.edit('payments', (block) => ({
      ...block,
      paymentTypes: [
        ...block.paymentTypes,
        {
          id: '',
          name: '',
          cash: false,
          electronic: false,
          cheque: false,
          tickets: false,
          electronicInvoiceMode: '',
        },
      ],
    }));
  }

  protected remove(index: number): void {
    this.state.edit('payments', (block) => ({
      ...block,
      paymentTypes: block.paymentTypes.filter((_, at) => at !== index),
    }));
  }
}
