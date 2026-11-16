import { httpResource } from '@angular/common/http';
import {
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { Can } from '../../core/auth/can';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn, TableSort } from '../../shared/ui/data-table/data-table.types';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import { importFailure, ImportFailure } from './tobaccos-import-error';
import { TobaccosApi } from './tobaccos-api';
import {
  checkWorkbook,
  FileProblem,
  TOBACCO_SORTS,
  TobaccoImportResult,
  TobaccoRow,
} from './tobaccos.types';

/** Page sizes offered by the table. */
export const TOBACCO_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_LIMIT = 100;
/** Shown for a missing value. */
const DASH = '—';

/** Dictionary keys of the messages about a file that cannot be sent. */
const FILE_PROBLEM_KEYS: Readonly<Record<FileProblem, string>> = {
  type: 'TOBACCOS.IMPORT.CLIENT_ERROR.TYPE',
  size: 'TOBACCOS.IMPORT.CLIENT_ERROR.SIZE',
  empty: 'TOBACCOS.IMPORT.CLIENT_ERROR.EMPTY',
};

/**
 * The national tobacco price list of the platform (`/tools/tobaccos`, PSA only): the products with the columns of the legacy table, with search, sort and cursor pagination in the URL. Who may import
 * (`tobaccos:import`) chooses the official `.xlsx` file, and the whole list is replaced only after an explicit confirmation that says so; the result, or what is wrong in the file with the row and the column, is
 * shown after the answer.
 */
