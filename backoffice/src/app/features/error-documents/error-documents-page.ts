import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { GroupContext } from '../../core/groups/group-context';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { IconButton } from '../../shared/ui/icon-button/icon-button';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { saveFile } from '../diagnostics/diagnostics-api';
import { DealerRecord } from '../dealers/dealer.types';
import { apiErrorOf } from '../profile/sessions';
import { ErrorDocumentsApi } from './error-documents-api';
import {
  ERROR_CODE_PATTERN,
  ERROR_DOCUMENT_TYPES,
  ErrorDocumentRow,
  errorDocumentTypeKey,
  formatDay,
  isErrorDocumentType,
} from './error-documents.types';

/** Page sizes offered by the table. */
export const ERROR_DOCUMENTS_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 50;
/** Most dealers read for the filter (the API limit of a page). */
const DEALERS_LIMIT = 100;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const MAX_CODE = 10;
/** Shown for a missing value. */
const DASH = '—';

/** Query parameters of the page as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * Electronic documents refused or failed in the send queue (`/tools/error-documents`), read-only.
 * The server decides the perimeter from the role of the user; the page only passes the working
 * group, when one is chosen. Dealer (platform administrators only), document type and error code
 * filters and the cursor pagination live in the URL; the same filters drive the CSV export.
 * The error text of a row opens in a dialog, shown strictly as plain text.
 */
