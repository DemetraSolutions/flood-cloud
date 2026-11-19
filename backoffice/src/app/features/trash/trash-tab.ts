import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { DealerRecord } from '../dealers/dealer.types';
import { loadAll } from '../places/lookup-loader';
import { abbreviateId } from '../activity-log/activity-log.types';
import { apiErrorOf } from '../profile/sessions';
import { UsersApi } from '../users/users-api';
import { GroupCell, groupCell } from '../groups/group-cell';
import { TrashApi } from './trash-api';
import { TrashEmptyDialog } from './trash-empty-dialog';
import { TrashSummaryDialog } from './trash-summary-dialog';
import {
  DELETE_PERMISSION,
  EMPTY_PERMISSION,
  GroupTrashKind,
  RESTORE_PERMISSION,
  summarize,
  TrashedGroup,
  TrashedPlace,
  TrashedUser,
  TrashItemResult,
  TrashOutcome,
  TrashKind,
  TrashRow,
  platformIssue,
  trashRowLabel,
  trashRowRoute,
  TrashSummary,
} from './trash.types';

/** Page sizes offered by the tabs (a page never exceeds the 100 ids of a bulk call). */
export const TRASH_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 25;
/** Most dealers read to name the dealer of each group (the API limit of a page). */
const DEALERS_LIMIT = 200;
/** Sort of each tab (the order of the lists the pages of the other areas show by default). */
const SORT: Readonly<Record<TrashKind, string>> = {
  companies: 'name',
  places: 'name',
  users: 'username',
  groups: 'name',
};
/** Column that names the row, links to its detail and is its row header. */
const NAME_COLUMN: Readonly<Record<TrashKind, string>> = {
  companies: 'name',
  places: 'name',
  users: 'username',
  groups: 'name',
};

/** Query parameters of the page as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * One tab of the trash page: the trashed items of a kind in a table with search and cursor
 * pagination (in the URL), multi-selection and the bulk actions. Restoring and deleting for good
 * use the permissions of the lists; "Svuota cestino" is for platform administrators; groups are
 * only restored. A bulk call ends in a summary and the table is read again.
 */
