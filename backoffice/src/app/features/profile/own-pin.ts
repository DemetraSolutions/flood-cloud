import { Component, inject, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PinDialog, PinSubmission } from '../users/pin-dialog';
import { ProfileApi } from './profile-api';

/**
 * The user's own PIN: whether it is set, and the actions to set, change or remove it. Each needs
 * the current password (`PUT /v1/me/pin`). The PIN and the password live only in the dialog's
 * signals, cleared when it closes; they are never logged or stored. A wrong password, a PIN that
 * is not 3 to 6 digits and the rate limit are answered in the dialog.
 */
@Component({
  selector: 'fc-own-pin',
  imports: [Button, PinDialog, TPipe],
  templateUrl: './own-pin.html',
})
export class OwnPin {
  protected readonly session = inject(SessionService);
  private readonly api = inject(ProfileApi);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly setOpen = signal(false);
  protected readonly removeOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly pinError = signal<string | null>(null);
  protected readonly passwordError = signal<string | null>(null);

  protected open(mode: 'set' | 'remove'): void {
    this.pinError.set(null);
    this.passwordError.set(null);
    (mode === 'set' ? this.setOpen : this.removeOpen).set(true);
  }

  protected async submit(submission: PinSubmission): Promise<void> {
    this.pinError.set(null);
    this.passwordError.set(null);
    this.busy.set(true);
    try {
      await this.api.setPin(submission.password, submission.pin);
      const me = this.session.me();
      if (me !== null) {
        this.session.setProfile({ ...me, pinSet: submission.pin !== null });
      }
      this.setOpen.set(false);
      this.removeOpen.set(false);
      this.toast.success(this.i18n.t(submission.pin === null ? 'PIN.REMOVED' : 'PIN.SAVED'));
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  private fail(error: unknown): void {
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
      const issue = (field: string): string | undefined =>
        error.details.find((detail) => detail.field === field)?.issue;
      const pin = issue('pin');
      const password = issue('currentPassword');
      if (pin !== undefined || password !== undefined) {
        this.pinError.set(pin === undefined ? null : this.i18n.t(issueMessageKey(pin)));
        this.passwordError.set(
          password === undefined ? null : this.i18n.t(issueMessageKey(password)),
        );
        return;
      }
    }
    if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') {
      this.passwordError.set(this.i18n.t(issueMessageKey('incorrect')));
    } else if (
      error instanceof ApiError &&
      error.code === 'RATE_LIMITED' &&
      error.retryAfterSeconds !== null
    ) {
      this.passwordError.set(
        this.i18n.t('PIN.RATE_LIMITED_WAIT', { seconds: error.retryAfterSeconds }),
      );
    } else {
      this.setOpen.set(false);
      this.removeOpen.set(false);
      this.toast.error(failureMessage(this.i18n, error));
    }
  }
}
