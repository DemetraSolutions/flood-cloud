import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TabItem, TabList } from '../../shared/ui/tab-list/tab-list';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { loadAll } from '../places/lookup-loader';
import { apiErrorOf } from '../profile/sessions';
import { xlsxToolRoute } from '../catalog-xlsx/xlsx-tools';
import { ContactApi } from './contact-api';
import {
  CONTACT_KINDS,
  ContactKind,
  ContactRow,
  contactLabel,
  contactRoute,
  DEFAULT_KIND,
} from './contact.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['displayName', 'lastName', 'companyName', 'updatedAt'];
const DEFAULT_SORT = 'displayName';
const OBJECT_ID = /^[0-9a-f]{24}$/;

/** What the user is told after moving the selected contacts to the trash. */
export interface TrashReport {
  /** How many contacts went to the trash. */
  readonly trashed: number;
  /** The contacts that did not, with the reason. */
  readonly skipped: readonly { readonly id: string; readonly name: string; readonly issue: string }[];
}

/**
 * The contacts of a group (`/groups/:groupId/contacts`) in four tabs (customers, suppliers,
 * generic contacts and all of them, the `kind` of the URL) with the columns the legacy page had
 * for each. The search (text searched literally by the server: part of a name, or the exact code,
 * tax code, VAT number, card or e-mail), the group of contacts, the sort and the cursor pagination
 * live in the URL. Whoever may write contacts creates and moves to the trash, one by one or the
 * selected ones; a bulk move ends in a summary of what happened to each contact. A search the
 * server could not finish in time (`503`) asks to narrow the text.
 */
