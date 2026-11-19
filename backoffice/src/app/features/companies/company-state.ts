import { httpResource } from '@angular/common/http';
import {
  afterNextRender,
  computed,
  inject,
  Injector,
  linkedSignal,
  resource,
  Service,
  Signal,
  signal,
} from '@angular/core';
import {
  applyEach,
  disabled,
  FieldTree,
  form,
  maxLength,
  pattern,
  ReadonlyFieldTree,
  required,
  submit,
  TreeValidationResult,
} from '@angular/forms/signals';
import { Router } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { GroupFeatures } from '../../core/groups/group-features';
import { I18nService } from '../../core/i18n/i18n.service';
import { Countries } from '../../core/reference/countries';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { PriceList } from '../groups/catalogs/catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { CompaniesApi, VersionedCompany } from './companies-api';
import { hasFieldDetails, isStale, resolveField } from './company-errors';
import {
  CompanyModel,
  createBody,
  dirtySections,
  formPathOf,
  patchBody,
  toModel,
  withSections,
} from './company-model';
import {
  COMPANY_SECTIONS,
  CompanyRecord,
  CompanySection,
  companyRoute,
  HubOption,
} from './company.types';

type Section = (typeof COMPANY_SECTIONS)[number];

/** The route parameters of the page. */
interface Source {
  readonly groupId: Signal<string>;
  readonly companyId: Signal<string | undefined>;
}

/** Reads a tab asks the state for when it is shown. */
export type CompanyLookup = 'countries' | 'currencies' | 'priceLists' | 'hubs';

/**
 * State of the company page, shared by its tabs (child routes): the company as the server has
 * it with its version (`ETag`), the whole form (one Signal Form with a property per tab, so
 * switching tabs loses nothing), what each tab has changed, the lookups the tabs need and the
 * saves. It is provided by the page, so every opened company has its own.
 *
 * The one save presents the version in `If-Match` and sends the sections with changes in a
 * single `PATCH` (the general fields and whole blocks), or creates the company on the page of a
 * new one. A save puts back the sections it wrote. `422`,
 * `409` and `403` errors with details land on the fields, whichever tab they are in.
 */
@Service({ autoProvided: false })
export class CompanyState {
  private readonly api = inject(CompaniesApi);
  private readonly session = inject(SessionService);
  private readonly features = inject(GroupFeatures);
  private readonly store = inject(ReferenceStore);
  private readonly countries = inject(Countries);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  readonly i18n = inject(I18nService);

  private readonly source = signal<Source | null>(null);
  /** The `Idempotency-Key` of the creation: one per opening of the form, reused on retries. */
  private readonly createKey = new IdempotencyKey();

  /** Binds the state to the route parameters of the page (called once by the page). */
  attach(groupId: Signal<string>, companyId: Signal<string | undefined>): void {
    this.source.set({ groupId, companyId });
  }

  /** Id of the group (the page attaches it before anything reads it). */
  readonly groupId = computed(() => (this.source() as Source).groupId());
  /** Id of the company; `undefined` on the page of a new company. */
  readonly companyId = computed(() => (this.source() as Source).companyId());
  /** Whether the page creates a company. */
  readonly isNew = computed(() => this.companyId() === undefined);

  private readonly resource = httpResource<ApiData<CompanyRecord>>(() => {
    const groupId = this.groupId();
    const companyId = this.companyId();
    return groupId === null || companyId === undefined
      ? undefined
      : `/v1/groups/${encodeURIComponent(groupId)}/companies/${encodeURIComponent(companyId)}`;
  });

  private readonly saved = linkedSignal<
    { value: ApiData<CompanyRecord>; etag: string | null } | undefined,
    VersionedCompany | null
  >({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () =>
      this.resource.hasValue()
        ? { value: this.resource.value(), etag: this.resource.headers()?.get('ETag') ?? null }
        : undefined,
    computation: (loaded) =>
      loaded === undefined ? null : { company: loaded.value.data, etag: loaded.etag },
  });

  /** The company as the server has it; `null` while loading, when it failed, or for a new one. */
  readonly company = computed(() => this.saved()?.company ?? null);
  /** Whether the company is being read. */
  readonly loading = this.resource.isLoading;
  /** Whether reading the company failed. */
  readonly loadFailed = computed(() => this.resource.error() !== undefined);
  /** Why reading failed, when the backend said so. */
  readonly loadError = computed(() => apiErrorOf(this.resource.error()));

  /** What the form holds; a reload of the company replaces it, a save replaces what it wrote. */
  readonly model = linkedSignal<ApiData<CompanyRecord> | undefined, CompanyModel>({
    source: () => (this.resource.hasValue() ? this.resource.value() : undefined),
    computation: (loaded) => toModel(loaded?.data ?? null),
  });

  /** The model of the saved company, to tell what changed. */
  readonly baseline = computed(() => toModel(this.company()));
  /** The sections with unsaved changes. */
  readonly dirty = computed(() => dirtySections(this.model(), this.baseline()));
  /** Whether any section has unsaved changes. */
  readonly anyDirty = computed(() => this.dirty().size > 0);

