import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { TPipe } from '../../core/i18n/t-pipe';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { createDebouncer } from '../../shared/util/debouncer';
import { PasswordGenerator } from './password-generator';
import { USERNAME_PATTERN, UserFormState } from './user-form-state';
import { UserPin } from './user-pin';
import { UsersApi } from './users-api';

/** State of the username availability check. */
export type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'error';

/**
 * Access data: username (checked for availability while typing), temporary password with the
 * generator and the PIN to set (creation), role, status and the PIN actions (edit).
 */
@Component({
  selector: 'fc-user-access-section',
  imports: [FormField, PasswordGenerator, Select, TextField, TPipe, UserPin],
  templateUrl: './user-access-section.html',
  styleUrl: './user-section.css',
})
export class UserAccessSection {
  protected readonly state = inject(UserFormState);
  private readonly api = inject(UsersApi);
  private readonly debouncer = createDebouncer();
  protected readonly form = this.state.userForm;

  private readonly usernameValue = computed(() => this.state.model().username.trim());
  private readonly needsCheck = computed(() => {
    const username = this.usernameValue();
    return (
      this.state.canWrite() &&
      USERNAME_PATTERN.test(username) &&
      (this.state.isNew() || username !== this.state.user()?.username)
    );
  });
  private readonly checked = signal<{
    username: string;
    result: 'available' | 'taken' | 'error';
  } | null>(null);
  protected readonly availability = computed<AvailabilityState>(() => {
    if (!this.needsCheck()) {
      return 'idle';
    }
    const checked = this.checked();
    return checked?.username === this.usernameValue() ? checked.result : 'checking';
  });
  protected readonly usernameHint = computed(() => {
    const state = this.availability();
    return state === 'idle'
      ? null
      : this.state.i18n.t(`USERS.FORM.USERNAME_${state.toUpperCase()}`);
  });
  protected readonly usernameError = computed(
    () =>
      this.state.error(this.form.username) ??
      (this.availability() === 'taken' ? this.state.i18n.t('FORM.ISSUE.TAKEN') : null),
  );

  constructor() {
    effect(() => {
      const username = this.usernameValue();
      if (this.needsCheck()) {
        this.debouncer.schedule(() => void this.checkUsername(username));
      } else {
        this.debouncer.cancel();
      }
    });
  }

  protected onGenerated(password: string): void {
    this.form.password().value.set(password);
  }

  private async checkUsername(username: string): Promise<void> {
    try {
      const available = await this.api.isUsernameAvailable(username);
      this.checked.set({ username, result: available ? 'available' : 'taken' });
    } catch (error) {
      // The check is advisory (the server decides on save); the username is not logged.
      console.warn('Cannot check the availability of the username', error);
      this.checked.set({ username, result: 'error' });
    }
  }
}
