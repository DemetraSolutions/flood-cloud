import { Location } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, resource } from '@angular/core';
import { Router } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { TPipe } from '../../core/i18n/t-pipe';
import { I18nService } from '../../core/i18n/i18n.service';
import { NonFiscalMode } from '../../core/sales/non-fiscal-mode';
import { ReferenceApi } from '../../core/reference/reference-api';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Icon } from '../../shared/ui/icon/icon';
import { contactRoute } from '../contacts/contact.types';
import { apiErrorOf } from '../profile/sessions';
import { loadSaleNames } from './sale-names';
import { SaleView } from './sale-view';
import { SaleDetail } from './sale.types';

/**
 * One sale of a group (`GET …/sales/{saleId}`, opened from the purchases of a contact): it reads
 * the sale, the currency of the group (its first) and the names of the sale's company and store,
 * and shows them with {@link SaleView}, which also offers the actions on the sale (the page reads
 * the sale again after each one). It has a fixed title. When a new read fails and the sale is
 * already on the page, the sale stays with a warning and a retry (it is no longer certain to be
 * up to date), instead of an error page. After the deletion of a quote the page goes to the
 * purchases of its customer, or to the group.
 */
@Component({
  selector: 'fc-sale-page',
  imports: [Button, ErrorState, Icon, SaleView, TPipe],
  templateUrl: './sale-page.html',
  styleUrl: './sale-page.css',
})
export class SalePage {
  private readonly i18n = inject(I18nService);
  private readonly reference = inject(ReferenceApi);
  private readonly location = inject(Location);
  private readonly mode = inject(NonFiscalMode);
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);

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
  /** The sale read last (of this page: another sale never stands in for it while it loads). */
  protected readonly sale = linkedSignal<SaleDetail | null, SaleDetail | null>({
    source: () => (this.read.hasValue() ? this.read.value().data : null),
    computation: (read, previous) => {
      const kept = previous?.value ?? null;
      return read ?? (kept !== null && kept.id === this.saleId() ? kept : null);
    },
  });
  /** The sale is being read again (after an action, or after an outcome that is not known). */
  protected readonly refreshing = computed(() => this.read.isLoading());
  /** The read failed and there is no sale to show. */
  protected readonly failed = computed(() => this.read.error() !== undefined && this.sale() === null);
  /** A new read failed: the sale shown may be out of date. */
  protected readonly stale = computed(() => this.read.error() !== undefined && this.sale() !== null);
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

  /** The quote is gone: the purchases of its customer, if the user reads the contacts, else the group. */
  protected afterDeletion(): void {
    const customer = this.sale()!.customer;
    const groupId = this.groupId();
    const route =
      customer !== null && this.session.can('contacts:read')
        ? contactRoute(groupId, customer.id)
        : this.session.can('groups:read')
          ? ['/groups', groupId, 'settings']
          : ['/'];
    void this.router.navigate(route);
  }
}
