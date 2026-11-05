import { Component, computed, inject, signal } from '@angular/core';
import {
  FieldTree,
  form,
  FormField,
  required,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { FormError } from '../../shared/ui/form-error/form-error';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { ProfileApi } from '../profile/profile-api';

/** Minimum length of a new password (the server enforces the same policy). */
export const PASSWORD_MIN_LENGTH = 12;
/** Maximum length of a new password. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Change-password page. Mandatory after a temporary password (the user can do nothing else but
 * sign out) or voluntary from the profile. The confirmation is checked only here; the policy
 * and the current password are checked by the server, whose `422` errors land on the fields.
 */
@Component({
  selector: 'fc-change-password',
  imports: [Button, FormError, FormField, RouterLink, TextField, TPipe],
  templateUrl: './change-password.html',
  styleUrl: './change-password.css',
})
export class ChangePassword {
  private readonly session = inject(SessionService);
  private readonly api = inject(ProfileApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly maxLength = PASSWORD_MAX_LENGTH;
  /** `true` while the user is forced to change a temporary password. */
  protected readonly mandatory = computed(() => this.session.status() === 'passwordChangeRequired');

  protected readonly model = signal({ currentPassword: '', newPassword: '', confirmPassword: '' });
  protected readonly passwordForm = form(this.model, (path) => {
    required(path.currentPassword);
    required(path.newPassword);
    validate(path.newPassword, ({ value }) => {
      const length = value().length;
      if (length > 0 && length < PASSWORD_MIN_LENGTH) {
        return { kind: 'tooShort' };
      }
      return length > PASSWORD_MAX_LENGTH ? { kind: 'tooLong' } : undefined;
    });
    required(path.confirmPassword);
    validate(path.confirmPassword, ({ value, valueOf }) =>
      value() === valueOf(path.newPassword) ? undefined : { kind: 'mismatch' },
    );
  });
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.passwordForm().submitting());

  protected error(field: FieldTree<string>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.passwordForm, {
      action: async () => {
        this.failure.set(null);
        const wasMandatory = this.mandatory();
        const { currentPassword, newPassword } = this.model();
        try {
          await this.api.changePassword(currentPassword, newPassword);
        } catch (error) {
          return this.reject(error);
        }
        this.model.set({ currentPassword: '', newPassword: '', confirmPassword: '' });
        this.passwordForm().reset();
        try {
          await this.session.loadProfile();
        } catch (error) {
          this.show(failureMessage(this.i18n, error));
          return undefined;
        }
        this.toast.success(this.i18n.t('AUTH.CHANGE_PASSWORD.SUCCESS'));
        await this.router.navigateByUrl(wasMandatory ? '/' : '/profile');
        return undefined;
      },
      onInvalid: () => focusFirstError(this.passwordForm),
    });
  }

  private reject(error: unknown): TreeValidationResult {
    if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') {
      const mapped = serverFieldErrors(this.i18n, error, {
        currentPassword: this.passwordForm.currentPassword,
        newPassword: this.passwordForm.newPassword,
      });
      if (mapped.unmatched) {
        this.show(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      if (error.details.some((d) => d.field === 'currentPassword' && d.issue === 'incorrect')) {
        this.passwordForm.currentPassword().reset('');
      }
      return mapped.errors;
    }
    // A non-validation failure (rate limit, network…): do not keep the secret on screen.
    this.passwordForm.currentPassword().reset('');
    this.show(failureMessage(this.i18n, error));
    return undefined;
  }

  private show(message: string): void {
    this.failure.set(message);
  }
}