@Component({
  selector: 'fc-tobaccos-page',
  imports: [Button, Can, ConfirmDialog, CursorPaginator, DataTable, ErrorState, TextField, TPipe],
  templateUrl: './tobaccos-page.html',
  styleUrl: './tobaccos-page.css',
})
export class TobaccosPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(TobaccosApi);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Query parameters (bound by the router). */
  readonly q = input<string>();
  readonly sort = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** The file input (hidden): the visible button opens it. */
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  protected readonly sortValue = computed(() => {
    const value = this.sort() ?? '';
    return TOBACCO_SORTS.some((key) => value === key || value === `-${key}`) ? value : 'code';
  });
  protected readonly tableSort = computed<TableSort>(() => {
    const value = this.sortValue();
    return value.startsWith('-')
      ? { key: value.slice(1), direction: 'desc' }
      : { key: value, direction: 'asc' };
  });
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (TOBACCO_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  protected readonly products = httpResource<ApiPage<TobaccoRow>>(() => {
    const params: Record<string, string | number> = {
      limit: this.pageSize(),
      sort: this.sortValue(),
    };
    const text = this.q()?.trim();
    if (text) {
      params['q'] = text;
    }
    if (this.cursor()) {
      params['cursor'] = this.cursor() as string;
    }
    return { url: '/v1/tobaccos', params };
  });

  protected readonly rows = computed(() => this.products.value()?.data ?? []);
  protected readonly nextCursor = computed(() => this.products.value()?.page.next ?? null);
  protected readonly loadError = computed(() => apiErrorOf(this.products.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<TobaccoRow>[]>(() => [
    {
      key: 'code',
      header: this.i18n.t('TOBACCOS.COLUMN.CODE'),
      sortable: true,
      cell: (row) => row.code,
    },
    {
      key: 'name',
      header: this.i18n.t('TOBACCOS.COLUMN.NAME'),
      sortable: true,
      cell: (r) => r.name,
    },
    {
      key: 'category',
      header: this.i18n.t('TOBACCOS.COLUMN.CATEGORY'),
      sortable: true,
      hideNarrow: true,
      cell: (row) => row.category,
    },
    {
      key: 'priceKg',
      header: this.i18n.t('TOBACCOS.COLUMN.PRICE_KG'),
      sortable: true,
      align: 'end',
      hideNarrow: true,
      cell: (row) => this.amount(row.priceKg),
    },
    {
      key: 'price',
      header: this.i18n.t('TOBACCOS.COLUMN.PRICE'),
      sortable: true,
      align: 'end',
      cell: (row) => this.amount(row.price),
    },
    {
      key: 'barcode',
      header: this.i18n.t('TOBACCOS.COLUMN.BARCODE'),
      sortable: true,
      hideNarrow: true,
      cell: (row) => row.barcode ?? DASH,
    },
  ]);
  protected readonly rowKey = (row: TobaccoRow): string => row.id;

  // The import.
  /** The file waiting for the confirmation. */
  protected readonly pending = signal<File | null>(null);
  protected readonly confirmOpen = signal(false);
  protected readonly busy = signal(false);
  /** Message about a file that was refused before being sent, `null` when none. */
  protected readonly pickError = signal<string | null>(null);
  protected readonly result = signal<TobaccoImportResult | null>(null);
  protected readonly failure = signal<ImportFailure | null>(null);
  /** The `Idempotency-Key` of the submission of the pending file: the same on every retry of it. */
  private key = '';
  /** What identifies the file the key was made for (name, size, date): choosing the same file again after a failure sends the same key. */
  private keyFor = '';
  protected readonly confirmMessage = computed(() =>
    this.i18n.t('TOBACCOS.IMPORT.CONFIRM', { name: this.pending()?.name ?? '' }),
  );
  protected readonly resultMessage = computed(() => {
    const result = this.result();
    if (result === null) {
      return '';
    }
    const language = this.i18n.language() ?? DEFAULT_LANGUAGE;
    return this.i18n.t('TOBACCOS.IMPORT.DONE', {
      inserted: formatNumber(result.inserted, language),
      previous: formatNumber(result.previous, language),
      seconds: formatNumber(result.elapsedMs / 1000, language, { maximumFractionDigits: 1 }),
    });
  });
  protected readonly statusMessage = computed(() =>
    this.busy() ? this.i18n.t('TOBACCOS.IMPORT.RUNNING') : this.resultMessage(),
  );
  /** The problems of the refusal as sentences; read only while a refusal is shown. */
  protected readonly failureProblems = computed(() =>
    (this.failure() as ImportFailure).problems.map((problem) =>
      this.i18n.t('TOBACCOS.IMPORT.PROBLEM', {
        row: problem.row,
        column: this.i18n.t(problem.columnKey, problem.columnParams),
        message: this.i18n.t(issueMessageKey(problem.issue)),
      }),
    ),
  );

  /** Opens the file chooser. */
  protected choose(): void {
    this.fileInput().nativeElement.click();
  }

  /** A file was chosen: it is checked here for convenience only, then the user is asked to confirm the replacement of the whole list. */
  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    // Cleared so that choosing the same file again fires the event again.
    input.value = '';
    this.result.set(null);
    this.failure.set(null);
    if (file === null) {
      return;
    }
    const problem = checkWorkbook(file);
    this.pickError.set(problem === null ? null : this.i18n.t(FILE_PROBLEM_KEYS[problem]));
    if (problem === null) {
      this.pending.set(file);
      const identity = `${file.name}:${String(file.size)}:${String(file.lastModified)}`;
      if (identity !== this.keyFor) {
        this.key = crypto.randomUUID();
        this.keyFor = identity;
      }
      this.confirmOpen.set(true);
    }
  }

  /** The confirmation dialog was closed without confirming: the file is forgotten. */
  protected onConfirmClosed(): void {
    this.confirmOpen.set(false);
    this.pending.set(null);
  }

  /** Sends the file; the list is read again from its first page when the server replaced it. */
  protected async confirmImport(): Promise<void> {
    const file = this.pending() as File;
    this.busy.set(true);
    try {
      const result = await this.api.import(file, this.key);
      this.keyFor = '';
      this.result.set(result);
      this.toast.success(this.resultMessage());
      this.cursorStack.set([]);
      await this.navigate({ cursor: null });
      this.products.reload();
    } catch (error) {
      this.failure.set(importFailure(this.i18n, error));
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
      this.pending.set(null);
    }
  }

  protected reload(): void {
    this.products.reload();
  }

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
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

  private amount(value: number | null): string {
    return value === null
      ? DASH
      : formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        });
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
