import { httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { SessionInfo } from '../../core/session/session.types';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { DataTable } from '../../shared/ui/data-table/data-table';
import { TableColumn } from '../../shared/ui/data-table/data-table.types';
import { CellTemplate, RowActionsTemplate } from '../../shared/ui/data-table/table-templates';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ProfileApi } from './profile-api';

const MAX_USER_AGENT = 48;

/** Shortens a user agent for the table; `null` stays `null`. */
export function abbreviateUserAgent(userAgent: string | null): string | null {
  if (userAgent === null || userAgent.length <= MAX_USER_AGENT) {
    return userAgent;
  }
  return `${userAgent.slice(0, MAX_USER_AGENT)}…`;
}

/** Returns the API error carried by a failed resource (it may be wrapped), or `null`. */
export function apiErrorOf(error: unknown): ApiError | null {
  if (error instanceof ApiError) {
    return error;
  }
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause instanceof ApiError ? cause : null;
}

/**
 * The user's own active sessions with the option to revoke each one. Revoking the current
 * session is a logout.
 */
@Component({
  selector: 'fc-sessions',
  imports: [
    Button,
    ConfirmDialog,
    CellTemplate,
    DataTable,
    ErrorState,
    RouterLink,
    RowActionsTemplate,
    StatusBadge,
    TPipe,
  ],
  templateUrl: './sessions.html',
})
export class Sessions {
  private readonly session = inject(SessionService);
  private readonly api = inject(ProfileApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  protected readonly sessions = httpResource<ApiData<SessionInfo[]>>(() => '/v1/me/sessions');
  protected readonly rows = computed(() => this.sessions.value()?.data ?? []);
  protected readonly loadError = computed(() => apiErrorOf(this.sessions.error()));
  protected readonly requestId = computed(() => this.loadError()?.requestId ?? null);
  protected readonly errorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });

  protected readonly columns = computed<TableColumn<SessionInfo>[]>(() => [
    {
      key: 'userAgent',
      header: this.i18n.t('SESSIONS.DEVICE'),
      cell: (row) => abbreviateUserAgent(row.userAgent) ?? this.i18n.t('SESSIONS.UNKNOWN'),
    },
    {
      key: 'ip',
      header: this.i18n.t('SESSIONS.IP'),
      cell: (row) => row.ip ?? this.i18n.t('SESSIONS.UNKNOWN'),
    },
    {
      key: 'createdAt',
      header: this.i18n.t('SESSIONS.CREATED'),
      cell: (row) => this.date(row.createdAt),
    },
    {
      key: 'lastUsedAt',
      header: this.i18n.t('SESSIONS.LAST_USED'),
      cell: (row) =>
        row.lastUsedAt === null ? this.i18n.t('SESSIONS.UNKNOWN') : this.date(row.lastUsedAt),
    },
    { key: 'current', header: this.i18n.t('SESSIONS.STATE') },
  ]);

  protected readonly rowKey = (row: SessionInfo): string => row.id;

  protected readonly confirmOpen = signal(false);
  protected readonly target = signal<SessionInfo | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirmMessage = computed(() =>
    this.i18n.t(this.target()?.current ? 'SESSIONS.CONFIRM_CURRENT' : 'SESSIONS.CONFIRM_OTHER'),
  );

  protected revokeLabel(row: SessionInfo): string {
    return this.i18n.t('SESSIONS.REVOKE_LABEL', { created: this.date(row.createdAt) });
  }

  protected ask(row: SessionInfo): void {
    this.target.set(row);
    this.confirmOpen.set(true);
  }

  protected async revoke(): Promise<void> {
    const target = this.target() as SessionInfo;
    this.busy.set(true);
    try {
      if (target.current) {
        await this.session.logout();
      } else {
        await this.api.revokeSession(target.id);
        this.toast.success(this.i18n.t('SESSIONS.REVOKED'));
        this.sessions.reload();
      }
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
    } finally {
      this.busy.set(false);
      this.confirmOpen.set(false);
    }
  }

  private date(value: string): string {
    return formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }
}
