import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { EmptyState } from '../../shared/ui/empty-state/empty-state';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { saveFile } from '../diagnostics/diagnostics-api';
import { SERVICE_KEYS, SERVICE_LABEL_KEYS } from '../price-list/price-list.types';
import { apiErrorOf } from '../profile/sessions';
import { ActivationsApi } from './activations-api';
import { FeeItems } from './fee-items';
import {
  currentMonth,
  flagText,
  formatCents,
  groupLines,
  isMonth,
  isSection,
  monthLabel,
  monthName,
  previousMonth,
  StatementLine,
  StatementResponse,
  StatementSection,
  STATEMENT_SECTIONS,
  WARNING_FLAGS,
  yearOf,
} from './activations.types';

/** Page sizes offered by the paginator. */
export const STATEMENT_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 50;
/** The statement before it is read. */
const EMPTY_STATEMENT: StatementResponse = {
  data: [],
  page: { limit: DEFAULT_LIMIT, next: null },
  dealer: { id: null, name: '' },
  status: 'open',
  renewalBase: { year: 0, frozen: false },
  totals: { places: 0, amountCents: 0 },
  prices: { plans: {}, services: {} },
};
/** Shown for a missing value. */
const DASH = '—';

/** Query parameters of the page as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * The statement of a dealer for an invoice month (`/activations/:dealerId`): two tabs, the
 * activations of the month before and the instalment of the renewals. The lines are grouped by
 * group and company; each place shows its activation date, plan, the items of its monthly fee
 * as chips, the fee, the months invoiced, the amount, the projection to 12 months and the
 * notes on the place. Tab, month and cursor live in the URL; the CSV has the lines of the
 * tab. The layout prints cleanly.
 */
