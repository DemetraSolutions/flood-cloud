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
 * Places of a group (`/groups/:groupId/places`): search, company, status, plan, trash, country and
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

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
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
    params: () => (this.session.can('companies:read') ? this.groupId() : undefined),
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
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return { url: `/v1/groups/${encodeURIComponent(this.groupId())}/places`, params };
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
  protected readonly newRoute = computed(() => ['/groups', this.groupId(), 'places', 'new']);

  protected readonly columns = computed<TableColumn<PlaceListItem>[]>(() => [
    { key: 'name', header: this.i18n.t('PLACES.COLUMN.NAME'), sortable: true },
    {
      key: 'company',
      header: this.i18n.t('PLACES.COLUMN.COMPANY'),
      hideNarrow: true,
      cell: (row) => this.companyName(row),
    },
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
    placeRoute(this.groupId(), row.id);

  /** Whether the user may renew the expiration date in the list (platform administrators and dealers). */
  protected readonly canRenew = computed(() => {
    const role = this.session.me()?.role;
    return this.session.can('places:update') && (role === 'PSA' || role === 'D');
  });
  /** Whether the user may do anything to a row (otherwise the actions menu is not offered). */
  protected readonly canAct = computed(
    () =>
      this.session.can('places:trash') ||
      this.session.can('places:delete') ||
      this.session.can('places:create'),
  );

  constructor() {
    this.countries.need();
    // The page loaded: the group in the URL becomes the working group of the selector.
    effect(() => {
      const groupId = this.groupId();
      if (this.places.hasValue()) {
        untracked(() => this.groups.adopt(groupId));
      }
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
      void this.router.navigate(placeRoute(this.groupId(), result.copyId));
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
