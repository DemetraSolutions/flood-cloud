import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, linkedSignal, signal } from '@angular/core';
import {
  disabled,
  email,
  FieldTree,
  form,
  FormField,
  hidden,
  maxLength,
  pattern,
  ReadonlyFieldTree,
  required,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { formatDate } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import { PasswordGenerator } from '../users/password-generator';
import { UsersApi } from '../users/users-api';
import { USERNAME_PATTERN } from '../users/user-form';
import {
  buildCompanyBody,
  buildCompanyPatch,
  codeIssue,
  DealerRecord,
  provinceIssue,
  hasAddress,
  sdiIssue,
  textOrNull,
  toDealerFormModel,
  toFormErrors,
} from './dealer.types';
import { DealersApi } from './dealers-api';

const PHONE_PATTERN = /^[0-9 +\-()]*$/;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

/**
 * Creation (`/dealers/new`) and detail (`/dealers/:dealerId`) of a dealer. Creating asks for the
 * company data and the access user (role Dealer) in one form, sent to one request that creates
 * both. The detail edits the company data only (the user is edited among the platform users).
 * The client checks the same Italian rules as the backend; its `422`/`409` errors land on the fields.
 */
@Component({
  selector: 'fc-dealer-form',
  imports: [
    Button,
    ErrorState,
    FormError,
    FormField,
    PasswordGenerator,
    RouterLink,
    Select,
    StatusBadge,
    TextField,
    TPipe,
  ],
  templateUrl: './dealer-form.html',
  styleUrl: './dealer-form.css',
})
export class DealerForm {
  private readonly api = inject(DealersApi);
  private readonly usersApi = inject(UsersApi);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameter; absent when creating. */
  readonly dealerId = input<string>();

  protected readonly isNew = computed(() => this.dealerId() === undefined);

  private readonly resource = httpResource<ApiData<DealerRecord>>(() => {
    const id = this.dealerId();
    return id === undefined ? undefined : `/v1/dealers/${encodeURIComponent(id)}`;
  });
  private readonly saved = linkedSignal<ApiData<DealerRecord> | undefined, DealerRecord | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.resource.hasValue() ? this.resource.value() : undefined),
    computation: (value) => value?.data ?? null,
  });
  protected readonly dealer = this.saved.asReadonly();
  protected readonly failed = computed(() => this.resource.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.resource.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly loading = computed(() => !this.isNew() && this.resource.isLoading());
  protected readonly canWrite = computed(() =>
    this.session.can(this.isNew() ? 'dealers:create' : 'dealers:update'),
  );
  protected readonly languages = SUPPORTED_LANGUAGES.map((language) => ({
    value: language,
    label: this.i18n.t(`LANGUAGE.NAME.${language.toUpperCase()}`),
  }));

  protected readonly model = linkedSignal(() => toDealerFormModel(this.dealer()));
  protected readonly dealerForm = form(this.model, (path) => {
    required(path.businessName);
    maxLength(path.businessName, 200);
    validate(path.vatNumber, () => {
      const kind = codeIssue('vatNumber', this.model());
      return kind === undefined ? undefined : { kind };
    });
    validate(path.fiscalCode, () => {
      const kind = codeIssue('fiscalCode', this.model());
      return kind === undefined ? undefined : { kind };
    });
    validate(path.sdiCode, ({ value }) => {
      const kind = sdiIssue(value());
      return kind === undefined ? undefined : { kind };
    });
    for (const field of [path.street, path.postcode, path.city]) {
      validate(field, ({ value }) =>
        hasAddress(this.model()) && value().trim() === '' ? { kind: 'required' } : undefined,
      );
    }
    pattern(path.countryCode, /^[A-Za-z]{2}$/);
    validate(path.province, () => {
      const kind = provinceIssue(this.model());
      return kind === undefined ? undefined : { kind };
    });
    maxLength(path.pec, 254);
    email(path.pec);
    maxLength(path.email, 254);
    email(path.email);
    maxLength(path.phone, 32);
    pattern(path.phone, PHONE_PATTERN);

    for (const field of [
      path.username,
      path.password,
      path.userFirstName,
      path.userLastName,
      path.userEmail,
      path.userPhone,
      path.userLanguage,
    ]) {
      hidden(field, () => !this.isNew());
    }
    required(path.username);
    pattern(path.username, USERNAME_PATTERN);
    required(path.password);
    validate(path.password, ({ value, valueOf }) => {
      const length = value().length;
      if (length > 0 && length < PASSWORD_MIN) {
        return { kind: 'tooShort' };
      }
      if (length > PASSWORD_MAX) {
        return { kind: 'tooLong' };
      }
      return length > 0 && value() === valueOf(path.username).trim()
        ? { kind: 'sameAsUsername' }
        : undefined;
    });
    maxLength(path.userFirstName, 100);
    maxLength(path.userLastName, 100);
    maxLength(path.userEmail, 254);
    email(path.userEmail);
    maxLength(path.userPhone, 32);
    pattern(path.userPhone, PHONE_PATTERN);
    disabled(path, () => !this.canWrite());
  });

  protected readonly patch = computed(() => buildCompanyPatch(this.model(), this.dealer()));
  protected readonly hasChanges = computed(
    () => this.isNew() || Object.keys(this.patch()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.dealerForm().submitting());

  // Username availability (same behaviour as the user form).
  private readonly usernameValue = computed(() => this.model().username.trim());
  private readonly needsCheck = computed(
    () => this.isNew() && this.canWrite() && USERNAME_PATTERN.test(this.usernameValue()),
  );
  private readonly checked = signal<{
    username: string;
    result: 'available' | 'taken' | 'error';
  } | null>(null);
  protected readonly availability = computed(() => {
    if (!this.needsCheck()) {
      return 'idle';
    }
    const checked = this.checked();
    return checked?.username === this.usernameValue() ? checked.result : 'checking';
  });
  protected readonly usernameHint = computed(() => {
    const state = this.availability();
    return state === 'idle' ? null : this.i18n.t(`USERS.FORM.USERNAME_${state.toUpperCase()}`);
  });

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

  protected error(field: FieldTree<string>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected usernameError(): string | null {
    const message = this.error(this.dealerForm.username);
    return message ?? (this.availability() === 'taken' ? this.i18n.t('FORM.ISSUE.TAKEN') : null);
  }

  protected date(value: string | null): string {
    return value === null
      ? ''
      : formatDate(value, this.i18n.language() ?? DEFAULT_LANGUAGE, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  }

  protected onGenerated(password: string): void {
    this.dealerForm.password().value.set(password);
  }

  protected reload(): void {
    this.resource.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.dealerForm, {
      action: async () => {
        this.failure.set(null);
        const model = this.model();
        const wasNew = this.isNew();
        let created: DealerRecord | null = null;
        try {
          if (wasNew) {
            created = await this.api.create({
              company: buildCompanyBody(model),
              user: {
                username: model.username.trim(),
                password: model.password,
                language: model.userLanguage,
                ...(textOrNull(model.userFirstName) === null
                  ? {}
                  : { firstName: textOrNull(model.userFirstName) as string }),
                ...(textOrNull(model.userLastName) === null
                  ? {}
                  : { lastName: textOrNull(model.userLastName) as string }),
                ...(textOrNull(model.userEmail) === null
                  ? {}
                  : { email: textOrNull(model.userEmail) as string }),
                ...(textOrNull(model.userPhone) === null
                  ? {}
                  : { phone: textOrNull(model.userPhone) as string }),
              },
            });
          } else {
            this.saved.set(await this.api.update(this.dealerId() as string, this.patch()));
          }
        } catch (error) {
          return this.reject(error);
        }
        this.dealerForm().reset();
        this.toast.success(this.i18n.t(wasNew ? 'DEALERS.FORM.CREATED' : 'DEALERS.FORM.SAVED'));
        if (created !== null) {
          await this.router.navigate(['/dealers', created.id]);
        }
        return undefined;
      },
      onInvalid: () => focusFirstError(this.dealerForm),
    });
  }

  private async checkUsername(username: string): Promise<void> {
    try {
      const available = await this.usersApi.isUsernameAvailable(username);
      this.checked.set({ username, result: available ? 'available' : 'taken' });
    } catch (error) {
      // The check is advisory (the server decides on save); the username is not logged.
      console.warn('Cannot check the availability of the username', error);
      this.checked.set({ username, result: 'error' });
    }
  }

  private reject(error: unknown): TreeValidationResult {
    const fieldsError =
      error instanceof ApiError &&
      (error.code === 'VALIDATION_ERROR' || error.code === 'CONFLICT') &&
      error.details.length > 0;
    if (fieldsError) {
      const f = this.dealerForm;
      const fields: Record<string, ReadonlyFieldTree<unknown>> = {
        businessName: f.businessName,
        vatNumber: f.vatNumber,
        fiscalCode: f.fiscalCode,
        street: f.street,
        postcode: f.postcode,
        city: f.city,
        province: f.province,
        countryCode: f.countryCode,
        pec: f.pec,
        sdiCode: f.sdiCode,
        email: f.email,
        phone: f.phone,
        username: f.username,
        password: f.password,
        userFirstName: f.userFirstName,
        userLastName: f.userLastName,
        userEmail: f.userEmail,
        userPhone: f.userPhone,
        userLanguage: f.userLanguage,
      };
      const mapped = serverFieldErrors(this.i18n, toFormErrors(error), fields);
      if (mapped.unmatched) {
        this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      return mapped.errors;
    }
    this.failure.set(failureMessage(this.i18n, error));
    return undefined;
  }
}
