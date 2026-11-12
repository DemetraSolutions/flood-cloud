import { Component, inject, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PinDialog, PinSubmission } from './pin-dialog';
import { UserFormState } from './user-form-state';
import { UsersApi } from './users-api';
import { userFailureMessage } from './users-errors';
import { UserRecord } from './user.types';

/**
 * PIN of the user being edited: only whether it is set is shown (the PIN is never returned by the
 * backend and never kept here). "Set PIN" and "Remove PIN" write at once with their own request, so
 * the other edits of the form stay as they are; neither ends the user's sessions.
 */
@Component({
  selector: 'fc-user-pin',
  imports: [Button, ConfirmDialog, PinDialog, TPipe],
  templateUrl: './user-pin.html',
  styleUrl: './user-section.css',
})
export class UserPin {
  protected readonly state = inject(UserFormState);
  private readonly api = inject(UsersApi);
  private readonly toast = inject(ToastService);

  protected readonly setOpen = signal(false);
  protected readonly removeOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly pinError = signal<string | null>(null);

  protected openSet(): void {
    this.pinError.set(null);
    this.setOpen.set(true);
  }

  protected async set(submission: PinSubmission): Promise<void> {
    this.pinError.set(null);
    this.busy.set(true);
    try {
      await this.write(submission.pin);
      this.setOpen.set(false);
      this.toast.success(this.state.i18n.t('PIN.SAVED'));
    } catch (error) {
      const detail =
        error instanceof ApiError && error.code === 'VALIDATION_ERROR'
          ? error.details.find((item) => item.field === 'pin')
          : undefined;
      if (detail === undefined) {
        this.setOpen.set(false);
        this.toast.error(userFailureMessage(this.state.i18n, error));
      } else {
        this.pinError.set(this.state.i18n.t(issueMessageKey(detail.issue)));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    this.busy.set(true);
    try {
      await this.write(null);
      this.toast.success(this.state.i18n.t('PIN.REMOVED'));
    } catch (error) {
      this.toast.error(userFailureMessage(this.state.i18n, error));
    } finally {
      this.busy.set(false);
      this.removeOpen.set(false);
    }
  }

  private async write(pin: string | null): Promise<void> {
    const user = this.state.user() as UserRecord;
    await this.api.update(this.state.area(), user.id, { pin });
    this.state.pinSet.set(pin !== null);
  }
}
