import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../shared/ui/empty-state/empty-state';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../profile/sessions';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { ActivationsApi } from './activations-api';
import { ActivationsDetail } from './activations-detail';
import {
  ACTION_TEXTS,
  ACTIVATION_TABS,
  ActivationTab,
  isActivationTab,
  ActivationRow,
  ActivationsSummary,
  BillingAction,
  conflictKey,
  currentMonth,
  formatCents,
  isMonth,
  monthLabel,
  monthName,
  NO_DEALER,
  previousMonth,
  yearOf,
} from './activations.types';

/** The summary before it is read: no dealers, no totals, no renewal base. */
const EMPTY_SUMMARY: ActivationsSummary = {
  data: [],
  totals: {
    activations: { places: 0, amountCents: 0, projection12Cents: 0 },
    renewals: { instalmentCents: 0 },
    totalCents: 0,
    anomalies: 0,
  },
  renewalBase: null,
  status: 'open',
};

/**
 * The activations of the month (`/activations`): what Flood invoices each dealer for an
 * invoice month, that is the activations of the month before and the instalment of the renewals
 * of the year. A closed month is read from its closure, an open one is computed live. A
 * dealer sees its own row only. Platform administrators freeze the renewal base of the year and
 * close or reopen the month, each after a confirmation. The month lives in the URL.
 */
@Component({
  selector: 'fc-activations-page',
  imports: [
    ActivationsDetail,
    Button,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    RouterLink,
    StatusBadge,
    TabList,
    TextField,
    TPipe,
  ],
  templateUrl: './activations-page.html',
  styleUrl: './activations-page.css',
})
export class ActivationsPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly api = inject(ActivationsApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** Query parameter (bound by the router). */
  readonly month = input<string>();
  readonly tab = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly dealerId = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** The tab of the URL, the invoices when it is missing or wrong. */
  protected readonly active = computed<ActivationTab>(() => {
    const tab = this.tab();
    return isActivationTab(tab) ? tab : 'invoices';
  });
  protected readonly tabs = computed<TabItem[]>(() =>
    ACTIVATION_TABS.map((id) => ({
      id,
      label: this.i18n.t(`ACTIVATIONS.TAB.${id.toUpperCase()}`),
    })),
  );

  /** The invoice month shown: the one of the URL when valid, the current one otherwise. */
  protected readonly selected = computed(() => {
    const month = this.month();
    return isMonth(month) ? month : currentMonth();
  });
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);

  /** "Riepilogo per rivenditore: fatture di giugno 2026 (attivazioni di maggio 2026)": the table names its months. */
  protected readonly tableTitle = computed(() => {
    const month = this.selected();
    return this.i18n.t('ACTIVATIONS.TABLE', {
      invoice: monthLabel(month, this.language()),
      activity: monthLabel(previousMonth(month), this.language()),
    });
  });

  /** "Fatture di giugno 2026: attivazioni di maggio 2026 e rata di giugno dei rinnovi 2026". */
  protected readonly explanation = computed(() => {
    const month = this.selected();
    return this.i18n.t('ACTIVATIONS.EXPLANATION', {
      invoice: monthLabel(month, this.language()),
      activity: monthLabel(previousMonth(month), this.language()),
      month: monthName(month, this.language()),
      year: yearOf(month),
    });
  });

  /** Read only while the tab of the invoices is shown. */
  protected readonly summary = httpResource<ActivationsSummary>(() =>
    this.active() === 'invoices'
      ? { url: '/v1/activations', params: { month: this.selected() } }
      : undefined,
  );
  /** What the page shows: the summary once read, nothing while it is not. */
  private readonly body = computed<ActivationsSummary>(() =>
    this.summary.hasValue() ? this.summary.value() : EMPTY_SUMMARY,
  );
  protected readonly rows = computed(() => this.body().data);
  protected readonly totals = computed(() => this.body().totals);
  protected readonly renewalBase = computed(() => this.body().renewalBase);
  protected readonly loadError = computed(() => apiErrorOf(this.summary.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  // Actions of the platform administrator.
  protected readonly canManage = computed(() => this.session.can('activations:manage'));
  protected readonly monthClosed = computed(() => this.body().status === 'closed');
  protected readonly baseFrozen = computed(() => this.renewalBase()?.frozen === true);
  protected readonly pending = signal<BillingAction | null>(null);
  protected readonly confirmOpen = signal(false);
  protected readonly busy = signal(false);
  /** Message of the last refused action, `null` when none. */
  protected readonly notice = signal<string | null>(null);
  protected readonly confirmTexts = computed(() => {
    const action = this.pending() ?? 'close';
    const texts = ACTION_TEXTS[action];
    const params = this.actionParams();
    return {
      title: this.i18n.t(texts.title),
      message: this.i18n.t(texts.message, params),
      confirm: this.i18n.t(texts.confirm),
    };
  });

  protected readonly actionTexts = ACTION_TEXTS;
  /** Shown where there is nothing to say. */
  protected readonly dash = '—';

  protected select(tab: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab, cursor: null },
      queryParamsHandling: 'merge',
    });
  }

  protected onMonth(value: string): void {
    if (isMonth(value)) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { month: value },
        queryParamsHandling: 'merge',
      });
    }
  }

  /** The segment of the URL of the statement of a dealer. */
  protected dealerSegment(row: ActivationRow): string {
    return row.dealer.id ?? NO_DEALER;
  }

  protected money(cents: number): string {
    return formatCents(cents, this.language());
  }

  protected number(value: number): string {
    return formatNumber(value, this.language());
  }

  protected baseYear(): number {
    return this.renewalBase()?.year ?? yearOf(this.selected());
  }

  protected ask(action: BillingAction): void {
    this.notice.set(null);
    this.pending.set(action);
    this.confirmOpen.set(true);
  }

  protected async confirm(): Promise<void> {
    const action = this.pending() as BillingAction;
    this.busy.set(true);
    try {
      await this.run(action);
      this.toast.success(this.i18n.t(ACTION_TEXTS[action].done, this.actionParams()));
      this.summary.reload();
    } catch (error) {
      const key = conflictKey(error);
      this.notice.set(key === null ? failureMessage(this.i18n, error) : this.i18n.t(key));
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
  }

  private run(action: BillingAction): Promise<void> {
    switch (action) {
      case 'freeze':
        return this.api.freezeBase(this.baseYear());
      case 'unfreeze':
        return this.api.unfreezeBase(this.baseYear());
      case 'close':
        return this.api.closeMonth(this.selected());
      case 'reopen':
        return this.api.reopenMonth(this.selected());
    }
  }

  private actionParams(): { year: number; month: string } {
    return { year: this.baseYear(), month: monthLabel(this.selected(), this.language()) };
  }
}
