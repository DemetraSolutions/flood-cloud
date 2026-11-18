import { Component, computed, inject, input } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { FeeItem, feeItemName, formatCents, PlaceDevices } from './activations.types';

/**
 * How the monthly fee of a place is made: one row per active item with its name, quantity (when
 * above one), unit price and amount (items at zero are shown too, a plan with no price says so),
 * an informational row with the devices when known, and the total "Canone mensile".
 */
@Component({
  selector: 'fc-fee-items',
  imports: [TPipe],
  templateUrl: './fee-items.html',
  styleUrl: './fee-items.css',
})
export class FeeItems {
  private readonly i18n = inject(I18nService);

  /** Items of the fee. */
  readonly items = input.required<readonly FeeItem[]>();
  /** Monthly fee of the place, in cents. */
  readonly monthlyCents = input.required<number>();
  /** Devices of the place, when the backend knows them. */
  readonly devices = input<PlaceDevices>();

  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);
  protected readonly rows = computed(() =>
    this.items().map((item) => ({
      name: feeItemName((key, params) => this.i18n.t(key, params), item),
      quantity: item.quantity > 1 ? `×${item.quantity}` : '',
      unit:
        item.unitCents === null
          ? this.i18n.t('ACTIVATIONS.ITEM.UNPRICED')
          : this.money(item.unitCents),
      amount: this.money(item.amountCents),
    })),
  );
  protected readonly total = computed(() => this.money(this.monthlyCents()));

  private money(cents: number): string {
    return formatCents(cents, this.language());
  }
}
