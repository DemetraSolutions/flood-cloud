import { Component, computed, inject, output, signal } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Button } from '../../shared/ui/button/button';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { Dialog } from '../../shared/ui/dialog/dialog';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { PasswordGenerator } from './password-generator';
import { areaOf, UserRecord } from './user.types';
import { UsersApi } from './users-api';
import { userFailureMessage } from './users-errors';

/** An action on one user. */
export type UserAction = 'resetPassword' | 'enable' | 'disable' | 'trash' | 'restore' | 'delete';

/** An action that can run on many users at once. */
export type BulkAction = 'trash' | 'restore';

/** Minimum and maximum length of a temporary password (the server enforces the policy). */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

interface Failure {
  readonly username: string;
  readonly message: string;
}

/**
 * Hosts the dialogs of the user actions (reset password, enable/disable, trash, restore, delete
 * for good, and trash/restore in bulk). Place it once in a page and call {@link run} or
 * {@link runBulk}; it confirms, calls the API, shows the outcome in a toast and emits `done` so
 * that the page reloads. Bulk actions run one user at a time and list the failures per user.
 */
@Component({
  selector: 'fc-user-actions',
  imports: [Button, ConfirmDialog, Dialog, PasswordGenerator, TextField, TPipe],
  templateUrl: './user-actions.html',
  styleUrl: './user-actions.css',
})
export class UserActions {
  private readonly api = inject(UsersApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** Emitted after at least one change succeeded, with the action that ran. */
  readonly done = output<UserAction>();

  protected readonly action = signal<UserAction | null>(null);
  protected readonly targets = signal<readonly UserRecord[]>([]);
  protected readonly busy = signal(false);
  protected readonly confirmOpen = signal(false);
  protected readonly resetOpen = signal(false);
  protected readonly deleteOpen = signal(false);
  protected readonly resultOpen = signal(false);
  protected readonly failures = signal<readonly Failure[]>([]);
  protected readonly password = signal('');
  protected readonly passwordIssue = signal<string | null>(null);
  protected readonly typedUsername = signal('');

  private readonly target = computed(() => this.targets()[0] as UserRecord | undefined);
  protected readonly username = computed(() => this.target()?.username ?? '');
  protected readonly bulk = computed(() => this.targets().length > 1);
  protected readonly deleteReady = computed(
    () => this.typedUsername() === this.username() && this.username() !== '',
  );
  private readonly actionKey = computed(() => (this.action() ?? 'trash').toUpperCase());
  protected readonly confirmHeading = computed(() =>
    this.i18n.t(`USER_ACTIONS.TITLE.${this.actionKey()}`),
  );
  protected readonly confirmMessage = computed(() =>
    this.bulk()
      ? this.i18n.t(`USER_ACTIONS.BULK.${this.actionKey()}`, {
          count: this.targets().length,
        })
      : this.i18n.t(`USER_ACTIONS.CONFIRM.${this.actionKey()}`, {
          username: this.username(),
        }),
  );
  protected readonly confirmLabel = computed(() =>
    this.i18n.t(`USER_ACTIONS.LABEL.${this.actionKey()}`),
  );

  /** Starts an action on one user (opens its dialog). */
  run(action: UserAction, user: UserRecord): void {
    this.begin(action, [user]);
    if (action === 'resetPassword') {
      this.password.set('');
      this.passwordIssue.set(null);
      this.resetOpen.set(true);
    } else if (action === 'delete') {
      this.typedUsername.set('');
      this.deleteOpen.set(true);
    } else {
      this.confirmOpen.set(true);
    }
  }

  /** Starts a bulk action on the selected users (opens the confirmation). */
  runBulk(action: BulkAction, users: readonly UserRecord[]): void {
    this.begin(action, users);
    this.confirmOpen.set(true);
  }

  private begin(action: UserAction, users: readonly UserRecord[]): void {
    this.action.set(action);
    this.targets.set(users);
  }

  /** Closes the reset dialog and forgets the password typed or generated in it. */
  protected closeReset(): void {
    this.password.set('');
    this.resetOpen.set(false);
  }

  protected onPassword(value: string): void {
    this.password.set(value);
    this.passwordIssue.set(null);
  }

  protected async confirmAction(): Promise<void> {
    const action = this.action() as Exclude<UserAction, 'resetPassword'>;
    this.busy.set(true);
    const failures: Failure[] = [];
    let succeeded = 0;
    for (const user of this.targets()) {
      try {
        await this.execute(action, user);
        succeeded++;
      } catch (error) {
        failures.push({ username: user.username, message: userFailureMessage(this.i18n, error) });
      }
    }
    this.busy.set(false);
    this.confirmOpen.set(false);
    this.deleteOpen.set(false);
    this.finish(action, succeeded, failures);
  }

  protected async submitPassword(event: Event): Promise<void> {
    event.preventDefault();
    const invalid = this.checkPassword();
    if (invalid !== null) {
      this.passwordIssue.set(this.i18n.t(invalid));
      return;
    }
    this.busy.set(true);
    try {
      const user = this.target() as UserRecord;
      await this.api.setPassword(areaOf(user), user.id, this.password());
    } catch (error) {
      this.busy.set(false);
      if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
        const issue = error.details.find((detail) => detail.field === 'password')?.issue;
        this.passwordIssue.set(this.i18n.t(this.issueKey(issue)));
      } else {
        this.closeReset();
        this.toast.error(userFailureMessage(this.i18n, error));
      }
      return;
    }
    this.busy.set(false);
    this.closeReset();
    this.toast.success(this.i18n.t('USER_ACTIONS.DONE.RESETPASSWORD'));
    this.done.emit('resetPassword');
  }

