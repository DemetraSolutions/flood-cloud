import { httpResource } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ApiData } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../profile/sessions';
import { PlaceState } from './place-state';
import { StoreKeyApi } from './store-key-api';
import { ActivationCode, StoreKeyStatus } from './store-key.types';

/**
 * Store key tab of the place (platform administrators and dealers): whether the store server has
 * a key, since when, when it was last seen and with which app version and address, the pending
 * activation code and why the last key stopped working. "Genera codice di attivazione" shows the
 * code once in a dialog, with copy and expiry; the code lives only in this component, only while
 * the dialog is open, and is never stored or logged. Revoking asks for confirmation.
 */
@Component({
  selector: 'fc-place-store-key',
  imports: [Button, ConfirmDialog, Dialog, ErrorState, TPipe],
  templateUrl: './place-store-key.html',
  styleUrl: './place-section.css',
})
export class PlaceStoreKey {
  protected readonly state = inject(PlaceState);
  private readonly api = inject(StoreKeyApi);
  private readonly session = inject(SessionService);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  private readonly status = httpResource<ApiData<StoreKeyStatus>>(() =>
    this.session.can('storeKeys:read')
      ? `/v1/groups/${encodeURIComponent(this.state.groupId())}/places/${encodeURIComponent(this.state.placeId() as string)}/store-key`
      : undefined,
  );

  protected readonly info = computed(() =>
    this.status.hasValue() ? this.status.value().data : null,
  );
  protected readonly loadError = computed(() => apiErrorOf(this.status.error()));
  protected readonly errorKey = computed(() => apiErrorMessageKey(this.loadError() as ApiError));
  protected readonly loading = this.status.isLoading;
  protected readonly canManage = computed(() => this.session.can('storeKeys:manage'));

  /** The code just generated; set only while the dialog that shows it is open. */
  protected readonly code = signal<ActivationCode | null>(null);
  protected readonly codeOpen = signal(false);
  protected readonly revokeOpen = signal(false);
  protected readonly busy = signal(false);

  protected reload(): void {
    this.status.reload();
  }

  /** A date and time as the user reads them. */
  protected when(value: string): string {
    return formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  protected async generate(): Promise<void> {
    this.busy.set(true);
    try {
      this.code.set(
        await this.api.createCode(this.state.groupId(), this.state.placeId() as string),
      );
      this.codeOpen.set(true);
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
      return;
    } finally {
      this.busy.set(false);
    }
    this.status.reload();
  }

  /** The dialog was closed: the code is forgotten. */
  protected onCodeClosed(): void {
    this.codeOpen.set(false);
    this.code.set(null);
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText((this.code() as ActivationCode).code);
      this.toast.success(this.i18n.t('PLACES.STORE_KEY.COPIED'));
    } catch {
      this.toast.error(this.i18n.t('PLACES.STORE_KEY.COPY_FAILED'));
    }
  }

  protected async cancelCode(): Promise<void> {
    await this.act(
      () => this.api.cancelCode(this.state.groupId(), this.state.placeId() as string),
      'PLACES.STORE_KEY.CODE_CANCELLED',
    );
  }

  protected async revoke(): Promise<void> {
    await this.act(
      () => this.api.revoke(this.state.groupId(), this.state.placeId() as string),
      'PLACES.STORE_KEY.REVOKED',
    );
    this.revokeOpen.set(false);
  }

  private async act(run: () => Promise<void>, done: string): Promise<void> {
    this.busy.set(true);
    try {
      await run();
    } catch (error) {
      this.toast.error(failureMessage(this.i18n, error));
      return;
    } finally {
      this.busy.set(false);
    }
    this.toast.success(this.i18n.t(done));
    this.status.reload();
  }
}
