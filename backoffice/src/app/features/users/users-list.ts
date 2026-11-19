import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { Role } from '../../core/session/session.types';
import { ActionsMenu } from '../../shared/ui/actions-menu/actions-menu';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { Avatar, initialsOf } from '../../shared/ui/avatar/avatar';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { GroupCell, groupCell } from '../groups/group-cell';
import { apiErrorOf } from '../profile/sessions';
import { fullName, userRoute, UserRecord } from './user.types';
import { UserActions } from './user-actions';

/** Page sizes offered by the list. */
export const USER_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 25;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const SORT_KEYS = ['username', 'lastName', 'createdAt'] as const;
const GROUP_ROLES: readonly Role[] = ['SA', 'CA', 'PA', 'E'];
const PLATFORM_FILTER_ROLES: readonly Role[] = ['PSA', 'D', 'SA', 'CA', 'PA', 'E'];

/** Query parameters of the list as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * The one list of users, filtered by what the user selected: the users of a group
 * (`/groups/:groupId/users`: the group chosen by a PSA or dealer, the own group of an SA, and the
 * perimeter of a CA or PA, which the server applies) or, for a PSA or dealer with no group
 * chosen, every user of the perimeter (`/users`, with a group column). Filters, sorting and
 * cursor pagination live in the URL, so a view can be shared and survives a reload.
 * Rows offer actions according to the user's permissions; several rows can be selected to move
 * them to the trash or restore them in one go.
 */
