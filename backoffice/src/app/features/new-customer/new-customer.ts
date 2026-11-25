import { httpResource } from '@angular/common/http';
import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import {
  email,
  FieldTree,
  form,
  FormField,
  maxLength,
  pattern,
  ReadonlyFieldTree,
  readonly,
  required,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { ApiPage } from '../../core/api/api.types';
import { ApiError } from '../../core/api/api-error';
import { FEATURE_NAMES, featureTextKey } from '../../core/groups/feature-catalog';
import { I18nService } from '../../core/i18n/i18n.service';
import { TPipe } from '../../core/i18n/t-pipe';
import { Countries } from '../../core/reference/countries';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { FormError } from '../../shared/ui/form-error/form-error';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog/confirm-dialog';
import { Select } from '../../shared/ui/select/select';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { DealerRecord } from '../dealers/dealer.types';
import { DEALER_PLANS, PLANS } from '../places/place.types';
import { PasswordGenerator } from '../users/password-generator';
import { USERNAME_PATTERN } from '../users/user-form-state';
import { UsersApi } from '../users/users-api';
import { VatLookup, VatLookupField } from '../integrations';
import { NewCustomerApi } from './new-customer-api';
import {
  buildBody,
  CUSTOMER_TYPES,
  CustomerType,
  DEFAULT_TYPE,
  eInvoicingIssue,
  fiscalCodeIssue,
  initialModel,
  NewCustomerModel,
  NewCustomerResult,
  planFeatures,
  postcodeIssue,
  presetFeatures,
  recipientCodeIssue,
  suggestUsername,
  TAX_PRESETS,
  TaxRate,
  vatIssue,
  VatFillField,
  VatFillPlan,
  planVatFill,
} from './new-customer.types';

const PHONE_PATTERN = /^[0-9 +\-()]*$/;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
/** Most dealers read for the select of the platform administrator (the API limit of a page). */
const DEALERS_LIMIT = 200;

/** What a successful creation shows: the ids and the credentials to hand over once. */
interface Created {
  readonly ids: NewCustomerResult;
  readonly username: string;
  readonly password: string;
}

/** Dictionary key of the label of each field the VAT lookup fills. */
const VAT_FIELD_LABELS: Record<VatFillField, string> = {
  companyName: 'NEW_CUSTOMER.FIELD.COMPANY_NAME',
  fiscalCode: 'NEW_CUSTOMER.FIELD.FISCAL_CODE',
  street: 'NEW_CUSTOMER.FIELD.STREET',
  postcode: 'NEW_CUSTOMER.FIELD.POSTCODE',
  city: 'NEW_CUSTOMER.FIELD.CITY',
  province: 'NEW_CUSTOMER.FIELD.PROVINCE',
  pec: 'NEW_CUSTOMER.FIELD.PEC',
};

/** `{ issue }` for a validator, nothing when the value is fine. */
function issueOf(kind: string | undefined): { kind: string } | undefined {
  return kind === undefined ? undefined : { kind };
}

/**
 * "Strumenti › Nuovo cliente" (`/tools/new-customer`, platform administrators and dealers): the
 * quick tool of the legacy backoffice in one page. One request creates the group, its super
 * administrator (with a temporary password), the first company and the first place; the type of
 * customer only presets the features and the tax rates of the form on the client.
 *
 * - The `Idempotency-Key` is generated once for a body and reused on retries of the same body:
 *   a failure keeps the form, and a retry never creates a second group.
 * - A success shows the summary with links; the form is cleared only when the user asks.
 * - A `422` or `409` lands on the fields; `403`, `404` and `429` are shown clearly.
 */
@Component({
  selector: 'fc-new-customer',
  imports: [
    Button,
    Checkbox,
    ConfirmDialog,
    FormError,
    FormField,
    PasswordGenerator,
    RouterLink,
    Select,
    TextField,
    TPipe,
    VatLookupField,
  ],
  templateUrl: './new-customer.html',
  styleUrl: './new-customer.css',
})
export class NewCustomer {
  private readonly api = inject(NewCustomerApi);
  private readonly usersApi = inject(UsersApi);
  private readonly session = inject(SessionService);
  private readonly countries = inject(Countries);
  private readonly toast = inject(ToastService);
  private readonly debouncer = createDebouncer();
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly i18n = inject(I18nService);

  private key = new IdempotencyKey();

  protected readonly role = computed(() => this.session.me()?.role);
  protected readonly isPlatform = computed(() => this.role() === 'PSA');

  protected readonly model = signal<NewCustomerModel>(initialModel(new Date()));
  /** Tax rates and departments of the group: the ones the type presets. */
  protected readonly taxes = signal<readonly TaxRate[]>(TAX_PRESETS[DEFAULT_TYPE]);
  protected readonly created = signal<Created | null>(null);
  protected readonly failure = signal<string | null>(null);

  // --- Lists of the form.
  private readonly dealers = httpResource<ApiPage<DealerRecord>>(() =>
    this.isPlatform()
      ? { url: '/v1/dealers', params: { limit: DEALERS_LIMIT, sort: 'businessName' } }
      : undefined,
  );
  protected readonly dealerOptions = computed(() =>
    (this.dealers.hasValue() ? this.dealers.value().data : [])
      .filter((dealer) => dealer.user?.status === 'active')
      .map((dealer) => ({ value: dealer.id, label: dealer.businessName })),
  );
  protected readonly countryOptions = computed(() =>
    this.countries.list().map((country) => ({ value: country.code, label: country.name })),
  );
  protected readonly areas = computed(() => this.countries.areas(this.model().country));
  protected readonly provinceOptions = computed(() =>
    this.areas().map((area) => ({ value: area.code, label: `${area.name} (${area.code})` })),
  );
  protected readonly typeOptions = CUSTOMER_TYPES.map((type) => ({
    value: type,
    label: this.i18n.t(`NEW_CUSTOMER.TYPE.${type.toUpperCase()}`),
  }));
  protected readonly planOptions = computed(() =>
    (this.role() === 'D' ? DEALER_PLANS : PLANS).map((plan) => ({
      value: plan,
      label: this.i18n.t(`PLACES.PLAN.${plan.toUpperCase().replace('-', '_')}`),
    })),
  );
  protected readonly featureNames = FEATURE_NAMES;
  protected readonly featureLabel = (name: (typeof FEATURE_NAMES)[number]): string =>
    this.i18n.t(featureTextKey(name, 'LABEL'));

  protected readonly customerForm = form(this.model, (path) => {
    required(path.groupName);
    maxLength(path.groupName, 200);

    required(path.companyName);
    maxLength(path.companyName, 150);
    required(path.vatNumber);
    // The VAT number cannot change while its lookup is in flight (the answer would not match it).
    readonly(path.vatNumber, () => this.lookupBusy());
    validate(path.vatNumber, ({ value }) => issueOf(vatIssue(this.model().country, value())));
    validate(path.fiscalCode, ({ value }) =>
      issueOf(fiscalCodeIssue(this.model().country, value())),
    );
    validate(path.recipientCode, ({ value }) =>
      issueOf(recipientCodeIssue(value()) ?? eInvoicingIssue(this.model())),
    );
    maxLength(path.pec, 254);
    email(path.pec);
    required(path.street);
    maxLength(path.street, 200);
    validate(path.postcode, ({ value }) => issueOf(postcodeIssue(this.model().country, value())));
    required(path.city);
    maxLength(path.city, 100);
    required(path.country);
    validate(path.province, ({ value }) =>
      this.areas().length > 0 && value().trim() === '' ? { kind: 'required' } : undefined,
    );
    maxLength(path.companyEmail, 254);
    email(path.companyEmail);
    maxLength(path.companyPhone, 32);
    pattern(path.companyPhone, PHONE_PATTERN);

    required(path.placeName);
    maxLength(path.placeName, 150);
    validate(path.placeStreet, ({ value }) =>
      this.model().otherAddress && value().trim() === '' ? { kind: 'required' } : undefined,
    );
    validate(path.placePostcode, ({ value }) =>
      this.model().otherAddress ? issueOf(postcodeIssue(this.model().country, value())) : undefined,
    );
    validate(path.placeCity, ({ value }) =>
      this.model().otherAddress && value().trim() === '' ? { kind: 'required' } : undefined,
    );
    maxLength(path.contactName, 150);
    maxLength(path.placeEmail, 254);
    email(path.placeEmail);
    maxLength(path.placePhone, 32);
    pattern(path.placePhone, PHONE_PATTERN);

    maxLength(path.firstName, 100);
    maxLength(path.lastName, 100);
    maxLength(path.userEmail, 254);
    email(path.userEmail);
    maxLength(path.userPhone, 32);
    pattern(path.userPhone, PHONE_PATTERN);
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

    required(path.plan);
    required(path.expirationDate);
  });

  // --- VAT lookup (Cerved): an explicit action of the operator.
  protected readonly lookupBusy = signal(false);
  /** The lookup component that found the answer waiting to be applied (it is told when the form is filled). */
  private vatLookup!: VatLookupField;
  /** The answer waiting for the operator to confirm the overwrite. */
  private readonly pendingFill = signal<VatFillPlan | null>(null);
  protected readonly confirmOpen = signal(false);
  protected readonly confirmMessage = computed(() => {
    const plan = this.pendingFill();
    const labels = Object.keys(plan?.overwrite ?? {}).map((field) =>
      this.i18n.t(VAT_FIELD_LABELS[field as VatFillField]),
    );
    return this.i18n.t('NEW_CUSTOMER.LOOKUP.CONFIRM_MESSAGE', { fields: labels.join(', ') });
  });
  /** Only for Italy and when the VAT field holds 11 digits. */
  protected readonly canLookup = computed(
    () => this.model().country === 'IT' && /^\d{11}$/.test(this.model().vatNumber.trim()),
  );

  protected readonly submitting = computed(() => this.customerForm().submitting());

  // --- Username availability (same behaviour as the user form).
  private readonly usernameValue = computed(() => this.model().username.trim());
  private readonly needsCheck = computed(
    () => this.created() === null && USERNAME_PATTERN.test(this.usernameValue()),
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
  /** Set once the operator types the username: the proposal does not overwrite it any more. */
  private usernameEdited = false;

  constructor() {
    this.countries.need();
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
    const message = this.error(this.customerForm.username);
    return message ?? (this.availability() === 'taken' ? this.i18n.t('FORM.ISSUE.TAKEN') : null);
  }

  protected taxLabel(tax: TaxRate): string {
    return this.i18n.t('NEW_CUSTOMER.TAX', { department: tax.department, rate: tax.rate });
  }

  // --- Reactions of the form.

  /** The type presets the features and the tax rates, as the legacy did. */
  protected onType(value: string): void {
    const type = value as CustomerType;
    this.model.update((model) => ({
      ...model,
      type,
      features: presetFeatures(type, model.plan, model.features),
    }));
    this.taxes.set(TAX_PRESETS[type]);
  }

  /** The plan turns on or off the features that depend on it for the type. */
  protected onPlan(plan: string): void {
    this.model.update((model) => ({
      ...model,
      features: { ...model.features, ...planFeatures(model.type as CustomerType, plan) },
    }));
  }

  /** A province of another country is not valid: the choice is cleared when the country changes. */
  protected onCountry(code: string): void {
    const clear = (province: string): string =>
      this.countries.areas(code).some((area) => area.code === province) ? province : '';
    this.model.update((model) => ({
      ...model,
      province: clear(model.province),
      placeProvince: clear(model.placeProvince),
    }));
  }

  protected onFirstName(firstName: string): void {
    this.suggest(firstName, this.model().lastName);
  }

  protected onLastName(lastName: string): void {
    this.suggest(this.model().firstName, lastName);
  }

  protected onUsernameEdited(): void {
    this.usernameEdited = true;
  }

  protected onGenerated(password: string): void {
    this.customerForm.password().value.set(password);
  }

  private suggest(firstName: string, lastName: string): void {
    const username = suggestUsername(firstName, lastName);
    if (!this.usernameEdited && username !== '') {
      this.customerForm.username().value.set(username);
    }
  }

  // --- VAT lookup.

  /** The operator confirmed: every field of the answer is written, also the ones that differ. */
  protected confirmFill(): void {
    const plan = this.pendingFill()!;
    this.fill({ ...plan.empty, ...plan.overwrite });
    this.closeConfirm();
  }

  /** The dialog was closed without confirming: only the empty fields are filled. */
  protected cancelFill(): void {
    const plan = this.pendingFill();
    if (plan !== null) {
      this.fill(plan.empty);
      this.closeConfirm();
    }
  }

  /** The lookup found the company of the VAT number in the form: fills the form, asking before it replaces anything. */
  protected applyLookup(found: VatLookup, source: VatLookupField): void {
    this.vatLookup = source;
    const provinces = this.countries.areas('IT').map((area) => area.code);
    const plan = planVatFill(this.model(), found, provinces);
    if (Object.keys(plan.overwrite).length === 0) {
      this.fill(plan.empty);
    } else {
      this.pendingFill.set(plan);
      this.confirmOpen.set(true);
    }
  }

  private closeConfirm(): void {
    this.confirmOpen.set(false);
    this.pendingFill.set(null);
  }

  private fill(values: Readonly<Partial<Record<VatFillField, string>>>): void {
    this.model.update((model) => ({ ...model, ...values, country: 'IT' }));
    this.vatLookup.filled();
  }

  // --- Submission.

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.customerForm, {
      action: async () => {
        this.failure.set(null);
        const model = this.model();
        const body = buildBody(model, this.taxes(), this.role());
        try {
          const ids = await this.api.create(body, this.key.forBody(body));
          this.key.reset();
          this.created.set({ ids, username: body.user.username, password: model.password });
          this.toast.success(this.i18n.t('NEW_CUSTOMER.CREATED'));
          afterNextRender(
            () => this.host.nativeElement.querySelector<HTMLElement>('#summary-heading')!.focus(),
            { injector: this.injector },
          );
        } catch (error) {
          return this.reject(error);
        }
        return undefined;
      },
      onInvalid: () => focusFirstError(this.customerForm),
    });
  }

  /** The user asked for another customer: the form and the key start over. */
  protected startOver(): void {
    this.key = new IdempotencyKey();
    this.usernameEdited = false;
    this.failure.set(null);
    this.model.set(initialModel(new Date()));
    this.taxes.set(TAX_PRESETS[DEFAULT_TYPE]);
    this.customerForm().reset();
    this.created.set(null);
  }

  protected async copyPassword(password: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(password);
      this.toast.success(this.i18n.t('PASSWORD_GENERATOR.COPIED'));
    } catch (error) {
      console.warn('Cannot copy to the clipboard', error);
      this.toast.error(this.i18n.t('PASSWORD_GENERATOR.COPY_FAILED'));
    }
  }

  private async checkUsername(username: string): Promise<void> {
    try {
      const available = await this.usersApi.isUsernameAvailable(username);
      this.checked.set({ username, result: available ? 'available' : 'taken' });
    } catch (error) {
      // The check is advisory (the server decides on creation); the username is not logged.
      console.warn('Cannot check the availability of the username', error);
      this.checked.set({ username, result: 'error' });
    }
  }

  /** Errors with details land on the fields; the others are shown for the form as a whole. */
  private reject(error: unknown): TreeValidationResult {
    if (error instanceof ApiError && error.details.length > 0) {
      const mapped = serverFieldErrors(this.i18n, error, this.serverFields());
      if (mapped.unmatched) {
        this.failure.set(failureMessage(this.i18n, error));
      }
      return mapped.errors;
    }
    this.failure.set(this.failureText(error));
    return undefined;
  }

  private failureText(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 404) {
        return this.i18n.t('NEW_CUSTOMER.ERROR.DEALER_NOT_FOUND');
      }
      if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== null) {
        return this.i18n.t('NEW_CUSTOMER.ERROR.RATE_LIMITED_WAIT', {
          seconds: error.retryAfterSeconds,
        });
      }
    }
    return failureMessage(this.i18n, error);
  }

  /** Field of the request body to the field of the form. */
  private serverFields(): Record<string, ReadonlyFieldTree<unknown>> {
    const f = this.customerForm;
    return {
      'group.name': f.groupName,
      'group.dealerId': f.dealerId,
      'group.demo': f.demo,
      'company.name': f.companyName,
      'company.vatNumber': f.vatNumber,
      'company.fiscalCode': f.fiscalCode,
      'company.eInvoicing.recipientCode': f.recipientCode,
      'company.eInvoicing.pec': f.pec,
      'company.address.street': f.street,
      'company.address.postcode': f.postcode,
      'company.address.city': f.city,
      'company.address.country': f.country,
      'company.address.province': f.province,
      'company.phone': f.companyPhone,
      'company.email': f.companyEmail,
      'place.name': f.placeName,
      'place.address.street': f.placeStreet,
      'place.address.postcode': f.placePostcode,
      'place.address.city': f.placeCity,
      'place.address.province': f.placeProvince,
      'place.contactName': f.contactName,
      'place.phone': f.placePhone,
      'place.email': f.placeEmail,
      'place.plan': f.plan,
      'place.expirationDate': f.expirationDate,
      'user.firstName': f.firstName,
      'user.lastName': f.lastName,
      'user.phone': f.userPhone,
      'user.email': f.userEmail,
      'user.username': f.username,
      'user.password': f.password,
    };
  }
}