  private checkPassword(): string | null {
    const password = this.password();
    if (password.length < PASSWORD_MIN) {
      return 'FORM.ISSUE.TOO_SHORT';
    }
    if (password.length > PASSWORD_MAX) {
      return 'FORM.ISSUE.TOO_LONG';
    }
    return password === this.username() ? 'FORM.ISSUE.SAME_AS_USERNAME' : null;
  }

  private issueKey(issue: string | undefined): string {
    const known: Record<string, string> = {
      tooShort: 'FORM.ISSUE.TOO_SHORT',
      tooLong: 'FORM.ISSUE.TOO_LONG',
      sameAsUsername: 'FORM.ISSUE.SAME_AS_USERNAME',
      invalidCharacters: 'FORM.ISSUE.INVALID_CHARACTERS',
    };
    return issue !== undefined && Object.hasOwn(known, issue) ? known[issue] : 'FORM.ISSUE.INVALID';
  }

  private execute(
    action: Exclude<UserAction, 'resetPassword'>,
    user: UserRecord,
  ): Promise<unknown> {
    const area = areaOf(user);
    switch (action) {
      case 'enable':
        return this.api.update(area, user.id, { status: 'active' });
      case 'disable':
        return this.api.update(area, user.id, { status: 'disabled' });
      case 'trash':
        return this.api.trash(area, user.id);
      case 'restore':
        return this.api.restore(area, user.id);
      case 'delete':
        return this.api.remove(area, user.id);
    }
  }

  private finish(action: UserAction, succeeded: number, failures: readonly Failure[]): void {
    if (failures.length === 0) {
      this.toast.success(
        this.bulk()
          ? this.i18n.t('USER_ACTIONS.BULK_DONE', { count: succeeded })
          : this.i18n.t(`USER_ACTIONS.DONE.${action.toUpperCase()}`),
      );
    } else if (!this.bulk()) {
      this.toast.error(failures[0].message);
    } else {
      this.failures.set(failures);
      this.resultOpen.set(true);
    }
    if (succeeded > 0) {
      this.done.emit(action);
    }
  }
}
