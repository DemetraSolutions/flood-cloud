import { Component, computed, inject, input, signal } from '@angular/core';
import { FieldTree, form, FormField, required, submit } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { ApiError } from '../../core/api/api-error';
import { safeReturnUrl } from '../../core/auth/return-url';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import { failureMessage, fieldErrorMessage, focusFirstError } from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { FormError } from '../../shared/ui/form-error/form-error';
import { TextField } from '../../shared/ui/text-field/text-field';

/**
 * Login page (outside the shell). Signal Forms with required fields, a waiting state while the
 * request runs and a single generic message for wrong credentials (it never says which of the
 * two was wrong). There is no "remember me": the refresh token lives only in this tab.
 */
@Component({
  selector: 'fc-login',
  imports: [Button, Checkbox, FormError, FormField, TextField, TPipe],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);

  /** Page to open after the login (query parameter `returnUrl`, validated before use). */
  readonly returnUrl = input<string>();

  protected readonly model = signal({ username: '', password: '' });
  protected readonly loginForm = form(this.model, (path) => {
    required(path.username);
    required(path.password);
  });
  private skipPasswordBlur = false;
  protected readonly showPassword = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.loginForm().submitting());

  protected error(field: FieldTree<string>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.loginForm, {
      action: async () => {
        this.failure.set(null);
        const { username, password } = this.model();
        try {
          await this.session.login(username, password);
        } catch (error) {
          this.fail(error);
          return undefined;
        }
        await this.router.navigateByUrl(
          this.session.status() === 'passwordChangeRequired'
            ? '/change-password'
            : (safeReturnUrl(this.returnUrl()) ?? '/'),
        );
        return undefined;
      },
      onInvalid: () => focusFirstError(this.loginForm),
    });
  }

  private fail(error: unknown): void {
    this.failure.set(this.messageFor(error));
    this.showPassword.set(false);
    this.loginForm.password().reset('');
    // Moving the focus to the message blurs the emptied field: that blur must not touch it.
    this.skipPasswordBlur = true;
  }

  protected onPasswordBlur(): void {
    if (this.skipPasswordBlur) {
      this.skipPasswordBlur = false;
    } else {
      this.loginForm.password().markAsTouched();
    }
  }

  private messageFor(error: unknown): string {
    if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') {
      return this.i18n.t('AUTH.LOGIN.INVALID_CREDENTIALS');
    }
    if (
      error instanceof ApiError &&
      error.code === 'RATE_LIMITED' &&
      error.retryAfterSeconds !== null
    ) {
      return this.i18n.t('AUTH.LOGIN.RATE_LIMITED_WAIT', { seconds: error.retryAfterSeconds });
    }
    return failureMessage(this.i18n, error);
  }
}