@Component({
  selector: 'fc-statement-page',
  imports: [
    Button,
    CursorPaginator,
    EmptyState,
    ErrorState,
    FeeItems,
    RouterLink,
    StatusBadge,
    TabList,
    TPipe,
  ],
  templateUrl: './statement-page.html',
  styleUrl: './statement-page.css',
})
export class StatementPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ActivationsApi);
  protected readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly dealerId = input.required<string>();
  readonly month = input<string>();
  readonly section = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly selected = computed(() => {
    const month = this.month();
    return isMonth(month) ? month : currentMonth();
  });
  /** The section of the URL when valid, the activations otherwise. */
  protected readonly active = computed<StatementSection>(() => {
    const section = this.section();
    return isSection(section) ? section : 'activations';
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (STATEMENT_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly pageSizes = STATEMENT_PAGE_SIZES;

  protected readonly tabs = computed<TabItem[]>(() =>
    STATEMENT_SECTIONS.map((id) => ({
      id,
      label: this.i18n.t(`ACTIVATIONS.STATEMENT.TAB.${id.toUpperCase()}`),
    })),
  );
  /** What the tab shows, in words. */
  protected readonly intro = computed(() => {
    const month = this.selected();
    return this.active() === 'activations'
      ? this.i18n.t('ACTIVATIONS.STATEMENT.INTRO.ACTIVATIONS', {
          activity: monthLabel(previousMonth(month), this.language()),
        })
      : this.i18n.t('ACTIVATIONS.STATEMENT.INTRO.RENEWALS', {
          month: monthName(month, this.language()),
          year: yearOf(month),
        });
  });
  protected readonly invoiceMonth = computed(() => monthLabel(this.selected(), this.language()));

  protected readonly statement = httpResource<StatementResponse>(() => {
    const params: Record<string, string | number> = {
      month: this.selected(),
      section: this.active(),
      limit: this.pageSize(),
    };
    const cursor = this.cursor();
    if (cursor) {
      params['cursor'] = cursor;
    }
    return {
      url: `/v1/activations/statements/${encodeURIComponent(this.dealerId())}`,
      params,
    };
  });
  /** What the page shows: the statement once read, nothing while it is not. */
  private readonly body = computed<StatementResponse>(() =>
    this.statement.hasValue() ? this.statement.value() : EMPTY_STATEMENT,
  );
  protected readonly loaded = computed(() => this.statement.hasValue());
  protected readonly dealerName = computed(() =>
    this.loaded() ? this.body().dealer.name : this.i18n.t('ACTIVATIONS.STATEMENT.DEALER'),
  );
  protected readonly status = computed(() => this.body().status);
  protected readonly lines = computed(() => this.body().data);
  protected readonly blocks = computed(() => groupLines(this.lines()));
  protected readonly totals = computed(() => this.body().totals);
  protected readonly nextCursor = computed(() => this.body().page.next);
  /** The prices applied, as the lines to show. */
  protected readonly prices = computed(() => {
    const prices = this.body().prices;
    const plans = Object.keys(prices.plans)
      .sort((a, b) => a.localeCompare(b, 'it'))
      .map((key) => ({
        name: this.i18n.t('ACTIVATIONS.ITEM.PLAN', { plan: key }),
        cents: prices.plans[key],
      }));
    const services = SERVICE_KEYS.filter((key) => Object.hasOwn(prices.services, key)).map(
      (key) => ({ name: this.i18n.t(SERVICE_LABEL_KEYS[key]), cents: prices.services[key] }),
    );
    return [...plans, ...services];
  });
  protected readonly loadError = computed(() => apiErrorOf(this.statement.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  /** `true` while the CSV is being downloaded. */
  protected readonly downloading = signal(false);
  /** Dictionary key of the message of the last failed download, `null` when none. */
  protected readonly downloadError = signal<string | null>(null);
  protected readonly downloadStatus = computed(() => {
    const key = this.downloadError();
    if (key !== null) {
      return this.i18n.t(key);
    }
    return this.downloading() ? this.i18n.t('ACTIVATIONS.DOWNLOADING') : '';
  });

  protected select(section: string): void {
    this.cursorStack.set([]);
    void this.navigate({ section, cursor: null });
  }

  protected onLimit(limit: number): void {
    this.cursorStack.set([]);
    void this.navigate({ limit: String(limit), cursor: null });
  }

  protected onNext(cursor: string): void {
    this.cursorStack.update((stack) => [...stack, this.cursor() ?? null]);
    void this.navigate({ cursor });
  }

  protected onPrevious(): void {
    const stack = this.cursorStack();
    this.cursorStack.set(stack.slice(0, -1));
    void this.navigate({ cursor: stack[stack.length - 1] });
  }

  protected print(): void {
    window.print();
  }

  /** Downloads the CSV of the lines of the tab (never the page or the cursor). */
  protected async download(): Promise<void> {
    this.downloading.set(true);
    this.downloadError.set(null);
    try {
      saveFile(
        await this.api.downloadStatement(this.dealerId(), this.selected(), this.active()),
        `activations_${this.dealerId()}_${this.selected()}_${this.active()}.csv`,
      );
    } catch (error) {
      this.downloadError.set(downloadErrorKey(error));
    } finally {
      this.downloading.set(false);
    }
  }

  protected money(cents: number): string {
    return formatCents(cents, this.language());
  }

  protected number(value: number): string {
    return formatNumber(value, this.language());
  }

  /** The activation date in Italy, or a dash when the backend sent something that is not a date. */
  protected day(value: string): string {
    return Number.isNaN(Date.parse(value))
      ? DASH
      : formatDate(value, this.language(), { dateStyle: 'medium', timeZone: 'Europe/Rome' });
  }

  protected flags(line: StatementLine): { text: string; warning: boolean }[] {
    return line.flags.map((flag) => ({
      text: flagText((key, params) => this.i18n.t(key, params), flag),
      warning: WARNING_FLAGS.has(flag),
    }));
  }

  protected priceText(price: { name: string; cents: number }): string {
    return `${price.name}: ${this.money(price.cents)}`;
  }

  private navigate(change: QueryChange): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: change,
      queryParamsHandling: 'merge',
    });
  }
}

/** Dictionary key of the message for a failed download, by HTTP status (the body is a blob). */
function downloadErrorKey(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 413) {
    return 'ACTIVATIONS.DOWNLOAD_ERROR.TOO_LARGE';
  }
  return status === 429
    ? 'ACTIVATIONS.DOWNLOAD_ERROR.TOO_MANY'
    : 'ACTIVATIONS.DOWNLOAD_ERROR.GENERIC';
}