  // What the user may do.
  /** Whether the user may write (create on the new page, update otherwise). */
  readonly canWrite = computed(() =>
    this.session.can(this.isNew() ? 'companies:create' : 'companies:update'),
  );
  /** Whether the user may change the reserved fields (platform administrators and dealers). */
  readonly canReserved = computed(() => {
    const role = this.session.me()?.role;
    return this.canWrite() && (role === 'PSA' || role === 'D');
  });
  private readonly privileged = computed(() => {
    const role = this.session.me()?.role;
    return role === 'PSA' || role === 'D';
  });

  /** The tabs of a company the user sees: the legacy rules by role and by the features of the group. */
  readonly sections = computed(() =>
    COMPANY_SECTIONS.filter((section) => {
      switch (section.id) {
        case 'customerApp':
          return this.privileged() || this.features.enabledFor(this.groupId(), 'customersApp');
        case 'mealVoucherIssuers':
          return this.privileged() || this.features.enabledFor(this.groupId(), 'rooms');
        case 'media':
          return this.features.enabledFor(this.groupId(), 'media');
        default:
          return true;
      }
    }),
  );

  /** The form: one property per section. */
  readonly form = form(this.model, (path) => {
    required(path.general.name);
    maxLength(path.general.name, 150);
    required(path.general.vatNumber);
    maxLength(path.general.vatNumber, 30);
    maxLength(path.general.fiscalCode, 30);
    required(path.general.address.street);
    maxLength(path.general.address.street, 150);
    required(path.general.address.postcode);
    maxLength(path.general.address.postcode, 20);
    required(path.general.address.city);
    maxLength(path.general.address.city, 100);
    required(path.general.address.country);
    maxLength(path.general.address.province, 10);
    required(path.general.currency);
    maxLength(path.general.phone, 30);
    pattern(path.eInvoicing.rea.shareCapital, /^(\d+(\.\d{1,2})?)?$/);
    pattern(path.invoiceNumbering.lastInvoiceNumber, /^\d{0,10}$/);
    applyEach(path.invoiceNumbering.values, (value) => {
      required(value.name);
      maxLength(value.name, 50);
    });
    applyEach(path.bankAccounts, (bank) => {
      required(bank.iban);
      maxLength(bank.name, 100);
    });
    applyEach(path.mealVoucherIssuers, (issuer) => {
      required(issuer.name);
      maxLength(issuer.name, 100);
    });
    disabled(path, () => !this.canWrite());
    const notReserved = () => !this.canReserved();
    disabled(path.general.status, notReserved);
    disabled(path.general.expirationDate, notReserved);
    disabled(path.eInvoicing.hub, notReserved);
    disabled(path.eInvoicing.transmitter.country, notReserved);
    disabled(path.eInvoicing.transmitter.code, notReserved);
    disabled(path.invoiceNumbering.cervedLookup, notReserved);
  });

  /** Errors of each tab, to mark it: server errors, and client errors once the field was touched. */
  readonly errorCounts = computed<Readonly<Record<CompanySection, number>>>(
    () =>
      Object.fromEntries(
        COMPANY_SECTIONS.map(({ id }) => [
          id,
          (this.form[id] as FieldTree<unknown>)()
            .errorSummary()
            .filter((error) => error.kind === 'server' || error.fieldTree().touched()).length,
        ]),
      ) as Record<CompanySection, number>,
  );

  // Lookups, read when a tab asks for them.
  private readonly needs = signal<ReadonlySet<CompanyLookup>>(new Set());

  /** Asks for a lookup (idempotent); the data arrives in the matching signal. */
  need(lookup: CompanyLookup): void {
    if (lookup === 'countries') {
      this.countries.need();
    }
    this.needs.update((current) => (current.has(lookup) ? current : new Set(current).add(lookup)));
  }

  private readonly currenciesResource = httpResource<ApiData<{ code: string; symbol: string }[]>>(
    () => {
      const groupId = this.groupId();
      return groupId !== null && this.needs().has('currencies') && this.session.can('groups:read')
        ? `/v1/groups/${encodeURIComponent(groupId)}/currencies`
        : undefined;
    },
  );
  private readonly priceListsResource = resource({
    params: () => {
      const groupId = this.groupId();
      const allowed =
        this.session.can('groups:read') ||
        this.session.can('users:read') ||
        this.session.can('fidelity:read');
      return groupId !== null && this.needs().has('priceLists') && allowed ? groupId : undefined;
    },
    loader: ({ params }) => this.store.page<PriceList>(params, 'price-lists'),
  });
  private readonly hubsResource = httpResource<ApiData<HubOption[]>>(() => {
    const groupId = this.groupId();
    return groupId !== null && this.needs().has('hubs') && this.canReserved()
      ? `/v1/groups/${encodeURIComponent(groupId)}/companies/e-invoicing-hubs`
      : undefined;
  });

