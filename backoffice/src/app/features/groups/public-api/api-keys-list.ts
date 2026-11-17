import { httpResource } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, input, signal, viewChild } from '@angular/core';
import { ApiPage } from '../../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../../core/api/api-error';
import { formatDate } from '../../../core/i18n/format';
import { I18nService } from '../../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../../core/i18n/language';
import { TPipe } from '../../../core/i18n/t-pipe';
import { SessionService } from '../../../core/session/session.service';
import { ActionsMenu } from '../../../shared/ui/actions-menu/actions-menu';
import { Button } from '../../../shared/ui/button/button';
import { ConfirmDialog } from '../../../shared/ui/confirm-dialog/confirm-dialog';
import { CursorPaginator } from '../../../shared/ui/cursor-paginator/cursor-paginator';
import { DataTable } from '../../../shared/ui/data-table/data-table';
import { TableColumn } from '../../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../../shared/ui/data-table/table-templates';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { ErrorState } from '../../../shared/ui/error-state/error-state';
import { BadgeTone, StatusBadge } from '../../../shared/ui/status-badge/status-badge';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../../profile/sessions';
import {
  ApiKey,
  ApiKeyCreateBody,
  ApiKeyPatch,
  ApiKeyStatus,
  keyStatus,
  permissionTextKey,
  PublicApiSettings,
} from './api-key.types';
import { apiKeyFailureMessage } from './api-key-errors';
import { ApiKeyEditor } from './api-key-editor';
import { ApiKeySecret } from './api-key-secret';
import { ApiKeyUsagePanel } from './api-key-usage';
import { ApiKeysApi, CreatedApiKey } from './api-keys-api';

const STATUS_TONES: Record<ApiKeyStatus, BadgeTone> = {
  active: 'success',
  revoked: 'neutral',
  expired: 'warning',
};

/** A key with its status computed at the time the list was read. */
interface KeyRow {
  readonly key: ApiKey;
  readonly status: ApiKeyStatus;
}

/**
 * Public API keys of a group, newest first, with cursor pagination. Creating, changing and
 * revoking need `apiKeys:manage`; reading the usage only `apiKeys:read`. The secret of a new key
 * goes straight from the response of the creation to the secret dialog, never through this list.
 * A revoked or expired key cannot be changed (no "Modifica"), and only an active one is revoked
 * here. Only the platform administrator sets limits.
 */
