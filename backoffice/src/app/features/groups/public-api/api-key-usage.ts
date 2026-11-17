import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiData } from '../../../core/api/api.types';
import { apiErrorMessageKey } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { TPipe } from '../../../core/i18n/t-pipe';
import { Button } from '../../../shared/ui/button/button';
import { DataTable } from '../../../shared/ui/data-table/data-table';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { ErrorState } from '../../../shared/ui/error-state/error-state';
import { TextField } from '../../../shared/ui/text-field/text-field';
import { apiErrorOf } from '../../profile/sessions';
import {
  addUtcDays,
  ApiKeyUsage,
  DEFAULT_USAGE_DAYS,
  dailyTotals,
  UsageCounts,
  UsageDay,
  UsageRow,
  usageRangeIssue,
  utcDay,
} from './api-key.types';
import { ApiKeysApi } from './api-keys-api';

const COUNT_COLUMNS = [
  { key: 'calls', header: 'PUBLIC_API.USAGE.CALLS' },
  { key: 'errors4xx', header: 'PUBLIC_API.USAGE.ERRORS_4XX' },
  { key: 'errors5xx', header: 'PUBLIC_API.USAGE.ERRORS_5XX' },
  { key: 'rateLimited', header: 'PUBLIC_API.USAGE.RATE_LIMITED' },
  { key: 'aborted', header: 'PUBLIC_API.USAGE.ABORTED' },
] as const satisfies readonly { key: keyof UsageCounts; header: string }[];

const RANGE_MESSAGES = {
  format: 'PUBLIC_API.USAGE.RANGE_FORMAT',
  incorrect: 'PUBLIC_API.USAGE.RANGE_ORDER',
  maximum: 'PUBLIC_API.USAGE.RANGE_TOO_LONG',
} as const;

/**
 * Usage of a key: a range of days (the last 30 by default, at most 92, UTC days), the totals, the
 * daily totals and the rows per route, as tables. The range is checked here before it is asked
 * for; the counts come in blocks, so the latest seconds may be missing.
 */
@Component({
  selector: 'fc-api-key-usage',
  imports: [Button, DataTable, ErrorState, TextField, TPipe],
  templateUrl: './api-key-usage.html',
  styleUrl: './api-key-usage.css',
})
export class ApiKeyUsagePanel {
  private readonly api = inject(ApiKeysApi);
  protected readonly i18n = inject(I18nService);

  /** Group of the key. */
  readonly groupId = input.required<string>();
  /** The key. */
  readonly keyId = input.required<string>();

  private readonly today = new Date();
  protected readonly from = signal(utcDay(addUtcDays(this.today, 1 - DEFAULT_USAGE_DAYS)));
  protected readonly to = signal(utcDay(this.today));
  private readonly applied = signal({ from: this.from(), to: this.to() });
  protected readonly attempted = signal(false);

  protected readonly issue = computed(() => usageRangeIssue(this.from(), this.to()));
  protected readonly fromError = computed(() => this.rangeError('from'));
  protected readonly toError = computed(() => this.rangeError('to'));

  private readonly resource = httpResource<ApiData<ApiKeyUsage>>(() => ({
    url: `${this.api.url(this.groupId())}/${encodeURIComponent(this.keyId())}/usage`,
    params: this.applied(),
  }));
  protected readonly usage = computed(() =>
    this.resource.hasValue() ? this.resource.value().data : null,
  );
  protected readonly loading = this.resource.isLoading;
  /** Whether the read failed (also for failures that are not API errors). */
  protected readonly loadFailed = computed(() => this.resource.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.resource.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  /** The totals, as label and value pairs (read only when there is a usage to show). */
  protected readonly totals = computed(() => {
    const totals = (this.usage() as ApiKeyUsage).totals;
    return COUNT_COLUMNS.map(({ key, header }) => ({
      key,
      label: this.i18n.t(header),
      value: totals[key],
    }));
  });
  protected readonly days = computed(() => dailyTotals(this.usage()?.rows ?? []));
  protected readonly rows = computed(() => this.usage()?.rows ?? []);

  protected readonly dayColumns = computed<TableColumn<UsageDay>[]>(() => [
    { key: 'day', header: this.i18n.t('PUBLIC_API.USAGE.DAY'), cell: (row) => row.day },
    ...this.countColumns<UsageDay>(),
  ]);
  protected readonly routeColumns = computed<TableColumn<UsageRow>[]>(() => [
    { key: 'day', header: this.i18n.t('PUBLIC_API.USAGE.DAY'), cell: (row) => row.day },
    { key: 'route', header: this.i18n.t('PUBLIC_API.USAGE.ROUTE'), cell: (row) => row.route },
    ...this.countColumns<UsageRow>(),
  ]);
  protected readonly dayKey = (row: UsageDay): string => row.day;
  protected readonly rowKey = (row: UsageRow): string => `${row.day} ${row.route}`;

  protected apply(event: Event): void {
    event.preventDefault();
    this.attempted.set(true);
    if (this.issue() === undefined) {
      this.applied.set({ from: this.from(), to: this.to() });
    }
  }

  protected reload(): void {
    this.resource.reload();
  }

  private rangeError(field: 'from' | 'to'): string | null {
    const issue = this.issue();
    return this.attempted() && issue?.field === field
      ? this.i18n.t(RANGE_MESSAGES[issue.issue])
      : null;
  }

  private countColumns<T extends UsageCounts>(): TableColumn<T>[] {
    return COUNT_COLUMNS.map(({ key, header }) => ({
      key,
      header: this.i18n.t(header),
      cell: (row: T) => String(row[key]),
      align: 'end' as const,
    }));
  }
}
