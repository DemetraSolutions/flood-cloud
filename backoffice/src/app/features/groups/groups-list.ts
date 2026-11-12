import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { ActionsMenu } from '../../shared/ui/actions-menu/actions-menu';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { abbreviateId } from '../activity-log/activity-log.types';
import { DealerRecord } from '../dealers/dealer.types';
import { apiErrorOf } from '../profile/sessions';
import { GroupActions } from './group-actions';
import { GroupListItem } from './group.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;
const OBJECT_ID = /^[0-9a-f]{24}$/;
/** Most dealers read to name the dealer of each group (the API limit of a page). */
const DEALERS_LIMIT = 200;

/** Query parameters of the list as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * Groups of the platform (`/groups/list`, PSA and dealers): search, filters (demo; for the PSA
 * also status, trash and dealer), sorting and cursor pagination live in the URL. Opening a row
 * makes it the working group and shows its record; the PSA can also suspend or trash a group
 * from the row menu.
 */
@Component({
  selector: 'fc-groups-list',
  imports: [
    ActionsMenu,
    Button,
    Can,
    CellTemplate,
    Checkbox,
    CursorPaginator,
    DataTable,
    ErrorState,
    GroupActions,
    RouterLink,
    RowActionsTemplate,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './groups-list.html',
  styleUrl: './groups-list.css',
})
export class GroupsList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly context = inject(GroupContext);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Query parameters (bound by the router). */
  readonly q = input<string>();
  readonly demo = input<string>();
  readonly status = input<string>();
  readonly trashed = input<string>();
  readonly dealerId = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** Status, trash and dealer filters (and the dealer column) are for the platform administrator. */
  protected readonly isPlatform = computed(() => this.session.me()?.role === 'PSA');
  protected readonly sortValue = computed(() => (this.sort() === '-name' ? '-name' : 'name'));
  protected readonly tableSort = computed<TableSort>(() => ({
    key: 'name',
    direction: this.sortValue() === '-name' ? 'desc' : 'asc',
  }));
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return PAGE_SIZES.includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly demoOptions = computed(() => [
    { value: 'true', label: this.i18n.t('GROUPS.FILTER.DEMO_ONLY') },
    { value: 'false', label: this.i18n.t('GROUPS.FILTER.NO_DEMO') },
  ]);
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('GROUPS.STATUS.ACTIVE') },
    { value: 'suspended', label: this.i18n.t('GROUPS.STATUS.SUSPENDED') },
  ]);

  private readonly dealers = httpResource<ApiPage<DealerRecord>>(() =>
    this.isPlatform()
      ? {
          url: '/v1/dealers',
          params: { limit: DEALERS_LIMIT, sort: 'businessName' },
        }
      : undefined,
  );
  private readonly dealerList = computed(() =>
    this.dealers.hasValue() ? this.dealers.value().data : [],
  );
  protected readonly dealerOptions = computed(() =>
    this.dealerList().map((dealer) => ({ value: dealer.id, label: dealer.businessName })),
  );

  protected readonly groups = httpResource<ApiPage<GroupListItem>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const platform = this.isPlatform();
    const filters = {
      q: this.q()?.trim(),
      demo: this.demo() === 'true' || this.demo() === 'false' ? this.demo() : undefined,
      status:
        platform &&
        this.status() !== undefined &&
        this.statusOptions().some((option) => option.value === this.status())
          ? this.status()
          : undefined,
      trashed: platform && this.trashed() === 'true' ? 'true' : undefined,
      dealerId: platform && OBJECT_ID.test(this.dealerId() ?? '') ? this.dealerId() : undefined,
      cursor: this.cursor(),
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return { url: '/v1/groups', params };
  });

  protected readonly rows = computed(() => this.groups.value()?.data ?? []);
  protected readonly nextCursor = computed(() => this.groups.value()?.page.next ?? null);
  protected readonly loadError = computed(() => apiErrorOf(this.groups.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly showTrashed = computed(() => this.trashed() === 'true');

  protected readonly columns = computed<TableColumn<GroupListItem>[]>(() => [
    { key: 'name', header: this.i18n.t('GROUPS.COLUMN.NAME'), sortable: true },
    ...(this.isPlatform()
      ? [
          {
            key: 'dealerId',
            header: this.i18n.t('GROUPS.COLUMN.DEALER'),
            hideNarrow: true,
            cell: (row: GroupListItem) => this.dealerName(row),
          },
        ]
      : []),
    { key: 'status', header: this.i18n.t('GROUPS.COLUMN.STATUS') },
    { key: 'demo', header: this.i18n.t('GROUPS.COLUMN.DEMO'), hideNarrow: true },
    ...(this.isPlatform()
      ? [{ key: 'trashed', header: this.i18n.t('GROUPS.COLUMN.TRASH'), hideNarrow: true }]
      : []),
  ]);
  protected readonly rowKey = (row: GroupListItem): string => row.id;

  private dealerName(row: GroupListItem): string {
    if (row.dealerId === null) {
      return '';
    }
    return (
      this.dealerList().find((dealer) => dealer.id === row.dealerId)?.businessName ??
      abbreviateId(row.dealerId)
    );
  }

  /** Makes the group the working group (the page of the group adopts it again once loaded). */
  protected open(row: GroupListItem): void {
    this.context.choose({ id: row.id, name: row.name });
  }

  /** Row action: opens the record of the group. */
  protected openCard(row: GroupListItem): void {
    this.open(row);
    void this.router.navigate(['/groups', row.id, 'settings']);
  }

  protected rowLabel(key: string, row: GroupListItem): string {
    return this.i18n.t(key, { name: row.name });
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onFilter(name: 'demo' | 'status' | 'dealerId', value: string): void {
    this.change({ [name]: value === '' ? null : value });
  }

  protected onTrashed(checked: boolean): void {
    this.change({ trashed: checked ? 'true' : null });
  }

  protected onSort(sort: TableSort): void {
    this.change({ sort: sort.direction === 'desc' ? '-name' : 'name' });
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

  /** Changes a filter: the first page is shown again. */
  private change(change: QueryChange): void {
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
