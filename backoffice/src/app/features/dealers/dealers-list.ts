import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import { DealerRecord } from './dealer.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;

/**
 * Dealers (`/dealers`, PSA only): company name, VAT number, location and the linked `D` user.
 * Search, sorting and cursor pagination live in the URL.
 */
@Component({
  selector: 'fc-dealers-list',
  imports: [
    CellTemplate,
    CursorPaginator,
    DataTable,
    ErrorState,
    RouterLink,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './dealers-list.html',
  styleUrl: './dealers-list.css',
})
export class DealersList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Query parameters (bound by the router). */
  readonly q = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** A dealer is created together with its user: both permissions are needed. */
  protected readonly canCreate = computed(
    () => this.session.can('dealers:create') && this.session.can('users:create'),
  );
  protected readonly sortValue = computed(() => {
    const value = this.sort();
    return value === '-businessName' ? value : 'businessName';
  });
  protected readonly tableSort = computed<TableSort>(() => ({
    key: 'businessName',
    direction: this.sortValue().startsWith('-') ? 'desc' : 'asc',
  }));
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return PAGE_SIZES.includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly dealers = httpResource<ApiPage<DealerRecord>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const text = this.q()?.trim();
    if (text) {
      params['q'] = text;
    }
    if (this.cursor()) {
      params['cursor'] = this.cursor() as string;
    }
    return { url: '/v1/dealers', params };
  });

  protected readonly rows = computed(() => this.dealers.value()?.data ?? []);
  protected readonly nextCursor = computed(() => this.dealers.value()?.page.next ?? null);
  protected readonly loadError = computed(() => apiErrorOf(this.dealers.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<DealerRecord>[]>(() => [
    { key: 'businessName', header: this.i18n.t('DEALERS.COLUMN.NAME'), sortable: true },
    {
      key: 'vatNumber',
      header: this.i18n.t('DEALERS.COLUMN.VAT'),
      hideNarrow: true,
      cell: (r) => r.vatNumber ?? '',
    },
    {
      key: 'location',
      header: this.i18n.t('DEALERS.COLUMN.LOCATION'),
      hideNarrow: true,
      cell: (r) => this.location(r),
    },
    { key: 'user', header: this.i18n.t('DEALERS.COLUMN.USER') },
    { key: 'status', header: this.i18n.t('DEALERS.COLUMN.STATUS') },
  ]);
  protected readonly rowKey = (row: DealerRecord): string => row.id;

  private location(row: DealerRecord): string {
    const city = row.address?.city ?? '';
    const province = row.address?.province;
    return province ? `${city} (${province})` : city;
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onSort(sort: TableSort): void {
    this.change({ sort: sort.direction === 'desc' ? '-businessName' : 'businessName' });
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

  private change(change: Record<string, string | null>): void {
    this.cursorStack.set([]);
    void this.navigate({ ...change, cursor: null });
  }

  private navigate(change: Record<string, string | null | undefined>): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: change,
      queryParamsHandling: 'merge',
    });
  }
}
