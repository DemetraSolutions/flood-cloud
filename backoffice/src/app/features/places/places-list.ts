import { httpResource } from '@angular/common/http';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  resource,
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
import { ReferenceStore } from '../../core/reference/reference-store';
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
import { CrossGroupFilterChange, CrossGroupFilters } from '../groups/cross-group-filters';
import { loadAll } from './lookup-loader';
import { PlaceActionResult, PlaceActions } from './place-actions';
import { PlaceRenewal } from './place-renewal';
import { PlaceListItem, placeRoute, PLANS } from './place.types';

/** Page sizes offered by the list. */
export const PLACE_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['name', 'expirationDate'] as const;
const COUNTRY = /^[A-Z]{2}$/;
const PROVINCE = /^.{1,10}$/;
const PLAN = /^[A-Za-z0-9_-]{1,30}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;

/** Query parameters of the list as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * Places of a group (`/groups/:groupId/places`) or, for a PSA or dealer with no working group,
 * of every group in their scope (`/places`, route data `scope: 'all'`: `groupId` and `dealerId`
 * are then query filters, rows show their group and open the place in it, and nothing is
 * created, renewed or changed from here). Search, company, status, plan, trash, country and
 * province filters, the sort and the cursor pagination live in the URL, so a view can be shared
 * and survives a reload. Platform administrators and dealers renew the expiration date in the
 * row; rows offer trash, restore, delete (from the trash only) and duplicate according to the
 * permissions of the user. Which places a user sees is decided by the server.
 */
