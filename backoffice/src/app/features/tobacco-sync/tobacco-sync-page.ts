import { httpResource } from '@angular/common/http';
import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { formatDate, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../profile/sessions';
import { TobaccoSyncCounts } from './tobacco-sync-counts';
import { TobaccoSyncDialog } from './tobacco-sync-dialog';
import { countOf, reasonKey, SyncOutcome, SyncStatus } from './tobacco-sync.types';

/**
 * Tools › Sincronizza tabacchi (`/groups/:groupId/tools/tobacco-sync`): the state of the synchronization of the national price list into the tobaccos of the group (the list, the last synchronization, and, when it cannot start, why and what to do),
 * the button that opens the window of the synchronization and the counts of the one just made. After a synchronization the cached lists of products and categories are dropped.
 */
@Component({
  selector: 'fc-tobacco-sync-page',
  imports: [Button, Can, ErrorState, RouterLink, TobaccoSyncCounts, TobaccoSyncDialog, TPipe],
  templateUrl: './tobacco-sync-page.html',
  styleUrl: './tobacco-sync-page.css',
})
export class TobaccoSyncPage {
  private readonly store = inject(ReferenceStore);
  private readonly toast = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly i18n = inject(I18nService);

  /** Route parameter (bound by the router). */
  readonly groupId = input.required<string>();

  protected readonly state = httpResource<ApiData<SyncStatus>>(() => ({
    url: `/v1/groups/${encodeURIComponent(this.groupId())}/tobacco-sync`,
  }));
  protected readonly dialogOpen = signal(false);
  /** The counts of the last synchronization applied from this page. */
  protected readonly done = signal<SyncOutcome | null>(null);
  /** Bumped when a synchronization is applied: the heading of its outcome takes the focus. */
  private readonly focusRequests = signal(0);

  protected readonly loadError = computed(() => apiErrorOf(this.state.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  /** The keys of the texts of the reasons the synchronization cannot start; read only while the state is shown. */
  protected readonly reasonKeys = computed(() =>
    (this.state.value() as ApiData<SyncStatus>).data.reasons.map(reasonKey),
  );
  /** The date and the counts of the last synchronization as a sentence; read only while there is one. */
  protected readonly lastSyncText = computed(() => {
    const last = (this.state.value() as ApiData<SyncStatus>).data.lastSync as NonNullable<
      SyncStatus['lastSync']
    >;
    const counts = last.counts;
    return this.i18n.t('TOBACCO_SYNC.STATUS.LAST_COUNTS', {
      date: this.when(last.at),
      inserted: this.number(countOf(counts, 'inserted')),
      updated: this.number(countOf(counts, 'updated')),
      disabled: this.number(countOf(counts, 'disabled')),
      reactivated: this.number(countOf(counts, 'reactivated')),
      unchanged: this.number(countOf(counts, 'unchanged')),
    });
  });

  constructor() {
    afterRenderEffect(() => {
      if (this.focusRequests() > 0) {
        this.host.nativeElement.querySelector<HTMLElement>('[data-outcome]')?.focus();
      }
    });
  }

  /**
   * A date and time of the log or of the list, in the language of the user.
   *
   * @param iso The ISO date.
   */
  protected when(iso: string): string {
    return formatDate(iso, this.i18n.language() ?? DEFAULT_LANGUAGE, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  protected number(value: number): string {
    return formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }

  /** A synchronization was applied: the counts are shown, the lists cached in memory are dropped and the state is read again. */
  protected onSynced(outcome: SyncOutcome): void {
    this.done.set(outcome);
    this.store.invalidate(this.groupId(), 'product-categories');
    this.store.invalidate(this.groupId(), 'products');
    this.toast.success(
      this.i18n.t('TOBACCO_SYNC.DONE_TOAST', {
        inserted: this.number(outcome.products.inserted),
        updated: this.number(outcome.products.updated),
      }),
    );
    this.state.reload();
    this.focusRequests.update((count) => count + 1);
  }
}
