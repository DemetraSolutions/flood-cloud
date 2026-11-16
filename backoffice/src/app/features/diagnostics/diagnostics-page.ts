import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { GroupContext } from '../../core/groups/group-context';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import { Button } from '../../shared/ui/button/button';
import { CursorPaginator } from '../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { loadAll } from '../places/lookup-loader';
import { apiErrorOf } from '../profile/sessions';
import { DiagnosticsApi, saveFile } from './diagnostics-api';
import { DEVICE_TYPES, deviceTypeKey, DiagnosticRow, isDeviceType } from './diagnostics.types';

/** Page sizes offered by the table. */
export const DIAGNOSTICS_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_LIMIT = 50;
const OBJECT_ID = /^[0-9a-f]{24}$/;
const MAX_SEARCH = 64;
/** Shown for a missing value. */
const DASH = '—';

/** Query parameters of the page as kept in the URL (`null` removes one). */
type QueryChange = Record<string, string | null>;

/**
 * Diagnostics of the devices of the places (`/tools/diagnostics`): one table whose perimeter the
 * server decides from the role of the user; the page only passes the working group, when one is
 * chosen. Search, company, place and type filters and the cursor pagination live in the URL; the
 * same filters drive the CSV export.
 */
@Component({
  selector: 'fc-diagnostics-page',
  imports: [
    Button,
    CellTemplate,
    CursorPaginator,
    DataTable,
    ErrorState,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './diagnostics-page.html',
  styleUrl: './diagnostics-page.css',
})
export class DiagnosticsPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly groups = inject(GroupContext);
  private readonly store = inject(ReferenceStore);
  private readonly api = inject(DiagnosticsApi);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Query parameters (bound by the router). */
  readonly q = input<string>();
  readonly companyId = input<string>();
  readonly placeId = input<string>();
  readonly type = input<string>();
  readonly limit = input<string>();
  readonly cursor = input<string>();

  /** The working group, `null` while a platform administrator or dealer has not chosen one. */
  protected readonly groupId = this.groups.groupId;
  protected readonly pageSize = computed(() => {
    const value = Number(this.limit());
    return (DIAGNOSTICS_PAGE_SIZES as readonly number[]).includes(value) ? value : DEFAULT_LIMIT;
  });
  protected readonly typeOptions = computed(() =>
    DEVICE_TYPES.map((type) => ({ value: type, label: this.i18n.t(deviceTypeKey(type)) })),
  );

  /** Companies of the working group (the filter); read only with a group and the permission. */
  private readonly companiesResource = resource({
    params: () => (this.session.can('companies:read') ? this.groupId() : null),
    loader: ({ params }) =>
      params === null ? Promise.resolve([]) : loadAll(this.store, params, 'companies'),
  });
  /** Places of the working group (the filter). */
  private readonly placesResource = resource({
    params: () => this.groupId(),
    loader: ({ params }) =>
      params === null ? Promise.resolve([]) : loadAll(this.store, params, 'places'),
  });
  protected readonly companyOptions = computed(() =>
    (this.companiesResource.hasValue() ? this.companiesResource.value() : []).map((item) => ({
      value: item.id,
      label: item.name,
    })),
  );
  protected readonly placeOptions = computed(() => {
    const companyId = this.companyId();
    return (this.placesResource.hasValue() ? this.placesResource.value() : [])
      .filter((item) => !OBJECT_ID.test(companyId ?? '') || item.companyId === companyId)
      .map((item) => ({ value: item.id, label: item.name }));
  });

  protected readonly searchText = linkedSignal(() => this.q() ?? '');
  protected readonly cursorStack = signal<readonly (string | null)[]>([]);

  /** Filters shared by the table and the export; the ones of a group only apply with a group. */
  private readonly filters = computed(() => {
    const groupId = this.groupId();
    const companyId = this.companyId() ?? '';
    const placeId = this.placeId() ?? '';
    const type = this.type();
    const q = (this.q() ?? '').trim().slice(0, MAX_SEARCH);
    const result: Record<string, string> = {};
    if (groupId !== null) {
      result['groupId'] = groupId;
      if (OBJECT_ID.test(companyId)) {
        result['companyId'] = companyId;
      }
      if (OBJECT_ID.test(placeId)) {
        result['placeId'] = placeId;
      }
    }
    if (isDeviceType(type)) {
      result['type'] = type;
    }
    if (q !== '') {
      result['q'] = q;
    }
    return result;
  });

  protected readonly devices = httpResource<ApiPage<DiagnosticRow>>(() => {
    const params: Record<string, string | number> = { ...this.filters(), limit: this.pageSize() };
    const cursor = this.cursor();
    if (cursor) {
      params['cursor'] = cursor;
    }
    return { url: '/v1/diagnostics/devices', params };
  });

  protected readonly rows = computed(() =>
    this.devices.hasValue() ? this.devices.value().data : [],
  );
  protected readonly nextCursor = computed(() =>
    this.devices.hasValue() ? this.devices.value().page.next : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.devices.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<DiagnosticRow>[]>(() => [
    ...(this.groupId() === null
      ? [
          {
            key: 'groupName',
            header: this.i18n.t('DIAGNOSTICS.COLUMN.GROUP'),
            cell: (row: DiagnosticRow) => row.groupName,
          },
        ]
      : []),
    {
      key: 'companyName',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.COMPANY'),
      cell: (row) => row.companyName ?? DASH,
    },
    {
      key: 'companyCode',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.VAT'),
      cell: (row) => row.companyCode ?? DASH,
    },
    { key: 'placeName', header: this.i18n.t('DIAGNOSTICS.COLUMN.PLACE'), cell: (r) => r.placeName },
    {
      key: 'deviceName',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.DEVICE'),
      cell: (row) => row.deviceName,
    },
    {
      key: 'deviceType',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.TYPE'),
      cell: (row) => this.typeLabel(row.deviceType),
    },
    {
      key: 'appVersion',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.APP_VERSION'),
      cell: (row) => row.appVersion ?? DASH,
    },
    {
      key: 'server',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.SERVER'),
      cell: (row) => this.i18n.t(row.server ? 'DIAGNOSTICS.YES' : 'DIAGNOSTICS.NO'),
    },
    {
      key: 'platform',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.PLATFORM'),
      cell: (row) => row.platform ?? DASH,
    },
    {
      key: 'platformVersion',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.PLATFORM_VERSION'),
      cell: (row) => row.platformVersion ?? DASH,
    },
    {
      key: 'model',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.MODEL'),
      cell: (row) => row.model ?? DASH,
    },
    {
      key: 'lastDataDownload',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.LAST_DOWNLOAD'),
      cell: (row) => this.date(row.lastDataDownload),
    },
    {
      key: 'lastSession',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.LAST_SESSION'),
      cell: (row) => this.date(row.lastSession),
    },
    { key: 'storeKey', header: this.i18n.t('DIAGNOSTICS.COLUMN.STORE_KEY') },
    {
      key: 'storeKeyLastSeenAt',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.STORE_KEY_LAST_USE'),
      cell: (row) => this.date(row.storeKey.lastSeenAt),
    },
    {
      key: 'storeKeyAppVersion',
      header: this.i18n.t('DIAGNOSTICS.COLUMN.STORE_APP_VERSION'),
      cell: (row) => row.storeKey.appVersion ?? DASH,
    },
  ]);
  protected readonly rowKey = (row: DiagnosticRow): string => row.id;

  /** `true` while the CSV is being downloaded. */
  protected readonly downloading = signal(false);
  /** Dictionary key of the message of the last failed download, `null` when none. */
  protected readonly downloadError = signal<string | null>(null);
  protected readonly downloadStatus = computed(() => {
    const key = this.downloadError();
    if (key !== null) {
      return this.i18n.t(key);
    }
    return this.downloading() ? this.i18n.t('DIAGNOSTICS.DOWNLOADING') : '';
  });

  protected onSearch(text: string): void {
    this.searchText.set(text);
    this.debouncer.schedule(() => this.change({ q: text.trim() === '' ? null : text.trim() }));
  }

  protected onFilter(name: 'companyId' | 'placeId' | 'type', value: string): void {
    // A different company makes the chosen place meaningless.
    this.change({
      [name]: value === '' ? null : value,
      ...(name === 'companyId' ? { placeId: null } : {}),
    });
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

  /** Downloads the CSV with the filters of the table (never the page or the cursor); its button is disabled while it runs. */
  protected async download(): Promise<void> {
    this.downloading.set(true);
    this.downloadError.set(null);
    try {
      saveFile(await this.api.download(this.filters()), `devices-diagnostic_${today()}.csv`);
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

  private typeLabel(type: string | null): string {
    if (type === null) {
      return DASH;
    }
    return isDeviceType(type) ? this.i18n.t(deviceTypeKey(type)) : type;
  }

  private date(value: string | null): string {
    return value === null
      ? DASH
      : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
          dateStyle: 'medium',
          timeStyle: 'short',
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
    return 'DIAGNOSTICS.DOWNLOAD_ERROR.TOO_LARGE';
  }
  return status === 429
    ? 'DIAGNOSTICS.DOWNLOAD_ERROR.TOO_MANY'
    : 'DIAGNOSTICS.DOWNLOAD_ERROR.GENERIC';
}
