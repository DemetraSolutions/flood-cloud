import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { EmptyState } from '../../shared/ui/empty-state/empty-state';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { saveFile } from '../diagnostics/diagnostics-api';
import { DealerRecord } from '../dealers/dealer.types';
import { apiErrorOf } from '../profile/sessions';
import { ActivationsApi } from './activations-api';
import { FeeItems } from './fee-items';
import {
  currentMonth,
  DetailLine,
  DetailResponse,
  flagText,
  formatCents,
  isMonth,
  isPeriodInOrder,
  NO_DEALER,
  WARNING_FLAGS,
} from './activations.types';

/** Page sizes offered by the paginator. */
export const DETAIL_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 50;
/** Most dealers read for the filter (the API limit of a page). */
const DEALERS_LIMIT = 100;
const OBJECT_ID = /^[0-9a-f]{24}$/;
/** Shown for a missing value. */
const DASH = '—';

/** The detail before it is read. */
const EMPTY_DETAIL: DetailResponse = {
  data: [],
  page: { limit: DEFAULT_LIMIT, next: null },
  totals: { places: 0, monthlyCents: 0, amountCents: 0, projection12Cents: 0, anomalies: 0 },
  from: null,
  to: '',
  referenceYear: 0,
};

/** Query parameters of the page as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * The detail of all the activations of a period (tab "Dettaglio attivazioni" of
 * `/activations`): every place activated between two months, with the items that make up
 * its monthly fee, the months invoiced, the amount and the projection to 12 months. It is an
 * analysis computed live from the current data and prices, not an invoice. Period and dealer
 * (platform administrators) live in the URL; a wrong period shows a message on its field and the
 * API is not called. The start month is optional: empty, everything from the beginning up to the
 * end month is shown (no `from` in the URL nor in the request), and the period has no maximum
 * length. With no query parameters at all both months are the current one. The same filters drive
 * the CSV.
 */
