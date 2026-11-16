import { Component, computed, inject } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { KeyedValues } from './keyed-values';
import { PlaceFieldsView } from './place-fields-view';
import { PlaceSave } from './place-save';
import { PlaceState } from './place-state';
import { RowColumn, RowsEditor } from './rows-editor';

/** Most delivery costs a place can have. */
export const MAX_SHIPPING_COSTS = 50;

/**
 * Take-away and delivery tab of the place: the take-away and delivery options, the price lists
 * of the orders, the delivery costs by distance, the delivery area and the minimum order for each
 * currency of the group.
 */
@Component({
  selector: 'fc-place-delivery',
  imports: [KeyedValues, PlaceFieldsView, PlaceSave, RowsEditor, TPipe],
  templateUrl: './place-delivery.html',
  styleUrl: './place-section.css',
})
export class PlaceDelivery {
  protected readonly state = inject(PlaceState);
  private readonly i18n = inject(I18nService);

  protected readonly rows = this.state.form.delivery.shippingCosts;
  protected readonly max = MAX_SHIPPING_COSTS;
  protected readonly orders = ['TAKE_AWAY', 'ORDERS'];
  protected readonly area = ['AREA'];
  protected readonly columns = computed<RowColumn[]>(() => [
    { key: 'taxed', type: 'number', label: this.i18n.t('PLACES.DELIVERY.COST') },
    { key: 'toKm', type: 'number', label: this.i18n.t('PLACES.DELIVERY.TO_KM') },
  ]);
  protected readonly currencyLabel = (code: string): string => code;

  constructor() {
    this.state.need('currencies');
  }

  protected add(): void {
    this.state.edit('delivery', (block) => ({
      ...block,
      shippingCosts: [...block.shippingCosts, { taxed: '', toKm: '' }],
    }));
  }

  protected remove(index: number): void {
    this.state.edit('delivery', (block) => ({
      ...block,
      shippingCosts: block.shippingCosts.filter((_, at) => at !== index),
    }));
  }
}
