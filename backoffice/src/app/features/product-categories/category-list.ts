import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catalogXlsxRoute } from '../catalog-xlsx/catalog-xlsx.types';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { GroupFeatures } from '../../core/groups/group-features';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { EmptyState } from '../../shared/ui/empty-state/empty-state';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { ProductCatalogApi } from '../product-catalog/product-catalog-api';
import { deleteFailureMessage } from '../product-catalog/product-catalog-errors';
import { textOf } from '../product-catalog/product-catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { CategoryBlock, isReferenced, referenceGroups } from './category-errors';
import { CategoryTreeView } from './category-tree-view';
import {
  Category,
  CATEGORIES_SEGMENT,
  categoryRoute,
  CategoryNode,
  flatten,
  hasHiddenParent,
  isCategoryEditable,
} from './category.types';

const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 25;
const SORT_KEYS = ['name', 'position'];

/** The two views of the categories. */
type View = 'table' | 'tree';

/**
 * The categories of a group (`/groups/:groupId/product-categories`) as the legacy page showed
 * them: a table (name with an indent for the level, parent, position, availability on the cash
 * app, state, date of the last change) and, as a second view, the same categories as an accessible
 * tree. The table has the name search, the state filter, the sort and the cursor pagination in
 * the URL, like the view itself. A category with a cycle of parents of the old system is flagged
 * with a warning that does not block anything. Whoever may update products creates, changes and
 * deletes; deleting asks for confirmation, is for good and never takes the subcategories with
 * it: when the server refuses (`409`) what still refers to the category is listed.
 */