@Component({
  selector: 'fc-contact-list',
  imports: [
    Button,
    Can,
    CellTemplate,
    Checkbox,
    ConfirmDialog,
    CursorPaginator,
    DataTable,
    ErrorState,
    RouterLink,
    RowActionsTemplate,
    Select,
    StatusBadge,
    TabList,
    TextField,
    TPipe,
  ],
  templateUrl: './contact-list.html',
  styleUrl: './contact-list.css',
})
export class ContactList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ContactApi);
  private readonly store = inject(ReferenceStore);
  private readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly kind = input<string>();
  readonly q = input<string>();
  readonly contactGroupId = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly kindValue = computed<ContactKind>(
    () => CONTACT_KINDS.find((candidate) => candidate === this.kind()) ?? DEFAULT_KIND,
  );
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
  protected readonly groupValue = computed(() => (OBJECT_ID.test(this.contactGroupId() ?? '') ? (this.contactGroupId() as string) : ''));
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly newRoute = computed(() => contactRoute(this.groupId(), null));
  protected readonly importExportRoute = computed(() => xlsxToolRoute('contacts', this.groupId()));
  protected readonly tabs = computed<TabItem[]>(() =>
    CONTACT_KINDS.map((kind) => ({ id: kind, label: this.i18n.t(`CONTACTS.KIND.${kind.toUpperCase()}`) })),
  );

  protected readonly entries = httpResource<ApiPage<ContactRow>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
      kind: this.kindValue(),
    };
    const filters: Record<string, string | undefined> = {
      q: this.q()?.trim(),
      contactGroupId: this.groupValue(),
      cursor: this.cursor(),
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return { url: this.api.baseUrl(this.groupId()), params };
  });

  /** The groups of contacts to filter by (a failure only leaves the filter empty). */
  private readonly groups = resource({
    params: () => this.groupId(),
    loader: ({ params }) => loadAll(this.store, params, 'contact-groups'),
  });
  protected readonly groupOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.i18n.t('CONTACTS.FILTER.ALL_GROUPS') },
    ...(this.groups.hasValue() ? this.groups.value() : []).map((group) => ({ value: group.id, label: group.name })),
  ]);

  protected readonly rows = computed(() => (this.entries.hasValue() ? this.entries.value().data : []));
  protected readonly nextCursor = computed(() => (this.entries.hasValue() ? this.entries.value().page.next : null));
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    if (error?.code === 'SERVICE_UNAVAILABLE') {
      return this.i18n.t('CONTACTS.LIST.TOO_SLOW');
    }
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<ContactRow>[]>(() => {
    const col = (key: string) => this.i18n.t(`CONTACTS.COLUMN.${key}`);
    // Only whoever may move contacts to the trash has something to select them for.
    const select: TableColumn<ContactRow>[] = this.session.can('contacts:write')
      ? [{ key: 'select', header: col('SELECT'), narrow: true }]
      : [];
    const email: TableColumn<ContactRow> = { key: 'email', header: col('EMAIL'), cell: (row) => row.email ?? '' };
    const phone: TableColumn<ContactRow> = { key: 'phone', header: col('PHONE'), hideNarrow: true, cell: (row) => row.phone ?? '' };
    const company: TableColumn<ContactRow> = { key: 'companyName', header: col('COMPANY_NAME'), sortable: true };
    const displayName: TableColumn<ContactRow> = { key: 'displayName', header: col('DISPLAY_NAME'), sortable: true };
    switch (this.kindValue()) {
      case 'suppliers':
        return [
          ...select,
          company,
          { key: 'vatNumber', header: col('VAT_NUMBER'), cell: (row) => row.company.vatNumber },
          email,
          phone,
        ];
      case 'all':
        return [...select, displayName, { key: 'type', header: col('TYPE') }, email, phone];
      default:
        return [
          ...select,
          displayName,
          { key: 'firstName', header: col('FIRST_NAME'), hideNarrow: true, cell: (row) => row.person.firstName },
          { key: 'lastName', header: col('LAST_NAME'), sortable: true, hideNarrow: true, cell: (row) => row.person.lastName },
          { ...company, hideNarrow: true },
          email,
          phone,
        ];
    }
  });
  protected readonly nameColumn = computed(() => (this.kindValue() === 'suppliers' ? 'companyName' : 'displayName'));
  protected readonly rowKey = (row: ContactRow): string => row.id;

  // Selection and bulk trash.
  protected readonly selection = linkedSignal<readonly ContactRow[], ReadonlySet<string>>({
    source: this.rows,
    computation: () => new Set<string>(),
  });
  protected readonly selectedRows = computed(() => this.rows().filter((row) => this.selection().has(row.id)));
  protected readonly allSelected = computed(() => this.rows().length > 0 && this.selectedRows().length === this.rows().length);
  protected readonly busy = signal(false);
  protected readonly trashOpen = signal(false);
  protected readonly report = signal<TrashReport | null>(null);
  protected readonly trashMessage = computed(() => this.i18n.t('CONTACTS.TRASH.CONFIRM', { count: this.selectedRows().length }));

  // Trash of one contact.
  protected readonly target = signal<ContactRow | null>(null);
  protected readonly targetOpen = signal(false);
  protected readonly targetMessage = computed(() => this.i18n.t('CONTACTS.TRASH.CONFIRM_ONE', { name: this.nameOf(this.target()) }));

  /** The name of a contact to show. */
  protected nameOf(row: ContactRow | null): string {
    return row === null ? '' : contactLabel(row);
  }

  protected detailRoute(row: ContactRow): string[] {
    return contactRoute(this.groupId(), row.id);
  }

  /** The text of the "type" column: customer, supplier or generic (a contact can be both). */
  protected typesOf(row: ContactRow): readonly string[] {
    const types = [row.customer ? 'CUSTOMER' : '', row.supplier ? 'SUPPLIER' : ''].filter((type) => type !== '');
    return types.length === 0 ? ['OTHER'] : types;
  }

  protected isSelected(row: ContactRow): boolean {
    return this.selection().has(row.id);
  }

  protected selectLabel(row: ContactRow): string {
    return this.i18n.t('CONTACTS.SELECT_ROW', { name: this.nameOf(row) });
  }

  protected toggleRow(row: ContactRow, checked: boolean): void {
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

  /** Moves the selected contacts to the trash (after the confirmation) and reports what happened to each. */
  protected async trashSelected(): Promise<void> {
    await this.trash(this.selectedRows());
    this.trashOpen.set(false);
  }

  protected askTrash(row: ContactRow): void {
    this.target.set(row);
    this.targetOpen.set(true);
  }

  protected async trashTarget(): Promise<void> {
    await this.trash([this.target() as ContactRow]);
    this.targetOpen.set(false);
  }

  protected issueText(issue: string): string {
    return this.i18n.t(`CONTACTS.TRASH.ISSUE.${issue.toUpperCase()}`);
  }

  protected reload(): void {
    this.entries.reload();
  }

  protected onKind(kind: string): void {
    this.change({ kind, q: null, contactGroupId: null });
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onGroup(value: string): void {
    this.change({ contactGroupId: value === '' ? null : value });
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

  /** Calls the bulk move to the trash for some rows and keeps what happened to each. */
  private async trash(rows: readonly ContactRow[]): Promise<void> {
    this.busy.set(true);
    try {
      const response = await this.api.trashMany(this.groupId(), rows.map((row) => row.id));
      const names = new Map(rows.map((row) => [row.id, this.nameOf(row)]));
      this.report.set({
        trashed: response.results.filter((result) => result.outcome === 'trashed').length,
        skipped: response.results
          .filter((result) => result.outcome === 'skipped')
          .map((result) => ({ id: result.id, name: names.get(result.id) ?? result.id, issue: result.issue ?? 'notFound' })),
      });
      this.store.invalidate(this.groupId(), 'customers');
      this.store.invalidate(this.groupId(), 'suppliers');
      this.entries.reload();
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    } finally {
      this.busy.set(false);
    }
  }

  private change(change: Record<string, string | null>): void {
    this.cursorStack.set([]);
    void this.navigate({ ...change, cursor: null });
  }

  private navigate(change: Record<string, string | null | undefined>): Promise<boolean> {
    return this.router.navigate([], { relativeTo: this.route, queryParams: change, queryParamsHandling: 'merge' });
  }
}
