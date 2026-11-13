import { httpResource } from '@angular/common/http';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Countries } from '../../core/reference/countries';
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
import { apiErrorOf } from '../profile/sessions';
import { CompanyActions } from './company-actions';
import { CompanyListItem, companyRoute } from './company.types';

/** Page sizes offered by the list. */
export const COMPANY_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['name'] as const;
const COUNTRY = /^[A-Z]{2}$/;
const PROVINCE = /^.{1,10}$/;

/** Query parameters of the list as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * Companies of a group (`/groups/:groupId/companies`): search, status, trash, country and
 * province filters and cursor pagination live in the URL, so a view can be shared and survives
 * a reload. Rows offer trash, restore and delete (from the trash only) according to the
 * permissions of the user.
 */
@Component({
  selector: 'fc-companies-list',
  imports: [
    ActionsMenu,
    Button,
    Can,
    CellTemplate,
    Checkbox,
    CompanyActions,
    CursorPaginator,
    DataTable,
    ErrorState,
    RouterLink,
    RowActionsTemplate,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './companies-list.html',
  styleUrl: './companies-list.css',
})
export class CompaniesList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly groups = inject(GroupContext);
  private readonly countries = inject(Countries);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly q = input<string>();
  readonly status = input<string>();
  readonly trashed = input<string>();
  readonly country = input<string>();
  readonly province = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly sortValue = computed(() => {
    const value = this.sort() ?? '';
    return SORT_KEYS.some((key) => value === key || value === `-${key}`) ? value : 'name';
  });
  protected readonly tableSort = computed<TableSort>(() => {
    const value = this.sortValue();
    return value.startsWith('-')
      ? { key: value.slice(1), direction: 'desc' }
      : { key: value, direction: 'asc' };
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (COMPANY_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('COMPANIES.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('COMPANIES.STATUS.DISABLED') },
  ]);
  protected readonly countryOptions = computed(() =>
    this.countries.list().map((country) => ({ value: country.code, label: country.name })),
  );
  protected readonly provinceOptions = computed(() =>
    this.countries
      .areas(this.country() ?? '')
      .map((area) => ({ value: area.code, label: `${area.name} (${area.code})` })),
  );

  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly companies = httpResource<ApiPage<CompanyListItem>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const country = this.country();
    const province = this.province();
    const filters = {
      q: this.q()?.trim(),
      status: this.statusOptions().some((option) => option.value === this.status())
        ? this.status()
        : undefined,
      trashed: this.trashed() === 'true' ? 'true' : undefined,
      country: COUNTRY.test(country ?? '') ? country : undefined,
      province: PROVINCE.test(province ?? '') ? province : undefined,
      cursor: this.cursor(),
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return { url: `/v1/groups/${encodeURIComponent(this.groupId())}/companies`, params };
  });

  protected readonly rows = computed(() =>
    this.companies.hasValue() ? this.companies.value().data : [],
  );
  protected readonly nextCursor = computed(() =>
    this.companies.hasValue() ? this.companies.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.companies.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly showTrashed = computed(() => this.trashed() === 'true');
  protected readonly newRoute = computed(() => ['/groups', this.groupId(), 'companies', 'new']);

  protected readonly columns = computed<TableColumn<CompanyListItem>[]>(() => [
    { key: 'name', header: this.i18n.t('COMPANIES.COLUMN.NAME'), sortable: true },
    {
      key: 'vatNumber',
      header: this.i18n.t('COMPANIES.COLUMN.VAT_NUMBER'),
      cell: (row) => row.vatNumber ?? '',
    },
    {
      key: 'city',
      header: this.i18n.t('COMPANIES.COLUMN.CITY'),
      hideNarrow: true,
      cell: (row) => row.city ?? '',
    },
    {
      key: 'province',
      header: this.i18n.t('COMPANIES.COLUMN.PROVINCE'),
      hideNarrow: true,
      cell: (row) => row.province ?? '',
    },
    {
      key: 'country',
      header: this.i18n.t('COMPANIES.COLUMN.COUNTRY'),
      hideNarrow: true,
      cell: (row) => row.country ?? '',
    },
    { key: 'status', header: this.i18n.t('COMPANIES.COLUMN.STATUS') },
  ]);
  protected readonly rowKey = (row: CompanyListItem): string => row.id;
  protected readonly detailRoute = (row: CompanyListItem): string[] =>
    companyRoute(this.groupId(), row.id);

  /** Whether the user may do anything to a row (otherwise the actions menu is not offered). */
  protected readonly canAct = computed(
    () => this.session.can('companies:trash') || this.session.can('companies:delete'),
  );

  constructor() {
    this.countries.need();
    // The page loaded: the group in the URL becomes the working group of the selector.
    effect(() => {
      const groupId = this.groupId();
      if (this.companies.hasValue()) {
        untracked(() => this.groups.adopt(groupId));
      }
    });
  }

  protected rowLabel(key: string, row: CompanyListItem): string {
    return this.i18n.t(key, { name: row.name });
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onFilter(name: 'status' | 'province', value: string): void {
    this.change({ [name]: value === '' ? null : value });
  }

  /** A province of another country makes no sense: it is dropped with the country. */
  protected onCountry(value: string): void {
    this.change({ country: value === '' ? null : value, province: null });
  }

  protected onTrashed(checked: boolean): void {
    this.change({ trashed: checked ? 'true' : null });
  }

  protected onSort(sort: TableSort): void {
    this.change({ sort: `${sort.direction === 'desc' ? '-' : ''}${sort.key}` });
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

  private navigate(change: QueryChange): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: change,
      queryParamsHandling: 'merge',
    });
  }
}
