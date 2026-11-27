import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import {
  FieldTree,
  form,
  FormField,
  required,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorOf } from '../profile/sessions';
import { EInvoicingAccountsApi } from './einvoicing-accounts-api';
import {
  AccountIssue,
  EInvoicingFormModel,
  limitIssue,
  MAX_PER_HOUR_LIMIT,
  MAX_PER_YEAR_LIMIT,
  passwordIssue,
  toChange,
  toFormModel,
  usernameIssue,
  VersionedAccount,
} from './einvoicing-account.types';

function kind(issue: AccountIssue | undefined): { kind: AccountIssue } | undefined {
  return issue === undefined ? undefined : { kind: issue };
}

/**
 * The Aruba e-invoicing account of a dealer (`dealerId` set) or of the platform (`dealerId`
 * `null`), platform administrators only: enabled, credentials and upload ceilings. The password
 * is write only: the field is always empty, and an empty one keeps the stored password. Saving and
 * removing present the version read in `If-Match`; a stale version (`412`) asks to reload, a
 * username already used by another account (`409`) shows on the username field and a server
 * without the encryption key (`503`) says so.
 */
@Component({
  selector: 'fc-einvoicing-account-card',
  imports: [Button, Checkbox, ConfirmDialog, ErrorState, FormError, FormField, TextField, TPipe],
  templateUrl: './einvoicing-account-card.html',
  styleUrl: './einvoicing-account-card.css',
})
export class EInvoicingAccountCard {
  private readonly api = inject(EInvoicingAccountsApi);
  private readonly toast = inject(ToastService);
  protected readonly i18n = inject(I18nService);

  /** The dealer, or `null` for the platform account. */
  readonly dealerId = input<string | null>(null);
  /** Level of the heading of the card (2 on a page of its own, 3 under a section). */
  readonly headingLevel = input<2 | 3>(2);

  private readonly loaded = resource({
    params: () => ({ dealerId: this.dealerId() }),
    loader: ({ params }) => this.api.read(params.dealerId),
  });
  /** The account as the server has it, and its version; replaced by every save. */
  private readonly saved = linkedSignal<VersionedAccount | undefined, VersionedAccount | null>({
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: (value) => value ?? null,
  });
  protected readonly account = computed(() => this.saved()?.value ?? null);
  protected readonly passwordSet = computed(() => {
    const account = this.account();
    return account?.configured === true && account.passwordSet;
  });
  protected readonly loading = computed(() => this.loaded.isLoading());
  protected readonly failed = computed(() => this.loaded.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.loaded.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly ownerKey = computed(() =>
    this.dealerId() === null ? 'EINVOICING.OWNER.PLATFORM' : 'EINVOICING.OWNER.DEALER',
  );
  protected readonly passwordHint = computed(() =>
    this.i18n.t(this.passwordSet() ? 'EINVOICING.PASSWORD_SET_HINT' : 'EINVOICING.PASSWORD_HINT'),
  );

  protected readonly model = linkedSignal<EInvoicingFormModel>(() => toFormModel(this.account()));
  protected readonly accountForm = form(this.model, (path) => {
    required(path.username);
    required(path.password, { when: () => !this.passwordSet() });
    required(path.maxPerHour);
    validate(path.username, ({ value }) => kind(usernameIssue(value())));
    validate(path.password, ({ value }) => kind(passwordIssue(value(), !this.passwordSet())));
    validate(path.maxPerHour, ({ value }) => kind(limitIssue(value(), MAX_PER_HOUR_LIMIT, false)));
    validate(path.maxPerYear, ({ value }) => kind(limitIssue(value(), MAX_PER_YEAR_LIMIT, true)));
  });

  protected readonly submitting = computed(() => this.accountForm().submitting());
  /** Message of a failure that belongs to no field. */
  protected readonly failure = signal<string | null>(null);
  /** The saved version is no longer the current one. */
  protected readonly stale = signal(false);
  protected readonly confirmOpen = signal(false);
  protected readonly removing = signal(false);

  protected error(field: FieldTree<string | boolean>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected reload(): void {
    this.failure.set(null);
    this.stale.set(false);
    this.loaded.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.accountForm, {
      action: async () => {
        this.failure.set(null);
        this.stale.set(false);
        try {
          this.saved.set(
            await this.api.write(
              this.dealerId(),
              toChange(this.model()),
              (this.saved() as VersionedAccount).etag,
            ),
          );
        } catch (error) {
          return this.reject(error);
        }
        this.toast.success(this.i18n.t('EINVOICING.SAVED'));
        return undefined;
      },
      onInvalid: () => focusFirstError(this.accountForm),
    });
  }

  protected async onRemove(): Promise<void> {
    this.removing.set(true);
    this.failure.set(null);
    this.stale.set(false);
    try {
      await this.api.remove(this.dealerId(), (this.saved() as VersionedAccount).etag);
      this.toast.success(this.i18n.t('EINVOICING.REMOVED'));
      this.loaded.reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        this.stale.set(true);
      } else {
        this.failure.set(failureMessage(this.i18n, error));
      }
    } finally {
      this.removing.set(false);
      this.confirmOpen.set(false);
    }
  }

  private reject(error: unknown): TreeValidationResult {
    if (error instanceof ApiError && error.status === 412) {
      this.stale.set(true);
      return undefined;
    }
    if (error instanceof ApiError && error.status === 503) {
      this.failure.set(this.i18n.t('EINVOICING.NO_ENCRYPTION_KEY'));
      return undefined;
    }
    if (
      error instanceof ApiError &&
      (error.status === 409 || error.code === 'VALIDATION_ERROR') &&
      error.details.length > 0
    ) {
      const f = this.accountForm;
      const mapped = serverFieldErrors(this.i18n, error, {
        enabled: f.enabled,
        username: f.username,
        password: f.password,
        maxPerHour: f.maxPerHour,
        maxPerYear: f.maxPerYear,
      });
      this.failure.set(mapped.unmatched ? this.i18n.t(apiErrorMessageKey(error)) : null);
      return mapped.errors;
    }
    this.failure.set(failureMessage(this.i18n, error));
    return undefined;
  }
}