@Component({
  selector: 'fc-api-keys-list',
  imports: [
    ActionsMenu,
    ApiKeyEditor,
    ApiKeySecret,
    ApiKeyUsagePanel,
    Button,
    CellTemplate,
    ConfirmDialog,
    CursorPaginator,
    DataTable,
    Dialog,
    ErrorState,
    RowActionsTemplate,
    StatusBadge,
    TPipe,
  ],
  templateUrl: './api-keys-list.html',
  styleUrl: './api-keys-list.css',
})
export class ApiKeysList {
  private readonly api = inject(ApiKeysApi);
  private readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);
  private destroyed = false;
  private readonly watchDestroy = inject(DestroyRef).onDestroy(() => {
    this.destroyed = true;
  });
  protected readonly i18n = inject(I18nService);

  /** Group of the keys. */
  readonly groupId = input.required<string>();
  /** Limits a new key inherits from the group. */
  readonly inherited = input.required<PublicApiSettings>();

  protected readonly canManage = computed(() => this.session.can('apiKeys:manage'));
  protected readonly canSetLimits = computed(() => this.session.me()?.role === 'PSA');

  protected readonly limit = signal(25);
  private readonly cursor = signal<string | null>(null);
  private readonly cursorStack = signal<readonly (string | null)[]>([]);
  protected readonly hasPrevious = computed(() => this.cursorStack().length > 0);

  private readonly resource = httpResource<ApiPage<ApiKey>>(() => ({
    url: this.api.url(this.groupId()),
    params: {
      limit: this.limit(),
      ...(this.cursor() === null ? {} : { cursor: this.cursor() as string }),
    },
  }));
  protected readonly rows = computed<KeyRow[]>(() => {
    const now = new Date();
    return (this.resource.hasValue() ? this.resource.value().data : []).map((key) => ({
      key,
      status: keyStatus(key, now),
    }));
  });
  protected readonly nextCursor = computed(() =>
    this.resource.hasValue() ? this.resource.value().page.next : null,
  );
  protected readonly loading = this.resource.isLoading;
  /** Whether the read failed (also for failures that are not API errors). */
  protected readonly loadFailed = computed(() => this.resource.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.resource.error()));
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<KeyRow>[]>(() => [
    { key: 'name', header: this.i18n.t('PUBLIC_API.LIST.NAME'), cell: (row) => row.key.name },
    { key: 'prefix', header: this.i18n.t('PUBLIC_API.LIST.PREFIX'), cell: (row) => row.key.prefix },
    {
      key: 'permissions',
      header: this.i18n.t('PUBLIC_API.LIST.PERMISSIONS'),
      cell: (row) =>
        row.key.permissions
          .map((permission) => this.i18n.t(permissionTextKey(permission, 'LABEL')))
          .join(', '),
      hideNarrow: true,
    },
    {
      key: 'restrictions',
      header: this.i18n.t('PUBLIC_API.LIST.RESTRICTIONS'),
      cell: (row) => this.restrictions(row.key),
      hideNarrow: true,
    },
    {
      key: 'limits',
      header: this.i18n.t('PUBLIC_API.LIST.LIMITS'),
      cell: (row) =>
        this.i18n.t('PUBLIC_API.LIST.LIMITS_VALUE', {
          minute: row.key.rateLimitPerMinute,
          day: row.key.dailyQuota,
        }),
      hideNarrow: true,
    },
    {
      key: 'expiresAt',
      header: this.i18n.t('PUBLIC_API.LIST.EXPIRES'),
      cell: (row) =>
        row.key.expiresAt === null
          ? this.i18n.t('PUBLIC_API.LIST.NEVER_EXPIRES')
          : this.when(row.key.expiresAt, false),
    },
    { key: 'status', header: this.i18n.t('PUBLIC_API.LIST.STATUS') },
    {
      key: 'createdAt',
      header: this.i18n.t('PUBLIC_API.LIST.CREATED'),
      cell: (row) => this.when(row.key.createdAt, false),
      hideNarrow: true,
    },
    {
      key: 'lastUsedAt',
      header: this.i18n.t('PUBLIC_API.LIST.LAST_USED'),
      cell: (row) =>
        row.key.lastUsedAt === null
          ? this.i18n.t('PUBLIC_API.LIST.NEVER_USED')
          : this.when(row.key.lastUsedAt, true),
      hideNarrow: true,
    },
  ]);
  protected readonly rowKey = (row: KeyRow): string => row.key.id;
  protected readonly tone = (status: ApiKeyStatus): BadgeTone => STATUS_TONES[status];

  // Editor dialog.
  protected readonly editing = signal<ApiKey | null>(null);
  protected readonly editorOpen = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<ApiError | null>(null);
  private readonly secretDialog = viewChild.required<ApiKeySecret>('secret');

  // Revocation.
  protected readonly revoking = signal<ApiKey | null>(null);
  protected readonly revokeOpen = signal(false);
  protected readonly revokeBusy = signal(false);

  // Usage.
  protected readonly usageKey = signal<ApiKey | null>(null);
  protected readonly usageOpen = signal(false);

  protected rowLabel(key: string, row: KeyRow): string {
    return this.i18n.t(key, { name: row.key.name });
  }

  protected create(): void {
    this.open(null);
  }

  protected edit(row: KeyRow): void {
    this.open(row.key);
  }

  private open(key: ApiKey | null): void {
    this.editing.set(key);
    this.saveError.set(null);
    this.editorOpen.set(true);
  }

  protected showUsage(row: KeyRow): void {
    this.usageKey.set(row.key);
    this.usageOpen.set(true);
  }

  protected askRevoke(row: KeyRow): void {
    this.revoking.set(row.key);
    this.revokeOpen.set(true);
  }

  protected onNext(cursor: string): void {
    this.cursorStack.update((stack) => [...stack, this.cursor()]);
    this.cursor.set(cursor);
  }

  protected onPrevious(): void {
    const stack = this.cursorStack();
    this.cursor.set(stack[stack.length - 1]);
    this.cursorStack.set(stack.slice(0, -1));
  }

  protected onLimit(limit: number): void {
    this.limit.set(limit);
    this.cursor.set(null);
    this.cursorStack.set([]);
  }

  protected reload(): void {
    this.resource.reload();
  }

  protected async onSave(body: ApiKeyCreateBody | ApiKeyPatch): Promise<void> {
    const key = this.editing();
    this.saving.set(true);
    this.saveError.set(null);
    let created: CreatedApiKey | null = null;
    try {
      if (key === null) {
        created = await this.api.create(this.groupId(), body as ApiKeyCreateBody);
      } else {
        await this.api.update(this.groupId(), key.id, body as ApiKeyPatch);
      }
    } catch (error) {
      this.failSave(error, key === null);
      return;
    } finally {
      this.saving.set(false);
    }
    this.finishSave(created);
  }

  /** What follows a save that succeeded, outside the request so a UI error is not "save failed". */
  private finishSave(created: CreatedApiKey | null): void {
    if (this.destroyed) {
      // The user left while the request ran: the secret cannot be shown, so it is dropped now.
      if (created !== null) {
        this.toast.error(this.i18n.t('PUBLIC_API.SECRET.LOST', { name: created.key.name }));
      }
      return;
    }
    this.editorOpen.set(false);
    if (created === null) {
      this.toast.success(this.i18n.t('PUBLIC_API.SAVED'));
    } else {
      // The secret goes to its dialog and nowhere else.
      this.secretDialog().show(created.key.name, created.secret);
    }
    this.resource.reload();
  }

  /** The editor shows the error (on the fields, or as a message); a key that changed state is read again. */
  private failSave(error: unknown, creating: boolean): void {
    if (error instanceof ApiError) {
      this.saveError.set(error);
      if (!creating && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) {
        this.resource.reload();
      }
      return;
    }
    console.error(error);
    this.saveError.set(
      new ApiError({ status: 0, code: 'UNKNOWN_ERROR', message: 'Unexpected error' }),
    );
  }

  protected async confirmRevoke(): Promise<void> {
    const key = this.revoking() as ApiKey;
    this.revokeBusy.set(true);
    try {
      await this.api.revoke(this.groupId(), key.id);
      this.toast.success(this.i18n.t('PUBLIC_API.REVOKED'));
    } catch (error) {
      this.toast.error(apiKeyFailureMessage(this.i18n, error, false));
    }
    this.revokeBusy.set(false);
    this.revokeOpen.set(false);
    this.resource.reload();
  }

  private restrictions(key: ApiKey): string {
    const parts = [
      key.restrictions.companyIds === null
        ? null
        : this.i18n.t('PUBLIC_API.LIST.COMPANIES_COUNT', {
            count: key.restrictions.companyIds.length,
          }),
      key.restrictions.placeIds === null
        ? null
        : this.i18n.t('PUBLIC_API.LIST.PLACES_COUNT', { count: key.restrictions.placeIds.length }),
    ].filter((part) => part !== null);
    return parts.length === 0 ? this.i18n.t('PUBLIC_API.LIST.NO_RESTRICTIONS') : parts.join(' · ');
  }

  private when(value: string, withTime: boolean): string {
    return formatDate(
      value,
      this.i18n.language() ?? DEFAULT_LANGUAGE,
      withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
    );
  }
}