@Component({
  selector: 'fc-trash-tab',
  imports: [
    Button,
    CellTemplate,
    Checkbox,
    ConfirmDialog,
    CursorPaginator,
    DataTable,
    ErrorState,
    RouterLink,
    TextField,
    TPipe,
    TrashEmptyDialog,
    TrashSummaryDialog,
  ],
  templateUrl: './trash-tab.html',
  styleUrl: './trash-tab.css',
})
export class TrashTab {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly store = inject(ReferenceStore);
  private readonly api = inject(TrashApi);
  private readonly users = inject(UsersApi);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Kind of the items of the tab. */
  readonly kind = input.required<TrashKind>();
  /** Group of the page (the groups tab is platform-wide and ignores it); none in the cross-group trash. */
  readonly groupId = input<string>();
  /** Whether the tab lists the trash of every group in the scope of the user (`/trash`). */
  readonly all = input(false);
  /** Group filter of the cross-group trash (valid id or `undefined`). */
  readonly groupFilter = input<string>();
  /** Dealer filter of the cross-group trash (valid id or `undefined`). */
  readonly dealerFilter = input<string>();
  /** Query parameters of the page (bound by the page). */
  readonly q = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (TRASH_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly items = httpResource<ApiPage<TrashRow>>(() => {
    const kind = this.kind();
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: SORT[kind],
      trashed: 'true',
    };
    const filters = {
      q: this.q()?.trim(),
      cursor: this.cursor(),
      groupId: this.all() && kind !== 'groups' ? this.groupFilter() : undefined,
      dealerId: this.all() ? this.dealerFilter() : undefined,
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    const own = this.groupId();
    return {
      url:
        kind === 'groups'
          ? '/v1/groups'
          : this.all()
            ? `/v1/${kind}`
            : `/v1/groups/${encodeURIComponent(own as string)}/${kind}`,
      params,
    };
  });

  /** Companies of the group, to name the company of a place. */
  private readonly companiesResource = resource({
    params: () =>
      this.kind() === 'places' && this.session.can('companies:read')
        ? this.all()
          ? this.groupFilter()
          : this.groupId()
        : undefined,
    loader: ({ params }) => loadAll(this.store, params, 'companies'),
  });
  /** Dealers, to name the dealer of a group. */
  private readonly dealersResource = httpResource<ApiPage<DealerRecord>>(() =>
    this.kind() === 'groups' && this.session.can('dealers:read')
      ? { url: '/v1/dealers', params: { limit: DEALERS_LIMIT, sort: 'businessName' } }
      : undefined,
  );

  protected readonly rows = computed(() => (this.items.hasValue() ? this.items.value().data : []));
  protected readonly nextCursor = computed(() =>
    this.items.hasValue() ? this.items.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.items.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<TrashRow>[]>(() => {
    const kind = this.kind();
    const text = (key: string) => this.i18n.t(`TRASH.COLUMN.${key}`);
    const field =
      (name: 'city' | 'province' | 'country') =>
      (row: TrashRow): string =>
        (row as TrashedPlace)[name] ?? '';
    const since: TableColumn<TrashRow> = {
      key: 'trashedAt',
      header: text('TRASHED_AT'),
      hideNarrow: true,
      cell: (row) => this.date(row.trashedAt),
    };
    const select: TableColumn<TrashRow> = { key: 'select', header: text('SELECT'), narrow: true };
    // In the cross-group trash every row says which group it belongs to (not the groups tab).
    const group: TableColumn<TrashRow>[] =
      this.all() && kind !== 'groups'
        ? [{ key: 'group', header: this.i18n.t('CROSS_GROUP.COLUMN.GROUP'), hideNarrow: true }]
        : [];
    // The cross-group lists name no company: the column is there when a group is filtered.
    const company: TableColumn<TrashRow>[] =
      !this.all() || this.groupFilter() !== undefined
        ? [{ key: 'company', header: text('COMPANY'), cell: (row) => this.companyName(row) }]
        : [];
    switch (kind) {
      case 'companies':
        return [
          select,
          ...group,
          { key: 'name', header: text('NAME') },
          {
            key: 'vatNumber',
            header: text('VAT_NUMBER'),
            cell: (row) => (row as { vatNumber: string | null }).vatNumber ?? '',
          },
          { key: 'city', header: text('CITY'), hideNarrow: true, cell: field('city') },
          { key: 'province', header: text('PROVINCE'), hideNarrow: true, cell: field('province') },
          { key: 'country', header: text('COUNTRY'), hideNarrow: true, cell: field('country') },
          since,
        ];
      case 'places':
        return [
          select,
          ...group,
          ...company,
          { key: 'name', header: text('NAME') },
          { key: 'city', header: text('CITY'), hideNarrow: true, cell: field('city') },
          { key: 'province', header: text('PROVINCE'), hideNarrow: true, cell: field('province') },
          { key: 'country', header: text('COUNTRY'), hideNarrow: true, cell: field('country') },
          since,
        ];
      case 'users':
        return [
          select,
          ...group,
          {
            key: 'role',
            header: text('ROLE'),
            cell: (row) => this.i18n.t(`ROLE_SHORT.${(row as TrashedUser).role}`),
          },
          { key: 'username', header: text('USERNAME') },
          {
            key: 'fullName',
            header: text('FULL_NAME'),
            hideNarrow: true,
            cell: (row) =>
              [(row as TrashedUser).firstName, (row as TrashedUser).lastName]
                .filter((part) => part)
                .join(' '),
          },
          {
            key: 'email',
            header: text('EMAIL'),
            hideNarrow: true,
            cell: (row) => (row as TrashedUser).email ?? '',
          },
          since,
        ];
      case 'groups':
        return [
          select,
          { key: 'name', header: text('NAME') },
          { key: 'id', header: text('ID'), hideNarrow: true, cell: (row) => row.id },
          {
            key: 'dealer',
            header: text('DEALER'),
            hideNarrow: true,
            cell: (row) => this.dealerName(row),
          },
          since,
        ];
    }
  });
  protected readonly nameColumn = computed(() => NAME_COLUMN[this.kind()]);
  protected readonly rowKey = (row: TrashRow): string => row.id;

  protected readonly selection = linkedSignal<readonly TrashRow[], ReadonlySet<string>>({
    source: this.rows,
    computation: () => new Set<string>(),
  });
  /** Rows that can be selected: in the cross-group trash only the ones with a group (a bulk call is per group). */
  protected readonly selectable = computed(() =>
    this.rows().filter((row) => this.isSelectable(row)),
  );
  protected readonly selectedRows = computed(() =>
    this.selectable().filter((row) => this.selection().has(row.id)),
  );
  protected readonly allSelected = computed(
    () => this.selectable().length > 0 && this.selectedRows().length === this.selectable().length,
  );

  protected readonly canRestore = computed(() => this.session.can(RESTORE_PERMISSION[this.kind()]));
  protected readonly canDelete = computed(() => {
    const kind = this.kind();
    return kind !== 'groups' && this.session.can(DELETE_PERMISSION[kind]);
  });
  /** "Svuota cestino" is per group: in the cross-group trash it needs a group filter. */
  protected readonly emptyGroup = computed(() => this.groupId() ?? this.groupFilter());
  protected readonly canEmpty = computed(
    () =>
      this.kind() !== 'groups' &&
      this.session.can(EMPTY_PERMISSION) &&
      this.emptyGroup() !== undefined,
  );
  /** The user could empty a group's trash but has not chosen the group (cross-group trash). */
  protected readonly emptyNeedsGroup = computed(
    () =>
      this.kind() !== 'groups' &&
      this.session.can(EMPTY_PERMISSION) &&
      this.emptyGroup() === undefined,
  );
  /** The kind of the group trash, for the bulk calls (never `groups`: those have their own). */
  protected readonly groupKind = computed(() => this.kind() as GroupTrashKind);
  /** Items in the trash when the page shows all of them (the first page without a next one). */
  protected readonly knownCount = computed(() =>
    this.items.hasValue() && this.cursor() === undefined && this.nextCursor() === null
      ? this.rows().length
      : null,
  );

  protected readonly busy = signal(false);
  protected readonly deleteOpen = signal(false);
  protected readonly emptyOpen = signal(false);
  protected readonly summaryOpen = signal(false);
  protected readonly summary = signal<TrashSummary | null>(null);
  protected readonly names = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly deleteMessage = computed(() =>
    this.i18n.t('TRASH.DELETE.MESSAGE', { count: this.selectedRows().length }),
  );

  protected detailRoute(row: TrashRow): string[] {
    return trashRowRoute(this.kind(), this.groupId() ?? this.groupOf(row) ?? '', row);
  }

  /** Group of a row of the cross-group trash (`null` for a platform user). */
  private groupOf(row: TrashRow): string | null {
    return (row as { groupId?: string | null }).groupId ?? null;
  }

  /** A platform user (no group) is handled with the platform routes, which only a PSA may use. */
  private isPlatformUser(row: TrashRow): boolean {
    return this.all() && this.kind() === 'users' && this.groupOf(row) === null;
  }

  protected isSelectable(row: TrashRow): boolean {
    return (
      !this.all() ||
      this.kind() === 'groups' ||
      this.groupOf(row) !== null ||
      this.session.me()?.role === 'PSA'
    );
  }

  /** What the group cell of a row shows: the name (a dash for none) and the group it links to. */
  protected groupCell(row: TrashRow): GroupCell {
    return groupCell(this.i18n, row as { groupId?: string | null; groupName?: string | null });
  }

  protected label(row: TrashRow): string {
    return trashRowLabel(this.kind(), row);
  }

  protected selectLabel(row: TrashRow): string {
    return this.i18n.t('TRASH.SELECT_ROW', { name: this.label(row) });
  }

  protected isSelected(row: TrashRow): boolean {
    return this.selection().has(row.id);
  }

  protected toggleRow(row: TrashRow, checked: boolean): void {
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

  /** Restores the selected items (no confirmation: it is reversible). */
  protected async restore(): Promise<void> {
    const kind = this.kind();
    await this.run(
      this.selectedRows(),
      (groupId, ids) =>
        kind === 'groups'
          ? this.api.restoreGroups(ids)
          : this.api.restore(groupId, this.groupKind(), ids),
      { call: (id) => this.users.restore({ kind: 'platform' }, id), outcome: 'restored' },
    );
  }

  /** Deletes the selected items for good, after the confirmation. */
  protected async remove(): Promise<void> {
    await this.run(
      this.selectedRows(),
      (groupId, ids) => this.api.remove(groupId, this.groupKind(), ids),
      { call: (id) => this.users.remove({ kind: 'platform' }, id), outcome: 'deleted' },
    );
    this.deleteOpen.set(false);
  }

  /** "Svuota cestino" ended: the same summary, then the table is read again. */
  protected onEmptied(results: readonly TrashItemResult[]): void {
    this.names.set(new Map());
    this.report(summarize(results));
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
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

  /**
   * Runs a bulk call for the rows, one request per group (the backend works on one group at a
   * time), in order, and merges the results into one summary. A group whose request fails does not
   * lose the results of the others: it is listed in the summary. When every request fails the
   * error is shown as a message and there is no summary.
   */
  private async run(
    rows: readonly TrashRow[],
    call: (
      groupId: string,
      ids: readonly string[],
    ) => Promise<{ readonly results: readonly TrashItemResult[] }>,
    platform: { readonly call: (id: string) => Promise<unknown>; readonly outcome: TrashOutcome },
  ): Promise<void> {
    this.busy.set(true);
    const batches = new Map<string, TrashRow[]>();
    const platformUsers: TrashRow[] = [];
    for (const row of rows) {
      if (this.isPlatformUser(row)) {
        platformUsers.push(row);
        continue;
      }
      const key = this.kind() === 'groups' ? '' : (this.groupId() ?? this.groupOf(row)!);
      batches.set(key, [...(batches.get(key) ?? []), row]);
    }
    const results: TrashItemResult[] = [];
    const failed: string[] = [];
    let firstError: unknown = null;
    try {
      for (const [groupId, batch] of batches) {
        try {
          const done = await call(
            groupId,
            batch.map((row) => row.id),
          );
          results.push(...done.results);
        } catch (error) {
          firstError ??= error;
          failed.push(this.groupLabel(batch[0]));
        }
      }
      // Platform users have no group: one request each, with the platform routes.
      for (const user of platformUsers) {
        try {
          await platform.call(user.id);
          results.push({ id: user.id, outcome: platform.outcome });
        } catch (error) {
          const issue = platformIssue(error);
          if (issue === null) {
            firstError ??= error;
            failed.push(this.label(user));
          } else {
            results.push({ id: user.id, outcome: 'skipped', issue });
          }
        }
      }
      if (failed.length === batches.size + platformUsers.length) {
        this.toast.error(failureMessage(this.i18n, firstError));
      } else {
        this.names.set(new Map(rows.map((row) => [row.id, this.label(row)])));
        this.report({ ...summarize(results), failedGroups: this.all() ? failed : [] });
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Name of the group of a row for the list of the groups that failed (its short id without a name). */
  private groupLabel(row: TrashRow): string {
    const name = (row as { groupName?: string | null }).groupName;
    return name ? name : abbreviateId(this.groupOf(row) ?? '');
  }

  private report(summary: TrashSummary): void {
    this.summary.set(summary);
    this.summaryOpen.set(true);
    this.items.reload();
  }

  private date(value: string | null): string {
    return !value ? '—' : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }

  private companyName(row: TrashRow): string {
    const companies = this.companiesResource.hasValue() ? this.companiesResource.value() : [];
    return companies.find((company) => company.id === (row as TrashedPlace).companyId)?.name ?? '';
  }

  private dealerName(row: TrashRow): string {
    const dealerId = (row as TrashedGroup).dealerId;
    const dealers = this.dealersResource.hasValue() ? this.dealersResource.value().data : [];
    return dealers.find((dealer) => dealer.id === dealerId)?.businessName ?? '';
  }

  /** Changes the search or the page size: the first page is shown again. */
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