@Component({
  selector: 'fc-activations-detail',
  imports: [
    Button,
    CursorPaginator,
    EmptyState,
    ErrorState,
    FeeItems,
    RouterLink,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './activations-detail.html',
  styleUrl: './activations-detail.css',
})
export class ActivationsDetail {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly api = inject(ActivationsApi);
  protected readonly i18n = inject(I18nService);

  /** Query parameters (bound by the page). */
  readonly from = input<string>();
  readonly to = input<string>();
  readonly dealerId = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);
  protected readonly pageSizes = DETAIL_PAGE_SIZES;
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (DETAIL_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  /**
   * What the month fields show: the URL. With no `from` the start is empty (everything from the
   * beginning), except on a page opened with no period at all, where it is the current month.
   */
  protected readonly fromText = linkedSignal(
    () => this.from() ?? (this.to() === undefined ? currentMonth() : ''),
  );
  protected readonly toText = linkedSignal(() => this.to() ?? currentMonth());
  protected readonly fromError = computed(() =>
    this.fromText() === '' || isMonth(this.fromText())
      ? null
      : this.i18n.t('ACTIVATIONS.DETAIL.ERROR.MONTH'),
  );
  protected readonly toError = computed(() => {
    if (!isMonth(this.toText())) {
      return this.i18n.t('ACTIVATIONS.DETAIL.ERROR.MONTH');
    }
    const ordered =
      this.fromError() !== null ||
      this.fromText() === '' ||
      isPeriodInOrder(this.fromText(), this.toText());
    return ordered ? null : this.i18n.t('ACTIVATIONS.DETAIL.ERROR.ORDER');
  });
  /** The period to read (`from` only when the start is given), `null` while the fields are not right. */
  private readonly period = computed<Record<string, string> | null>(() => {
    if (this.fromError() !== null || this.toError() !== null) {
      return null;
    }
    const period: Record<string, string> = { to: this.toText() };
    if (this.fromText() !== '') {
      period['from'] = this.fromText();
    }
    return period;
  });

  /** Between group, company and place in the heading of a card. */
  protected readonly separator = '›';

  /** The dealer filter is for platform administrators (the server refuses it to a dealer). */
  protected readonly showDealerFilter = computed(
    () => this.session.me()?.role === 'PSA' && this.session.can('dealers:read'),
  );
  private readonly dealersResource = httpResource<ApiPage<DealerRecord>>(() =>
    this.showDealerFilter()
      ? { url: '/v1/dealers', params: { limit: DEALERS_LIMIT, sort: 'businessName' } }
      : undefined,
  );
  protected readonly dealerOptions = computed(() => [
    ...(this.dealersResource.hasValue() ? this.dealersResource.value().data : []).map((dealer) => ({
      value: dealer.id,
      label: dealer.businessName,
    })),
    { value: NO_DEALER, label: this.i18n.t('ACTIVATIONS.DETAIL.NO_DEALER') },
  ]);

  /** Filters shared by the table and the export; an invalid dealer of the URL is dropped. */
  private readonly filters = computed(() => {
    const period = this.period();
    if (period === null) {
      return null;
    }
    const dealer = this.dealerId() ?? '';
    const result: Record<string, string> = { ...period };
    if (this.showDealerFilter() && (OBJECT_ID.test(dealer) || dealer === NO_DEALER)) {
      result['dealerId'] = dealer;
    }
    return result;
  });

  protected readonly detail = httpResource<DetailResponse>(() => {
    const filters = this.filters();
    if (filters === null) {
      return undefined;
    }
    const params: Record<string, string | number> = { ...filters, limit: this.pageSize() };
    const cursor = this.cursor();
    if (cursor) {
      params['cursor'] = cursor;
    }
    return { url: '/v1/activations/lines', params };
  });
  private readonly body = computed<DetailResponse>(() =>
    this.detail.hasValue() ? this.detail.value() : EMPTY_DETAIL,
  );
  protected readonly lines = computed(() => this.body().data);
  protected readonly totals = computed(() => this.body().totals);
  protected readonly referenceYear = computed(() => this.body().referenceYear);
  protected readonly nextCursor = computed(() => this.body().page.next);
  protected readonly loadError = computed(() => apiErrorOf(this.detail.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    if (error === null) {
      return this.i18n.t('ERRORS.GENERIC.MESSAGE');
    }
    return this.i18n.t(
      error.details.some((detail) => detail.issue === 'tooManyLines')
        ? 'ACTIVATIONS.DETAIL.TOO_MANY_LINES'
        : apiErrorMessageKey(error),
    );
  });

  // Links to the existing pages, where the user may open them.
  protected readonly canGroup = computed(() => this.session.can('groups:read'));
  protected readonly canCompany = computed(() => this.session.can('companies:read'));
  protected readonly canPlace = computed(() => this.session.can('places:read'));

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

  protected onFrom(value: string): void {
    this.fromText.set(value);
    this.syncUrl();
  }

  protected onTo(value: string): void {
    this.toText.set(value);
    this.syncUrl();
  }

  protected onDealer(value: string): void {
    this.change({ dealerId: value === '' ? null : value });
  }

  protected onLimit(limit: number): void {
    this.change({ limit: String(limit) });
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

  /** Downloads the CSV with the filters of the view (never the page or the cursor). */
  protected async download(): Promise<void> {
    this.downloading.set(true);
    this.downloadError.set(null);
    try {
      const filters = this.filters() as Record<string, string>;
      // Same name as the one the server proposes.
      saveFile(
        await this.api.downloadLines(filters),
        `attivazioni-dettaglio_${filters['from'] ?? 'inizio'}_${filters['to']}.csv`,
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

  protected flags(line: DetailLine): { text: string; warning: boolean }[] {
    return line.flags.map((flag) => ({
      text: flagText((key, params) => this.i18n.t(key, params), flag),
      warning: WARNING_FLAGS.has(flag),
    }));
  }

  /** Writes the period to the URL once the months are right (first page again); no start, no `from`. */
  private syncUrl(): void {
    const period = this.period();
    if (period !== null) {
      this.change({ from: period['from'] ?? null, to: period['to'] });
    }
  }

  /** Changes a filter: the first page is shown again. */
  private change(change: QueryChange): void {
    this.cursorStack.set([]);
    void this.navigate({ ...change, cursor: null });
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
  if (status === 409) {
    return 'ACTIVATIONS.DETAIL.DOWNLOAD_ERROR.TOO_MANY_LINES';
  }
  return status === 429
    ? 'ACTIVATIONS.DOWNLOAD_ERROR.TOO_MANY'
    : 'ACTIVATIONS.DOWNLOAD_ERROR.GENERIC';
}