@Component({
  selector: 'fc-places-list',
  imports: [
    ActionsMenu,
    Button,
    Can,
    CellTemplate,
    Checkbox,
    CrossGroupFilters,
    CursorPaginator,
    DataTable,
    ErrorState,
    PlaceActions,
    PlaceRenewal,
    RouterLink,
    RowActionsTemplate,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './places-list.html',
  styleUrl: './places-list.css',
})
export class PlacesList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly groups = inject(GroupContext);
  private readonly countries = inject(Countries);
  private readonly store = inject(ReferenceStore);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter of the group list; in the cross-group list it is the `groupId` query filter. */
  readonly groupId = input<string>();
  /** Dealer filter (cross-group list, platform administrator only). */
  readonly dealerId = input<string>();
  /** Route data: `all` for the cross-group list (`/places`). */
  readonly scope = input<string>();
  /** Query parameters (bound by the router). */
  readonly q = input<string>();
  readonly companyId = input<string>();
  readonly status = input<string>();
  readonly plan = input<string>();
  readonly trashed = input<string>();
  readonly country = input<string>();
  readonly province = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** `group` (path parameter) or `all` (the cross-group list of PSA and dealers). */
  protected readonly isAll = computed(() => this.scope() === 'all');
  /** Group of the list: the path parameter, `undefined` in the cross-group list. */
  protected readonly ownGroupId = computed(() => (this.isAll() ? undefined : this.groupId()));
  /** Group the row actions work on (none in the cross-group list, where there are no actions). */
  protected readonly actionGroup = computed(() => this.ownGroupId() ?? '');
  /** Group filter of the cross-group list (valid ids only). */
  protected readonly groupFilter = computed(() => {
    const value = this.groupId();
    return this.isAll() && OBJECT_ID.test(value ?? '') ? value : undefined;
  });
  protected readonly dealerFilter = computed(() => {
    const value = this.dealerId();
    return this.isAll() && this.session.me()?.role === 'PSA' && OBJECT_ID.test(value ?? '')
      ? value
      : undefined;
  });
  /** A user who may create places is told to choose a group first (creation needs one). */
  protected readonly chooseGroupHint = computed(
    () => this.isAll() && this.session.can('places:create'),
  );

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
    return (PLACE_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('PLACES.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('PLACES.STATUS.DISABLED') },
  ]);
  protected readonly planOptions = computed(() =>
    PLANS.map((plan) => ({ value: plan, label: this.planLabel(plan) })),
  );
  protected readonly countryOptions = computed(() =>
    this.countries.list().map((country) => ({ value: country.code, label: country.name })),
  );
  protected readonly provinceOptions = computed(() =>
    this.countries
      .areas(this.country() ?? '')
      .map((area) => ({ value: area.code, label: `${area.name} (${area.code})` })),
  );

  /** The companies of the group the user can see: the filter and the name of the company of a row. */
  private readonly companiesResource = resource({
    params: () =>
      this.session.can('companies:read') ? (this.ownGroupId() ?? this.groupFilter()) : undefined,
    loader: ({ params }) => loadAll(this.store, params, 'companies'),
  });
  protected readonly companies = computed(() =>
    this.companiesResource.hasValue() ? this.companiesResource.value() : [],
  );
  protected readonly companyOptions = computed(() =>
    this.companies().map((company) => ({ value: company.id, label: company.name })),
  );

  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly places = httpResource<ApiPage<PlaceListItem>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const country = this.country();
    const province = this.province();
    const plan = this.plan();
    const companyId = this.companyId();
    const filters = {
      q: this.q()?.trim(),
      companyId: OBJECT_ID.test(companyId ?? '') ? companyId : undefined,
      status: this.statusOptions().some((option) => option.value === this.status())
        ? this.status()
        : undefined,
      plan: PLAN.test(plan ?? '') ? plan : undefined,
      trashed: this.trashed() === 'true' ? 'true' : undefined,
      country: COUNTRY.test(country ?? '') ? country : undefined,
      province: PROVINCE.test(province ?? '') ? province : undefined,
      cursor: this.cursor(),
      groupId: this.groupFilter(),
      dealerId: this.dealerFilter(),
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    const own = this.ownGroupId();
    return {
      url: own === undefined ? '/v1/places' : `/v1/groups/${encodeURIComponent(own)}/places`,
      params,
    };
  });

  protected readonly rows = computed(() =>
    this.places.hasValue() ? this.places.value().data : [],
  );
  protected readonly nextCursor = computed(() =>
    this.places.hasValue() ? this.places.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.places.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly showTrashed = computed(() => this.trashed() === 'true');
  /** Where "new place" leads: the form of the group; none in the cross-group list. */
  protected readonly newRoute = computed(() => {
    const own = this.ownGroupId();
    return own === undefined ? null : ['/groups', own, 'places', 'new'];
  });

  protected readonly columns = computed<TableColumn<PlaceListItem>[]>(() => [
    ...(this.isAll()
      ? [
          {
            key: 'groupName',
            header: this.i18n.t('CROSS_GROUP.COLUMN.GROUP'),
            hideNarrow: true,
          },
        ]
      : []),
    { key: 'name', header: this.i18n.t('PLACES.COLUMN.NAME'), sortable: true },
    // The cross-group list has no company names: the column is there only when a group is
    // filtered, so that the companies of that group can name them.
    ...(!this.isAll() || this.groupFilter() !== undefined
      ? [
          {
            key: 'company',
            header: this.i18n.t('PLACES.COLUMN.COMPANY'),
            hideNarrow: true,
            cell: (row: PlaceListItem) => this.companyName(row),
          },
        ]
      : []),
    {
      key: 'city',
      header: this.i18n.t('PLACES.COLUMN.CITY'),
      hideNarrow: true,
      cell: (row) => row.city ?? '',
    },
    {
      key: 'plan',
      header: this.i18n.t('PLACES.COLUMN.PLAN'),
      hideNarrow: true,
      cell: (row) => (row.plan === null ? '' : this.planLabel(row.plan)),
    },
    {
      key: 'expirationDate',
      header: this.i18n.t('PLACES.COLUMN.EXPIRATION'),
      sortable: true,
    },
    { key: 'status', header: this.i18n.t('PLACES.COLUMN.STATUS') },
  ]);
  protected readonly rowKey = (row: PlaceListItem): string => row.id;
  protected readonly detailRoute = (row: PlaceListItem): string[] =>
    placeRoute(this.ownGroupId() ?? row.groupId ?? '', row.id);
  /** Route of the group of a row (cross-group list). */
  protected readonly groupRoute = (row: PlaceListItem): string[] => [
    '/groups',
    row.groupId ?? '',
    'settings',
  ];

  /** Whether the user may renew the expiration date in the list (platform administrators and dealers). */
  protected readonly canRenew = computed(() => {
    const role = this.session.me()?.role;
    return !this.isAll() && this.session.can('places:update') && (role === 'PSA' || role === 'D');
  });
  /** Whether the user may do anything to a row (otherwise the actions menu is not offered). */
  protected readonly canAct = computed(
    () =>
      !this.isAll() &&
      (this.session.can('places:trash') ||
        this.session.can('places:delete') ||
        this.session.can('places:create')),
  );

  constructor() {
    this.countries.need();
    // The page loaded: the group in the URL becomes the working group of the selector.
    effect(() => {
      const groupId = this.ownGroupId();
      if (groupId !== undefined && this.places.hasValue()) {
        untracked(() => this.groups.adopt(groupId));
      }
    });
  }

  /** Opening a place of the cross-group list makes its group the working group. */
  protected open(row: PlaceListItem): void {
    if (this.isAll() && row.groupId !== undefined) {
      this.groups.choose({ id: row.groupId, name: row.groupName ?? '' });
    }
  }

  /** A group change drops the company filter, which belongs to the previous group. */
  protected onCrossGroup(change: CrossGroupFilterChange): void {
    this.change({
      [change.name]: change.value === '' ? null : change.value,
      ...(change.name === 'groupId' ? { companyId: null } : {}),
    });
  }

  protected rowLabel(key: string, row: PlaceListItem): string {
    return this.i18n.t(key, { name: row.name });
  }

  /** The label of a plan, the stored value itself when the interface does not know it. */
  protected planLabel(plan: string): string {
    return (PLANS as readonly string[]).includes(plan)
      ? this.i18n.t(`PLACES.PLAN.${plan.toUpperCase().replace('-', '_')}`)
      : plan;
  }

  private companyName(row: PlaceListItem): string {
    return this.companies().find((company) => company.id === row.companyId)?.name ?? '';
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onFilter(name: 'companyId' | 'status' | 'plan' | 'province', value: string): void {
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

  /** An action ran: the list is read again, and the copy of a duplication is opened. */
  protected onDone(result: PlaceActionResult): void {
    if (result.copyId === null) {
      this.places.reload();
    } else {
      void this.router.navigate(placeRoute(this.actionGroup(), result.copyId));
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
