import { Location } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, resource } from '@angular/core';
import { ApiData } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { TPipe } from '../../core/i18n/t-pipe';
import { I18nService } from '../../core/i18n/i18n.service';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { ReferenceApi } from '../../core/reference/reference-api';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { apiErrorOf } from '../profile/sessions';
import { loadSaleNames } from './sale-names';
import { SaleView } from './sale-view';
import { SaleDetail } from './sale.types';

/**
 * One sale of a group, read only (`GET …/sales/{saleId}`, opened from the purchases of a contact):
 * it reads the sale, the currency of the group (its first) and the names of the sale's company and
 * store, and shows them with {@link SaleView}. It has a fixed title and never writes.
 */
@Component({
  selector: 'fc-sale-page',
  imports: [Button, ErrorState, SaleView, TPipe],
  templateUrl: './sale-page.html',
})
export class SalePage {
  private readonly i18n = inject(I18nService);
  private readonly reference = inject(ReferenceApi);
  private readonly location = inject(Location);
  private readonly mode = inject(NonFiscalMode);

  /** Route parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly saleId = input.required<string>();

  // A non fiscal sale is only found while the UM mode is on; the page reads again when it changes.
  private readonly read = httpResource<ApiData<SaleDetail>>(() => ({
    url: `/v1/groups/${encodeURIComponent(this.groupId())}/sales/${encodeURIComponent(this.saleId())}`,
    ...(this.mode.nonFiscalVisible() ? { params: { nonFiscal: 'include' } } : {}),
  }));
  private readonly currencies = httpResource<ApiData<{ code: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/currencies`,
  );
  protected readonly sale = computed(() => (this.read.hasValue() ? this.read.value().data : null));
  protected readonly failed = computed(() => this.read.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.read.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  private readonly namesRead = resource({
    params: () => {
      const sale = this.sale();
      return sale === null ? undefined : { groupId: this.groupId(), sale };
    },
    loader: ({ params }) => loadSaleNames(this.reference, params.groupId, [params.sale]),
  });
  protected readonly names = computed(() => (this.namesRead.hasValue() ? this.namesRead.value() : null));
  protected readonly currency = computed(() =>
    this.currencies.hasValue() ? (this.currencies.value().data[0]?.code ?? 'EUR') : 'EUR',
  );

  protected reload(): void {
    this.read.reload();
  }

  protected back(): void {
    this.location.back();
  }
}