  /** Currency codes of the group; empty when not read (or when the user cannot read them). */
  readonly currencies = computed(() =>
    this.currenciesResource.hasValue()
      ? this.currenciesResource.value().data.map((c) => c.code)
      : [],
  );
  /** Price lists of the group; empty when not read. */
  readonly priceLists = computed(() =>
    this.priceListsResource.hasValue() ? this.priceListsResource.value().data : [],
  );
  /** E-invoicing hubs the user may set; empty for everyone but platform administrators and dealers. */
  readonly hubs = computed(() =>
    this.hubsResource.hasValue() ? this.hubsResource.value().data : [],
  );
  /** Whether a lookup could not be read (the select keeps the stored value). */
  readonly lookupFailed = computed(() =>
    [
      this.countries.failed(),
      this.currenciesResource.error() !== undefined,
      this.priceListsResource.error() !== undefined,
      this.hubsResource.error() !== undefined,
    ].some(Boolean),
  );

  // Saving.
  /** Message of the last failed save that does not belong to a field. */
  readonly failure = signal<string | null>(null);
  /** Whether the last save failed because the company changed meanwhile (`412`). */
  readonly stale = signal(false);
  /** Whether a save is running. */
  readonly saving = signal(false);

  /** Message to show under a field: server errors, and client errors once touched. */
  fieldError(field: ReadonlyFieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  /**
   * Changes one section of the model (rows added, removed or reordered by a tab); the form
   * follows the model.
   *
   * @param section The section.
   * @param change Returns the new value of the section from the current one.
   */
  edit<S extends CompanySection>(
    section: S,
    change: (value: CompanyModel[S]) => CompanyModel[S],
  ): void {
    this.model.update((model) => ({ ...model, [section]: change(model[section]) }));
  }

  /** Reads the company again and drops every draft (after a `412`, or on request). */
  reload(): void {
    this.failure.set(null);
    this.stale.set(false);
    this.resource.reload();
  }

  /**
   * The one save of the page: creates the company on the page of a new one, otherwise sends every
   * section with changes in a single `PATCH` presenting the version (`If-Match`), so that the
   * company is never left half saved. Validates the whole form and, when something is invalid,
   * opens the first tab with an error and moves the focus to its first invalid field.
   *
   * @returns Whether the save succeeded.
   */
  async save(): Promise<boolean> {
    this.saving.set(true);
    try {
      return await submit(this.form, {
        action: () => this.send(),
        onInvalid: () => void this.reveal(),
      });
    } finally {
      this.saving.set(false);
    }
  }

  private async send(): Promise<TreeValidationResult> {
    this.failure.set(null);
    this.stale.set(false);
    const created = this.isNew();
    const sections: ReadonlySet<CompanySection> = created
      ? new Set(COMPANY_SECTIONS.map((section) => section.id))
      : this.dirty();
    let result: VersionedCompany;
    try {
      result = await this.request(sections);
    } catch (error) {
      return this.reject(error);
    }
    this.saved.set(result);
    this.model.update((model) => withSections(model, result.company, sections));
    for (const id of sections) {
      (this.form[id] as FieldTree<unknown>)().reset();
    }
    this.toast.success(this.i18n.t(created ? 'COMPANIES.CREATED' : 'COMPANIES.SAVED'));
    if (created) {
      await this.router.navigate(companyRoute(result.company.groupId, result.company.id));
    }
    return undefined;
  }

  private request(sections: ReadonlySet<CompanySection>): Promise<VersionedCompany> {
    const groupId = this.groupId() as string;
    const model = this.model();
    if (this.isNew()) {
      const body = createBody(model.general);
      return this.api.create(groupId, body, this.createKey.forBody(body));
    }
    const current = this.saved() as VersionedCompany;
    return this.api.patch(
      groupId,
      current.company.id,
      patchBody(model, this.baseline(), sections),
      current.etag,
      current.company,
    );
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('COMPANIES.CONFLICT'));
      return undefined;
    }
    if (!hasFieldDetails(error)) {
      this.failure.set(failureMessage(this.i18n, error));
      return undefined;
    }
    const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
    for (const { field } of error.details) {
      const tree = resolveField(this.form, formPathOf(field));
      if (tree !== undefined) {
        fields[field] = tree;
      }
    }
    const mapped = serverFieldErrors(this.i18n, error, fields);
    if (error.code === 'FORBIDDEN') {
      this.failure.set(this.i18n.t('COMPANIES.NOT_ALLOWED'));
    } else if (mapped.unmatched) {
      this.failure.set(failureMessage(this.i18n, error));
    }
    return mapped.errors;
  }

  /** Opens the first tab that has an error and moves the focus to its first invalid field. */
  private async reveal(): Promise<void> {
    const section = COMPANY_SECTIONS.find(
      (candidate) => this.errorCounts()[candidate.id] > 0,
    ) as Section;
    if (!this.isNew()) {
      const base = companyRoute(this.groupId() as string, this.companyId() as string);
      await this.router.navigate([...base, section.path].filter((segment) => segment !== ''));
    }
    afterNextRender(() => focusFirstError(this.form[section.id] as FieldTree<unknown>), {
      injector: this.injector,
    });
  }
}
