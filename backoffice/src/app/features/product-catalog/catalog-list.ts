import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import {
  BlockedBy,
  deleteFailureMessage,
  isReferenced,
  productNames,
} from './product-catalog-errors';
import { ProductCatalogApi } from './product-catalog-api';
import {
  CatalogEntry,
  catalogRoute,
  CatalogKind,
  Department,
  isEditable,
  KINDS,
  taxLabel,
  textOf,
} from './product-catalog.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;

/**
 * The departments or the brands of a group (`/groups/:groupId/product-departments` and
 * `/groups/:groupId/product-brands`, the kind comes from the route): name (and code and tax rate
 * for the departments) and state. Search by name, state filter, sort and cursor pagination live
 * in the URL. Whoever may update products creates and deletes; deleting asks for confirmation and
 * is for good, and when the server refuses (`409`) because products still use the entry they are
 * listed.
 */
@Component({
  selector: 'fc-catalog-list',
  imports: [
    Button,
    Can,
    CellTemplate,
    ConfirmDialog,
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
  templateUrl: './catalog-list.html',
  styleUrl: './catalog-list.css',
})
export class CatalogList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ProductCatalogApi);
  private readonly reference = inject(ReferenceApi);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route data, route parameter and query parameters (bound by the router). */
  readonly kind = input.required<CatalogKind>();
  readonly groupId = input.required<string>();
  readonly q = input<string>();
  readonly enabled = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly settings = computed(() => KINDS[this.kind()]);
  protected readonly isDepartments = computed(() => this.kind() === 'departments');
  protected readonly sortValue = computed(() => {
    const value = this.sort() ?? '';
    return this.settings().sortKeys.some((key) => value === key || value === `-${key}`)
      ? value
      : 'name';
  });
  protected readonly tableSort = computed<TableSort>(() => {
    const value = this.sortValue();
    return value.startsWith('-')
      ? { key: value.slice(1), direction: 'desc' }
      : { key: value, direction: 'asc' };
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return PAGE_SIZES.includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly stateValue = computed(() => {
    const value = this.enabled();
    return value === 'true' || value === 'false' ? value : '';
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly newRoute = computed(() => catalogRoute(this.groupId(), this.kind(), null));
  protected readonly stateOptions = computed(() => [
    { value: '', label: this.i18n.t('PRODUCT_CATALOG.STATE.ALL') },
    { value: 'true', label: this.i18n.t('PRODUCT_CATALOG.STATE.ENABLED') },
    { value: 'false', label: this.i18n.t('PRODUCT_CATALOG.STATE.DISABLED') },
  ]);

  protected readonly entries = httpResource<ApiPage<CatalogEntry>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const text = this.q()?.trim();
    if (text) {
      params['q'] = text;
    }
    if (this.stateValue() !== '') {
      params['enabled'] = this.stateValue();
    }
    if (this.cursor()) {
      params['cursor'] = this.cursor() as string;
    }
    return { url: this.api.baseUrl(this.groupId(), this.settings().segment), params };
  });

  protected readonly rows = computed(() => this.entries.value()?.data ?? []);
  protected readonly nextCursor = computed(() => this.entries.value()?.page.next ?? null);
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<CatalogEntry>[]>(() => {
    const name: TableColumn<CatalogEntry> = {
      key: 'name',
      header: this.i18n.t('PRODUCT_CATALOG.COLUMN.NAME'),
      sortable: true,
    };
    const state: TableColumn<CatalogEntry> = {
      key: 'enabled',
      header: this.i18n.t('PRODUCT_CATALOG.COLUMN.STATE'),
    };
    if (!this.isDepartments()) {
      return [name, state];
    }
    return [
      {
        key: 'code',
        header: this.i18n.t('PRODUCT_CATALOG.COLUMN.CODE'),
        sortable: true,
        align: 'end',
        cell: (row) => String((row as Department).code ?? ''),
      },
      name,
      {
        key: 'tax',
        header: this.i18n.t('PRODUCT_CATALOG.COLUMN.TAX'),
        hideNarrow: true,
        cell: (row) => {
          const tax = (row as Department).tax;
          return tax === null ? '' : taxLabel(tax);
        },
      },
      state,
    ];
  });
  protected readonly rowKey = (row: CatalogEntry): string => row.id;

  // Deletion.
  protected readonly target = signal<CatalogEntry | null>(null);
  protected readonly confirmOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly blocked = signal<BlockedBy | null>(null);
  protected readonly confirmMessage = computed(() =>
    this.text('DELETE.CONFIRM', { name: this.nameOf(this.target()) }),
  );

  /** The text of the kind (`PRODUCT_CATALOG.<DEPARTMENTS|BRANDS>.<part>`). */
  protected text(part: string, params?: Record<string, string | number>): string {
    return this.i18n.t(`PRODUCT_CATALOG.${this.settings().text}.${part}`, params);
  }

  /** The name of an entry in the language of the user (empty for none). */
  protected nameOf(entry: CatalogEntry | null): string {
    return entry === null ? '' : textOf(entry.name, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }

  protected editable(row: CatalogEntry): boolean {
    return isEditable(row);
  }

  protected detailRoute(row: CatalogEntry): string[] {
    return catalogRoute(this.groupId(), this.kind(), row.id);
  }

  protected askDelete(row: CatalogEntry): void {
    this.blocked.set(null);
    this.target.set(row);
    this.confirmOpen.set(true);
  }

  protected async delete(): Promise<void> {
    const entry = this.target() as CatalogEntry;
    const name = this.nameOf(entry);
    this.busy.set(true);
    try {
      await this.api.remove(this.groupId(), this.settings().segment, entry.id);
    } catch (error) {
      if (isReferenced(error)) {
        this.blocked.set({
          entry: name,
          products: await productNames(this.reference, this.groupId(), error),
        });
      } else {
        this.toast.error(deleteFailureMessage(this.i18n, error));
        this.entries.reload();
      }
      return;
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
    this.toast.success(this.text('DELETE.DONE', { name }));
    this.entries.reload();
  }

  protected reload(): void {
    this.entries.reload();
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onState(value: string): void {
    this.change({ enabled: value === '' ? null : value });
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
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: change,
      queryParamsHandling: 'merge',
    });
  }
}