@Component({
  selector: 'fc-category-list',
  imports: [
    Button,
    Can,
    CategoryTreeView,
    CellTemplate,
    ConfirmDialog,
    CursorPaginator,
    DataTable,
    EmptyState,
    ErrorState,
    RouterLink,
    RowActionsTemplate,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './category-list.html',
  styleUrl: './category-list.css',
})
export class CategoryList {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ProductCatalogApi);
  private readonly reference = inject(ReferenceApi);
  private readonly store = inject(ReferenceStore);
  private readonly features = inject(GroupFeatures);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter and query parameters (bound by the router). */
  readonly groupId = input.required<string>();
  readonly q = input<string>();
  readonly enabled = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();
  readonly view = input<string>();

  protected readonly viewValue = computed<View>(() => (this.view() === 'tree' ? 'tree' : 'table'));
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
    return PAGE_SIZES.includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly stateValue = computed(() => {
    const value = this.enabled();
    return value === 'true' || value === 'false' ? value : '';
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly importExportRoute = computed(() => catalogXlsxRoute(this.groupId()));
  protected readonly newRoute = computed(() => categoryRoute(this.groupId(), null));
  protected readonly hasCash = computed(() => this.features.enabledFor(this.groupId(), 'cash'));
  protected readonly stateOptions = computed(() => [
    { value: '', label: this.i18n.t('PRODUCT_CATALOG.STATE.ALL') },
    { value: 'true', label: this.i18n.t('PRODUCT_CATALOG.STATE.ENABLED') },
    { value: 'false', label: this.i18n.t('PRODUCT_CATALOG.STATE.DISABLED') },
  ]);

  protected readonly entries = httpResource<ApiPage<Category>>(() => {
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
    return {
      url: this.api.baseUrl(this.groupId(), CATEGORIES_SEGMENT),
      params,
    };
  });

  /** The whole tree, for the tree view and for the names of the parents. */
  protected readonly tree = httpResource<ApiData<CategoryNode[]>>(
    () => `${this.api.baseUrl(this.groupId(), CATEGORIES_SEGMENT)}/tree`,
  );
  protected readonly treeNodes = computed(() => (this.tree.hasValue() ? this.tree.value().data : []));
  private readonly parentNames = computed(
    () => new Map(flatten(this.treeNodes()).map(({ node }) => [node.id, node.name] as const)),
  );

  protected readonly rows = computed(() => (this.entries.hasValue() ? this.entries.value().data : []));
  protected readonly nextCursor = computed(() => (this.entries.hasValue() ? this.entries.value().page.next : null));
  protected readonly anyCyclic = computed(() => this.rows().some((row) => row.cyclic));
  protected readonly loadError = computed(() => apiErrorOf(this.entries.error()));
  protected readonly treeError = computed(() => apiErrorOf(this.tree.error()));
  protected readonly errorMessage = computed(() => this.messageOf(this.loadError()));
  protected readonly treeErrorMessage = computed(() => this.messageOf(this.treeError()));

  protected readonly columns = computed<TableColumn<Category>[]>(() => {
    const col = (key: string) => this.i18n.t(`PRODUCT_CATEGORIES.COLUMN.${key}`);
    const language = this.i18n.language() ?? DEFAULT_LANGUAGE;
    const columns: TableColumn<Category>[] = [
      { key: 'name', header: col('NAME'), sortable: true },
      {
        key: 'parent',
        header: col('PARENT'),
        hideNarrow: true,
        cell: (row) => this.parentOf(row),
      },
      {
        key: 'position',
        header: col('POSITION'),
        sortable: true,
        align: 'end',
        cell: (row) => String(row.position ?? ''),
      },
    ];
    if (this.hasCash()) {
      columns.push({
        key: 'pos',
        header: col('POS'),
        hideNarrow: true,
        cell: (row) =>
          row.availability?.pos === undefined
            ? ''
            : this.i18n.t(row.availability.pos ? 'COMMON.YES' : 'COMMON.NO'),
      });
    }
    columns.push(
      { key: 'enabled', header: col('STATE') },
      {
        key: 'updatedAt',
        header: col('UPDATED'),
        hideNarrow: true,
        cell: (row) =>
          row.updatedAt === null
            ? ''
            : formatDate(row.updatedAt, language, { dateStyle: 'medium', timeStyle: 'short' }),
      },
    );
    return columns;
  });
  protected readonly rowKey = (row: Category): string => row.id;

  // Deletion.
  protected readonly target = signal<Category | null>(null);
  protected readonly confirmOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly blocked = signal<CategoryBlock | null>(null);
  protected readonly confirmMessage = computed(() =>
    this.i18n.t('PRODUCT_CATEGORIES.DELETE.CONFIRM', { name: this.nameOf(this.target()) }),
  );

  constructor() {
    // Platform administrators and dealers: the features of the group decide the cash column.
    effect(() => {
      const groupId = this.groupId();
      untracked(() => void this.features.ensure(groupId));
    });
  }

  /** The name of a category in the language of the user (empty for none). */
  protected nameOf(category: Category | null): string {
    return category === null ? '' : textOf(category.name, this.i18n.language() ?? DEFAULT_LANGUAGE);
  }

  /** The name of the parent of a row, the notice when the user cannot see it. */
  private parentOf(row: Category): string {
    if (hasHiddenParent(row)) {
      return this.i18n.t('PRODUCT_CATEGORIES.PARENT_HIDDEN');
    }
    return row.parentId === null ? '' : (this.parentNames().get(row.parentId) ?? '');
  }

  /** The text of the kind of reference of a deletion that is refused. */
  protected kindLabel(kind: string): string {
    return this.i18n.t(`PRODUCT_CATEGORIES.REFERENCE.${kind}`);
  }

  protected indent(row: Category): number {
    return (row.depth ?? 0) * 1.25;
  }

  protected editable(row: Category): boolean {
    return isCategoryEditable(row);
  }

  protected detailRoute(id: string): string[] {
    return categoryRoute(this.groupId(), id);
  }

  protected openNode(id: string): void {
    void this.router.navigate(this.detailRoute(id));
  }

  protected askDelete(row: Category): void {
    this.blocked.set(null);
    this.target.set(row);
    this.confirmOpen.set(true);
  }

  protected async delete(): Promise<void> {
    const category = this.target() as Category;
    const name = this.nameOf(category);
    this.busy.set(true);
    try {
      await this.api.remove(this.groupId(), CATEGORIES_SEGMENT, category.id);
    } catch (error) {
      if (isReferenced(error)) {
        this.blocked.set({
          category: name,
          groups: await referenceGroups(this.reference, this.groupId(), error),
        });
      } else {
        this.toast.error(deleteFailureMessage(this.i18n, error));
        this.refresh();
      }
      return;
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
    this.toast.success(this.i18n.t('PRODUCT_CATEGORIES.DELETE.DONE', { name }));
    this.refresh();
  }

  protected reload(): void {
    this.entries.reload();
  }

  protected reloadTree(): void {
    this.tree.reload();
  }

  protected onView(view: View): void {
    this.cursorStack.set([]);
    void this.navigate({ view: view === 'tree' ? 'tree' : null, cursor: null });
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

  /** The lists of the group that show categories are read again after a deletion. */
  private refresh(): void {
    this.store.invalidate(this.groupId(), 'product-categories');
    this.entries.reload();
    this.tree.reload();
  }

  private messageOf(error: ReturnType<typeof apiErrorOf>): string {
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
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