@Component({
  selector: 'fc-error-documents-page',
  imports: [
    Button,
    CellTemplate,
    CursorPaginator,
    DataTable,
    Dialog,
    ErrorState,
    IconButton,
    Select,
    TextField,
    TPipe,
  ],
  templateUrl: './error-documents-page.html',
  styleUrl: './error-documents-page.css',
})
export class ErrorDocumentsPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly groups = inject(GroupContext);
  private readonly api = inject(ErrorDocumentsApi);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Query parameters (bound by the router). */
  readonly dealerId = input<string>();
  readonly documentType = input<string>();
  readonly errorCode = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** The working group, `null` while a platform administrator or dealer has not chosen one. */
  protected readonly groupId = this.groups.groupId;
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (ERROR_DOCUMENTS_PAGE_SIZES as readonly number[]).includes(value)
      ? value
      : DEFAULT_LIMIT;
  });
  protected readonly typeOptions = computed(() =>
    ERROR_DOCUMENT_TYPES.map((type) => ({
      value: type,
      label: this.i18n.t(errorDocumentTypeKey(type)),
    })),
  );

  /** The dealer filter is for platform administrators (the server refuses it to a dealer). */
  protected readonly showDealerFilter = computed(
    () => this.session.me()?.role === 'PSA' && this.session.can('dealers:read'),
  );
  private readonly dealersResource = httpResource<ApiPage<DealerRecord>>(() =>
    this.showDealerFilter()
      ? { url: '/v1/dealers', params: { limit: DEALERS_LIMIT, sort: 'businessName' } }
      : undefined,
  );
  protected readonly dealerOptions = computed(() =>
    (this.dealersResource.hasValue() ? this.dealersResource.value().data : []).map((dealer) => ({
      value: dealer.id,
      label: dealer.businessName,
    })),
  );

  protected readonly codeText = linkedSignal(() => this.errorCode() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  /** Filters shared by the table and the export; the invalid ones of the URL are dropped. */
  private readonly filters = computed(() => {
    const groupId = this.groupId();
    const dealerId = this.dealerId() ?? '';
    const documentType = this.documentType();
    const code = (this.errorCode() ?? '').trim();
    const result: Record<string, string> = {};
    if (groupId !== null) {
      result['groupId'] = groupId;
    }
    if (this.showDealerFilter() && OBJECT_ID.test(dealerId)) {
      result['dealerId'] = dealerId;
    }
    if (isErrorDocumentType(documentType)) {
      result['documentType'] = documentType;
    }
    if (ERROR_CODE_PATTERN.test(code)) {
      result['errorCode'] = code;
    }
    return result;
  });

  protected readonly documents = httpResource<ApiPage<ErrorDocumentRow>>(() => {
    const params: Record<string, string | number> = { ...this.filters(), limit: this.pageSize() };
    const cursor = this.cursor();
    if (cursor) {
      params['cursor'] = cursor;
    }
    return { url: '/v1/error-documents', params };
  });

  protected readonly rows = computed(() =>
    this.documents.hasValue() ? this.documents.value().data : [],
  );
  protected readonly nextCursor = computed(() =>
    this.documents.hasValue() ? this.documents.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.documents.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<ErrorDocumentRow>[]>(() => [
    { key: 'detail', header: this.i18n.t('ERROR_DOCUMENTS.DETAIL'), narrow: true },
    {
      key: 'number',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.NUMBER'),
      cell: (row) => row.number ?? DASH,
    },
    {
      key: 'date',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.DATE'),
      cell: (row) => (row.date === null ? DASH : (formatDay(row.date) ?? DASH)),
    },
    {
      key: 'type',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.TYPE'),
      cell: (row) => this.typeText(row),
    },
    {
      key: 'customer',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.CUSTOMER'),
      cell: (row) => row.customer ?? DASH,
    },
    {
      key: 'total',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.TOTAL'),
      align: 'end',
      cell: (row) => this.money(row.total),
    },
    {
      key: 'companyName',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.COMPANY'),
      cell: (row) => row.companyName ?? DASH,
    },
    {
      key: 'groupName',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.GROUP'),
      cell: (row) => row.groupName ?? DASH,
    },
    {
      key: 'errorCode',
      header: this.i18n.t('ERROR_DOCUMENTS.COLUMN.ERROR_CODE'),
      cell: (row) => row.error?.code ?? DASH,
    },
  ]);
  protected readonly rowKey = (row: ErrorDocumentRow): string => row.id;

  /** The row whose error is shown in the dialog, `null` when closed. */
  protected readonly detail = signal<ErrorDocumentRow | null>(null);

  /** `true` while the CSV is being downloaded. */
  protected readonly downloading = signal(false);
  /** Dictionary key of the message of the last failed download, `null` when none. */
  protected readonly downloadError = signal<string | null>(null);
  protected readonly downloadStatus = computed(() => {
    const key = this.downloadError();
    if (key !== null) {
      return this.i18n.t(key);
    }
    return this.downloading() ? this.i18n.t('ERROR_DOCUMENTS.DOWNLOADING') : '';
  });

  protected onFilter(name: 'dealerId' | 'documentType', value: string): void {
    this.change({ [name]: value === '' ? null : value });
  }

  protected onCode(text: string): void {
    this.codeText.set(text);
    this.debouncer.schedule(() =>
      this.change({ errorCode: text.trim() === '' ? null : text.trim().slice(0, MAX_CODE) }),
    );
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

  protected openDetail(row: ErrorDocumentRow): void {
    this.detail.set(row);
  }

  protected closeDetail(): void {
    this.detail.set(null);
  }

  /** Downloads the CSV with the filters of the table (never the page or the cursor); its button is disabled while it runs. */
  protected async download(): Promise<void> {
    this.downloading.set(true);
    this.downloadError.set(null);
    try {
      saveFile(await this.api.download(this.filters()), `error-documents_${today()}.csv`);
    } catch (error) {
      this.downloadError.set(downloadErrorKey(error));
    } finally {
      this.downloading.set(false);
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

  /** The document type and, when known, the electronic invoice type (e.g. `Fattura TD01`). */
  private typeText(row: ErrorDocumentRow): string {
    const parts = [
      row.documentType === null ? null : this.i18n.t(errorDocumentTypeKey(row.documentType)),
      row.eInvoiceType,
    ].filter((part) => part !== null);
    return parts.length === 0 ? DASH : parts.join(' ');
  }

  private money(value: number | null): string {
    return value === null
      ? DASH
      : formatNumber(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
          style: 'currency',
          currency: 'EUR',
        });
  }
}

/** Today as `YYYY-MM-DD`. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Dictionary key of the message for a failed download, by HTTP status (the body is a blob). */
function downloadErrorKey(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 413) {
    return 'ERROR_DOCUMENTS.DOWNLOAD_ERROR.TOO_LARGE';
  }
  return status === 429
    ? 'ERROR_DOCUMENTS.DOWNLOAD_ERROR.TOO_MANY'
    : 'ERROR_DOCUMENTS.DOWNLOAD_ERROR.GENERIC';
}
