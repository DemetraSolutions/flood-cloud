import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import { ContactGroupApi } from './contact-group-api';
import { ContactGroup, contactGroupRoute } from './contact-group.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['name', 'updatedAt'];
const DEFAULT_SORT = 'name';

/**
 * The groups of contacts of a group (`/groups/:groupId/contact-groups`): name, price list (by
 * name) and discount, with the search by name, the sort and the cursor pagination in the URL.
 * Whoever may write contacts creates a group of contacts; the page of one deletes it.
 */
@Component({
  selector: 'fc-contact-group-list',
  imports: [Can, CellTemplate, CursorPaginator, DataTable, ErrorState, RouterLink, TextField, TPipe],
  templateUrl: './contact-group-list.html',
  styleUrl: './contact-group-list.css',
})
export class ContactGroupList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ContactGroupApi);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly q = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly sortValue = computed(() => {
    const value = this.sort() ?? '';
    return SORT_KEYS.some((key) => value === key || value === `-${key}`) ? value : DEFAULT_SORT;
  });
  protected readonly tableSort = computed<TableSort>(() => {
    const value = this.sortValue();
    return value.startsWith('-') ? { key: value.slice(1), direction: 'desc' } : { key: value, direction: 'asc' };
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return PAGE_SIZES.includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly newRoute = computed(() => contactGroupRoute(this.groupId(), null));

  protected readonly entries = httpResource<ApiPage<ContactGroup>>(() => {
    const params: Record<string, string | number> = { limit: this.pageSize(), sort: this.sortValue() };
    const text = this.q()?.trim();
    if (text) {
      params['q'] = text;
    }
    if (this.cursor()) {
      params['cursor'] = this.cursor() as string;
    }
    return { url: this.api.baseUrl(this.groupId()), params };
  });
  /** The names of the price lists (a failure only leaves the column showing the ids). */
  private readonly priceLists = httpResource<ApiData<{ id: string; name: string }[]>>(
    () => `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/price-lists`,
  );
  private readonly priceListNames = computed(
    () => new Map((this.priceLists.hasValue() ? this.priceLists.value().data : []).map((list) => [list.id, list.name])),
  );

  protected readonly rows = computed(() => (this.entries.hasValue() ? this.entries.value().data : []));
  protected readonly nextCursor = computed(() => (this.entries.hasValue() ? this.entries.value().page.next : null));
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);

  protected readonly columns = computed<TableColumn<ContactGroup>[]>(() => {
    const col = (key: string) => this.i18n.t(`CONTACT_GROUPS.COLUMN.${key}`);
    return [
      { key: 'name', header: col('NAME'), sortable: true },
      {
        key: 'priceList',
        header: col('PRICE_LIST'),
        cell: (row) => (row.priceListId === null ? '' : (this.priceListNames().get(row.priceListId) ?? row.priceListId)),
      },
      {
        key: 'discount',
        header: col('DISCOUNT'),
        align: 'end',
        cell: (row) => (row.discountPercent === null ? '' : formatNumber(row.discountPercent, this.language(), { maximumFractionDigits: 2 })),
      },
    ];
  });
  protected readonly rowKey = (row: ContactGroup): string => row.id;

  protected detailRoute(row: ContactGroup): string[] {
    return contactGroupRoute(this.groupId(), row.id);
  }

  protected reload(): void {
    this.entries.reload();
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onSort(sort: TableSort): void {
    this.change({ sort: sort.direction === 'desc' ? `-${sort.key}` : sort.key });
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
    return this.router.navigate([], { relativeTo: this.route, queryParams: change, queryParamsHandling: 'merge' });
  }
}
