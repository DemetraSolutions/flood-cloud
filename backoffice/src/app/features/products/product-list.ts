import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, linkedSignal, resource, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catalogXlsxRoute } from '../catalog-xlsx/catalog-xlsx.types';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate, formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { SearchCombobox, SearchOption } from '../../shared/ui/search-combobox/search-combobox';
import { Select, SelectOption } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { failureMessage } from '../../shared/forms/form-errors';
import { loadAll } from '../places/lookup-loader';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import { CATEGORIES_SEGMENT, CategoryNode, flatten, nodeName } from '../product-categories/category.types';
import { apiErrorOf } from '../profile/sessions';
import { ProductApi } from './product-api';
import { FAMILIES, FamilySettings, ProductFamily, ProductRow, ProductTrashResult, productRoute } from './product.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['code', 'name', 'updatedAt'];
const DEFAULT_SORT = '-updatedAt';
const OBJECT_ID = /^[0-9a-f]{24}$/;

/** What the user is told after moving the selected products to the trash. */
export interface TrashReport {
  /** How many products went to the trash. */
  readonly trashed: number;
  /** The products that did not, with the reason. */
  readonly skipped: readonly { readonly id: string; readonly name: string; readonly issue: string }[];
}

/**
 * The products of a family of a group (`/groups/:groupId/products`, `services`, `product-modifiers`
 * or `tobacco-products`: the family is route data) as the legacy page showed them: a table with the
 * selection, the code, the name, the stock (with `warehouse`: the total, `C` for a bill of
 * materials, a dash for a product that does not move the warehouse), the price of the default
 * price list, the last supplier, the date of the last change and the state. The search (name, code
 * or barcode), the filters (category, supplier, store, favorites, state), the sort and the cursor
 * pagination live in the URL. Whoever may update products creates (also "quick"), edits (also
 * "quick"), duplicates, turns on and off and moves to the trash, one by one or the selected ones,
 * for the products the server says are entirely theirs (`editable`); a bulk move ends in a summary
 * of what happened to each product.
 */