@Component({
  selector: 'fc-users-list',
  imports: [
    ActionsMenu,
    Avatar,
    Button,
    Can,
    CellTemplate,
    Checkbox,
    CursorPaginator,
    DataTable,
    ErrorState,
    RouterLink,
    RowActionsTemplate,
    Select,
    StatusBadge,
    TextField,
    TPipe,
    UserActions,
  ],
  templateUrl: './users-list.html',
  styleUrl: './users-list.css',
})
export class UsersList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter of the group list; in the cross-group list it is the `groupId` query filter. */
  readonly groupId = input<string>();
  /** Query parameters (bound by the router). */
  readonly q = input<string>();
  readonly role = input<string>();
  readonly status = input<string>();
  readonly trashed = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** Dealers' filter by dealer (the cross-group view for a PSA). */
  readonly dealerId = input<string>();
  /** Route data: `all` for the cross-group view (`/users`), where `groupId` is a query filter. */
  readonly scope = input<string>();

  /** `group` (path parameter) or `all` (the cross-group list of PSA and dealers, no group chosen). */
  protected readonly mode = computed<'group' | 'all'>(() =>
    this.scope() === 'all' ? 'all' : 'group',
  );
  protected readonly isAll = computed(() => this.mode() === 'all');
  /**
   * Where "new user" leads: the form of the group; in the cross-group list a PSA creates platform
   * users (PSA and dealers), while a dealer must choose a group first (`null`).
   */
  protected readonly newRoute = computed(() => {
    if (this.mode() === 'group') {
      return ['/groups', this.groupId(), 'users', 'new'];
    }
    return this.session.me()?.role === 'PSA' ? ['/platform', 'users', 'new'] : null;
  });
  /** A dealer who may create users is told to choose a group first. */
  protected readonly chooseGroupHint = computed(
    () => this.isAll() && this.session.me()?.role === 'D' && this.session.can('users:create'),
  );

  protected readonly sortValue = computed(() => {
    const value = this.sort() ?? '';
    return SORT_KEYS.some((key) => value === key || value === `-${key}`) ? value : 'username';
  });
  protected readonly tableSort = computed<TableSort>(() => {
    const value = this.sortValue();
    return value.startsWith('-')
      ? { key: value.slice(1), direction: 'desc' }
      : { key: value, direction: 'asc' };
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (USER_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly roleOptions = computed(() =>
    (this.isAll() && this.session.me()?.role === 'PSA' ? PLATFORM_FILTER_ROLES : GROUP_ROLES).map(
      (role) => ({
        value: role,
        label: this.i18n.t(`ROLE.${role}`),
      }),
    ),
  );
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('USERS.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('USERS.STATUS.DISABLED') },
  ]);

  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly users = httpResource<ApiPage<UserRecord>>(() => {
    const groupId = this.mode() === 'group' ? this.groupId() : undefined;
    const crossGroup = this.isAll() && this.groupId() !== undefined ? this.groupId() : undefined;
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const filters = {
      q: this.q()?.trim(),
      role: this.roleOptions().some((option) => option.value === this.role())
        ? this.role()
        : undefined,
      status: this.statusOptions().some((option) => option.value === this.status())
        ? this.status()
        : undefined,
      trashed: this.trashed() === 'true' ? 'true' : undefined,
      cursor: this.cursor(),
      groupId: this.isAll() && OBJECT_ID.test(crossGroup ?? '') ? crossGroup : undefined,
      dealerId:
        this.isAll() && this.session.me()?.role === 'PSA' && OBJECT_ID.test(this.dealerId() ?? '')
          ? this.dealerId()
          : undefined,
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return {
      url: groupId === undefined ? '/v1/users' : `/v1/groups/${encodeURIComponent(groupId)}/users`,
      params,
    };
  });

  protected readonly rows = computed(() => this.users.value()?.data ?? []);
  protected readonly nextCursor = computed(() => this.users.value()?.page.next ?? null);
  protected readonly loadError = computed(() => apiErrorOf(this.users.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly showTrashed = computed(() => this.trashed() === 'true');

  protected readonly selection = linkedSignal<readonly UserRecord[], ReadonlySet<string>>({
    source: this.rows,
    computation: () => new Set<string>(),
  });
  private readonly selectable = computed(() =>
    this.rows().filter((row) => row.id !== this.session.me()?.id),
  );
  protected readonly selectedUsers = computed(() =>
    this.rows().filter((row) => this.selection().has(row.id)),
  );
  protected readonly allSelected = computed(
    () => this.selectable().length > 0 && this.selectedUsers().length === this.selectable().length,
  );

  protected readonly columns = computed<TableColumn<UserRecord>[]>(() => [
    { key: 'select', header: this.i18n.t('USERS.COLUMN.SELECT'), narrow: true },
    ...(this.isAll()
      ? [{ key: 'groupId', header: this.i18n.t('USERS.COLUMN.GROUP'), hideNarrow: true }]
      : []),
    {
      key: 'username',
      header: this.i18n.t('USERS.COLUMN.USERNAME'),
      sortable: true,
    },
    {
      key: 'lastName',
      header: this.i18n.t('USERS.COLUMN.NAME'),
      sortable: true,
      cell: (row) => fullName(row) ?? '',
    },
    {
      key: 'role',
      header: this.i18n.t('USERS.COLUMN.ROLE'),
      cell: (row) => this.i18n.t(`ROLE_SHORT.${row.role}`),
    },
    { key: 'status', header: this.i18n.t('USERS.COLUMN.STATUS') },
    {
      key: 'createdAt',
      header: this.i18n.t('USERS.COLUMN.CREATED'),
      sortable: true,
      hideNarrow: true,
      cell: (row) => this.date(row.createdAt),
    },
  ]);
  protected readonly rowKey = (row: UserRecord): string => row.id;
  protected readonly detailRoute = userRoute;
  protected groupCell(row: UserRecord): GroupCell {
    return groupCell(this.i18n, row);
  }
  protected readonly initials = initialsOf;

  /** Whether the user may do anything to a row (otherwise the actions menu is not offered). */
  protected readonly canAct = computed(
    () =>
      this.session.can('users:update') ||
      this.session.can('users:trash') ||
      this.session.can('users:delete'),
  );

  constructor() {}

  protected isSelf(row: UserRecord): boolean {
    return row.id === this.session.me()?.id;
  }

  protected isSelected(row: UserRecord): boolean {
    return this.selection().has(row.id);
  }

  protected toggleRow(row: UserRecord, checked: boolean): void {
    this.selection.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(row.id);
      } else {
        next.delete(row.id);
      }
      return next;
    });
  }

  protected toggleAll(checked: boolean): void {
    this.selection.set(new Set(checked ? this.selectable().map((row) => row.id) : []));
  }

  protected selectLabel(row: UserRecord): string {
    return this.i18n.t('USERS.SELECT_ROW', { username: row.username });
  }

  protected rowLabel(key: string, row: UserRecord): string {
    return this.i18n.t(key, { username: row.username });
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onFilter(name: 'role' | 'status', value: string): void {
    this.change({ [name]: value === '' ? null : value });
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

  private date(value: string | null): string {
    return value === null ? '' : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }
}
