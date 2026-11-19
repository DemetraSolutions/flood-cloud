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
import { apiErrorOf } from '../profile/sessions';
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
  TrashKind,
  TrashRow,
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
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Kind of the items of the tab. */
  readonly kind = input.required<TrashKind>();
  /** Group of the page (the groups tab is platform-wide and ignores it). */
  readonly groupId = input.required<string>();
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
    const filters = { q: this.q()?.trim(), cursor: this.cursor() };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return {
      url:
        kind === 'groups'
          ? '/v1/groups'
          : `/v1/groups/${encodeURIComponent(this.groupId())}/${kind}`,
      params,
    };
  });

  /** Companies of the group, to name the company of a place. */
  private readonly companiesResource = resource({
    params: () =>
      this.kind() === 'places' && this.session.can('companies:read') ? this.groupId() : undefined,
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
    switch (kind) {
      case 'companies':
        return [
          select,
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
          { key: 'company', header: text('COMPANY'), cell: (row) => this.companyName(row) },
          { key: 'name', header: text('NAME') },
          { key: 'city', header: text('CITY'), hideNarrow: true, cell: field('city') },
          { key: 'province', header: text('PROVINCE'), hideNarrow: true, cell: field('province') },
          { key: 'country', header: text('COUNTRY'), hideNarrow: true, cell: field('country') },
          since,
        ];
      case 'users':
        return [
          select,
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
  protected readonly selectedRows = computed(() =>
    this.rows().filter((row) => this.selection().has(row.id)),
  );
  protected readonly allSelected = computed(
    () => this.rows().length > 0 && this.selectedRows().length === this.rows().length,
  );

  protected readonly canRestore = computed(() => this.session.can(RESTORE_PERMISSION[this.kind()]));
  protected readonly canDelete = computed(() => {
    const kind = this.kind();
    return kind !== 'groups' && this.session.can(DELETE_PERMISSION[kind]);
  });
  protected readonly canEmpty = computed(
    () => this.kind() !== 'groups' && this.session.can(EMPTY_PERMISSION),
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
    return trashRowRoute(this.kind(), this.groupId(), row);
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
    this.selection.set(new Set(checked ? this.rows().map((row) => row.id) : []));
  }

  /** Restores the selected items (no confirmation: it is reversible). */
  protected async restore(): Promise<void> {
    const rows = this.selectedRows();
    await this.run(rows, () => {
      const ids = rows.map((row) => row.id);
      return this.kind() === 'groups'
        ? this.api.restoreGroups(ids)
        : this.api.restore(this.groupId(), this.groupKind(), ids);
    });
  }

  /** Deletes the selected items for good, after the confirmation. */
  protected async remove(): Promise<void> {
    const rows = this.selectedRows();
    await this.run(rows, () =>
      this.api.remove(
        this.groupId(),
        this.groupKind(),
        rows.map((row) => row.id),
      ),
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

  private async run(
    rows: readonly TrashRow[],
    call: () => Promise<{ readonly results: readonly TrashItemResult[] }>,
  ): Promise<void> {
    this.busy.set(true);
    try {
      const { results } = await call();
      this.names.set(new Map(rows.map((row) => [row.id, this.label(row)])));
      this.report(summarize(results));
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    } finally {
      this.busy.set(false);
    }
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