@Component({
  selector: 'fc-product-list',
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
    SearchCombobox,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './product-list.html',
  styleUrl: './product-list.css',
})
export class ProductList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ProductApi);
  private readonly catalog = inject(ProductCatalogApi);
  private readonly store = inject(ReferenceStore);
  private readonly reference = inject(ReferenceApi);
  private readonly features = inject(GroupFeatures);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter, route data and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly family = input<string>();
  readonly q = input<string>();
  readonly categoryId = input<string>();
  readonly supplierId = input<string>();
  readonly placeId = input<string>();
  readonly favorite = input<string>();
  readonly enabled = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  protected readonly settings = computed<FamilySettings>(() => {
    const family = this.family() as ProductFamily | undefined;
    return FAMILIES[family !== undefined && Object.hasOwn(FAMILIES, family) ? family : 'products'];
  });
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
  protected readonly stateValue = computed(() => (this.enabled() === 'true' || this.enabled() === 'false' ? (this.enabled() as string) : ''));
  protected readonly categoryValue = computed(() => (OBJECT_ID.test(this.categoryId() ?? '') ? (this.categoryId() as string) : ''));
  protected readonly placeValue = computed(() => (OBJECT_ID.test(this.placeId() ?? '') ? (this.placeId() as string) : ''));
  protected readonly supplierValue = computed(() => (OBJECT_ID.test(this.supplierId() ?? '') ? (this.supplierId() as string) : ''));
  protected readonly favoriteOnly = computed(() => this.favorite() === 'true');
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly importExportRoute = computed(() => catalogXlsxRoute(this.groupId()));
  protected readonly newRoute = computed(() => productRoute(this.groupId(), this.settings().family, null));
  protected readonly hasWarehouse = computed(() => this.features.enabledFor(this.groupId(), 'warehouse'));
  protected readonly stateOptions = computed(() => [
    { value: '', label: this.i18n.t('PRODUCT_CATALOG.STATE.ALL') },
    { value: 'true', label: this.i18n.t('PRODUCT_CATALOG.STATE.ENABLED') },
    { value: 'false', label: this.i18n.t('PRODUCT_CATALOG.STATE.DISABLED') },
  ]);

  protected readonly entries = httpResource<ApiPage<ProductRow>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
      family: this.settings().family,
    };
    const filters: Record<string, string | undefined> = {
      q: this.q()?.trim(),
      categoryId: this.categoryValue(),
      placeId: this.placeValue(),
      supplierId: this.supplierValue(),
      favorite: this.favoriteOnly() ? 'true' : undefined,
      enabled: this.stateValue(),
      cursor: this.cursor(),
    };
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params[name] = value;
      }
    }
    return { url: this.api.baseUrl(this.groupId()), params };
  });

  /** The categories and the stores to filter by (a failure only leaves the filter empty). */
  private readonly tree = httpResource<ApiData<CategoryNode[]>>(() => `${this.catalog.baseUrl(this.groupId(), CATEGORIES_SEGMENT)}/tree`);
  private readonly places = resource({
    params: () => this.groupId(),
    loader: ({ params }) => loadAll(this.store, params, 'places'),
  });
  /** The suppliers the user can filter by, searched on the server. */
  protected readonly searchSuppliers = (text: string): Promise<readonly SearchOption[]> =>
    this.reference.lookup(this.groupId(), 'suppliers', { q: text, limit: 25 }).then((page) => page.data.map((item) => ({ value: item.id, label: item.name })));
  /** The name of the supplier of the filter, read by id. */
  private readonly supplierNames = resource({
    params: () => (this.supplierValue() === '' ? undefined : { groupId: this.groupId(), id: this.supplierValue() }),
    loader: async ({ params }) => (await this.reference.lookupNames(params.groupId, 'suppliers', [params.id]))[params.id] ?? null,
  });
  protected readonly supplierLabel = computed(() => (this.supplierNames.hasValue() ? this.supplierNames.value() : null));
  protected readonly categoryOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.i18n.t('PRODUCTS.FILTER.ALL_CATEGORIES') },
    ...(this.tree.hasValue() ? flatten(this.tree.value().data) : []).map(({ node, level }) => ({
      value: node.id,
      label: `${'– '.repeat(level)}${nodeName(node, this.i18n.t('PRODUCT_CATEGORIES.NO_NAME'))}`,
    })),
  ]);
  protected readonly placeOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.i18n.t('PRODUCTS.FILTER.ALL_PLACES') },
    ...(this.places.hasValue() ? this.places.value() : []).map((place) => ({ value: place.id, label: place.name })),
  ]);

  protected readonly rows = computed(() => (this.entries.hasValue() ? this.entries.value().data : []));
  protected readonly nextCursor = computed(() => (this.entries.hasValue() ? this.entries.value().page.next : null));
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  private readonly language = computed(() => this.i18n.language() ?? DEFAULT_LANGUAGE);

  protected readonly columns = computed<TableColumn<ProductRow>[]>(() => {
    const col = (key: string) => this.i18n.t(`PRODUCTS.COLUMN.${key}`);
    const columns: TableColumn<ProductRow>[] = [
      { key: 'select', header: col('SELECT'), narrow: true },
      { key: 'code', header: col('CODE'), sortable: true, cell: (row) => row.code ?? '' },
      { key: 'name', header: col('NAME'), sortable: true },
    ];
    if (this.hasWarehouse()) {
      columns.push({ key: 'stock', header: col('STOCK'), align: 'end', cell: (row) => this.stockText(row) });
    }
    columns.push(
      { key: 'price', header: col('PRICE'), align: 'end', cell: (row) => (row.price === null ? '' : formatNumber(row.price, this.language(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })) },
      { key: 'supplier', header: col('LAST_SUPPLIER'), hideNarrow: true, cell: (row) => row.lastSupplierName ?? '-' },
      { key: 'updatedAt', header: col('UPDATED'), sortable: true, hideNarrow: true, cell: (row) => (row.updatedAt === null ? '' : formatDate(row.updatedAt, this.language(), { dateStyle: 'medium', timeStyle: 'short' })) },
      { key: 'enabled', header: col('STATE') },
    );
    return columns;
  });
  protected readonly rowKey = (row: ProductRow): string => row.id;

  // Selection and bulk trash.
  protected readonly selection = linkedSignal<readonly ProductRow[], ReadonlySet<string>>({
    source: this.rows,
    computation: () => new Set<string>(),
  });
  protected readonly selectable = computed(() => this.rows().filter((row) => row.editable));
  protected readonly selectedRows = computed(() => this.selectable().filter((row) => this.selection().has(row.id)));
  protected readonly allSelected = computed(() => this.selectable().length > 0 && this.selectedRows().length === this.selectable().length);
  protected readonly busy = signal(false);
  protected readonly trashOpen = signal(false);
  protected readonly report = signal<TrashReport | null>(null);
  protected readonly trashMessage = computed(() => this.i18n.t('PRODUCTS.TRASH.CONFIRM', { count: this.selectedRows().length }));

  // Trash of one product.
  protected readonly target = signal<ProductRow | null>(null);
  protected readonly targetOpen = signal(false);
  protected readonly targetMessage = computed(() => this.i18n.t('PRODUCTS.TRASH.CONFIRM_ONE', { name: this.nameOf(this.target()) }));

  constructor() {
    // Platform administrators and dealers: the features of the group decide the stock column.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.features.ensure(groupId));
    });
  }

  /** The name of a product (empty for none). */
  protected nameOf(row: ProductRow | null): string {
    return row?.name ?? '';
  }

  protected detailRoute(row: ProductRow, view?: 'quick'): { commands: string[]; query: Record<string, string> } {
    return { commands: productRoute(this.groupId(), row.family, row.id), query: view === undefined ? {} : { view } };
  }

  /** The stock of a row: the total, `C` for a bill of materials and a dash for a product that does not move the warehouse. */
  private stockText(row: ProductRow): string {
    if (row.stock.composite) {
      return 'C';
    }
    return row.stock.quantity === null ? '-' : formatNumber(row.stock.quantity, this.language(), { maximumFractionDigits: 6 });
  }

  protected isSelected(row: ProductRow): boolean {
    return this.selection().has(row.id);
  }

  protected selectLabel(row: ProductRow): string {
    return this.i18n.t('PRODUCTS.SELECT_ROW', { name: this.nameOf(row) });
  }

  protected toggleRow(row: ProductRow, checked: boolean): void {
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

  /** Moves the selected products to the trash (after the confirmation) and reports what happened to each. */
  protected async trashSelected(): Promise<void> {
    await this.trash(this.selectedRows());
    this.trashOpen.set(false);
  }

  protected askTrash(row: ProductRow): void {
    this.target.set(row);
    this.targetOpen.set(true);
  }

  protected async trashTarget(): Promise<void> {
    await this.trash([this.target() as ProductRow]);
    this.targetOpen.set(false);
  }

  /** Duplicates a product; the copy is named after it. */
  protected async duplicate(row: ProductRow): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.duplicate(this.groupId(), row.id, crypto.randomUUID());
      this.toast.success(this.i18n.t('PRODUCTS.DUPLICATE.DONE', { name: this.nameOf(row) }));
      this.refresh();
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Turns a product on or off (the product is read first: the list has no versions). */
  protected async toggleEnabled(row: ProductRow): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.setEnabled(this.groupId(), row.id, !row.enabled);
      this.toast.success(this.i18n.t(row.enabled ? 'PRODUCTS.ENABLE.OFF' : 'PRODUCTS.ENABLE.ON', { name: this.nameOf(row) }));
      this.refresh();
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
      this.entries.reload();
    } finally {
      this.busy.set(false);
    }
  }

  protected issueText(issue: string): string {
    return this.i18n.t(`PRODUCTS.TRASH.ISSUE.${issue.toUpperCase()}`);
  }

  protected reload(): void {
    this.entries.reload();
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onSupplier(option: SearchOption | null): void {
    this.change({ supplierId: option === null ? null : option.value });
  }

  protected onCategory(value: string): void {
    this.change({ categoryId: value === '' ? null : value });
  }

  protected onPlace(value: string): void {
    this.change({ placeId: value === '' ? null : value });
  }

  protected onState(value: string): void {
    this.change({ enabled: value === '' ? null : value });
  }

  protected onFavorite(checked: boolean): void {
    this.change({ favorite: checked ? 'true' : null });
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
  private async trash(rows: readonly ProductRow[]): Promise<void> {
    this.busy.set(true);
    try {
      const response = await this.api.trashMany(this.groupId(), rows.map((row) => row.id));
      const names = new Map(rows.map((row) => [row.id, this.nameOf(row)]));
      this.report.set({
        trashed: response.results.filter((result: ProductTrashResult) => result.outcome === 'trashed').length,
        skipped: response.results
          .filter((result: ProductTrashResult) => result.outcome === 'skipped')
          .map((result) => ({ id: result.id, name: names.get(result.id) ?? result.id, issue: result.issue ?? 'notFound' })),
      });
      this.refresh();
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    } finally {
      this.busy.set(false);
    }
  }

  /** The lists of the group that show products are read again after a change. */
  private refresh(): void {
    this.store.invalidate(this.groupId(), 'products');
    this.entries.reload();
  }

  private change(change: Record<string, string | null>): void {
    this.cursorStack.set([]);
    void this.navigate({ ...change, cursor: null });
  }

  private navigate(change: Record<string, string | null | undefined>): Promise<boolean> {
    return this.router.navigate([], { relativeTo: this.route, queryParams: change, queryParamsHandling: 'merge' });
  }
}
