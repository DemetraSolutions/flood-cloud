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
  ReadonlyFieldTree,
  required,
  submit,
  TreeValidationResult,
} from '@angular/forms/signals';
import { Router } from '@angular/router';
import { ApiData } from '../../core/api/api.types';
import { FeatureName } from '../../core/groups/feature-catalog';
import { GroupFeatures } from '../../core/groups/group-features';
import { I18nService } from '../../core/i18n/i18n.service';
import { Countries } from '../../core/reference/countries';
import { ReferenceKind, ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import {
  failureMessage,
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { IdempotencyKey } from '../../shared/util/idempotency';
import { CompanyRecord } from '../companies/company.types';
import { hasFieldDetails, isStale } from '../companies/company-errors';
import { PriceList } from '../groups/catalogs/catalog.types';
import { apiErrorOf } from '../profile/sessions';
import { loadAll } from './lookup-loader';
import { resolvePlaceField } from './place-errors';
import { FieldDef, isVisible } from './place-fields';
import {
  blockBody,
  createBody,
  dirtySections,
  patchBody,
  PlaceModel,
  toModel,
  WEEK_DAYS,
  withSections,
} from './place-model';
import { PlacesApi, VersionedPlace } from './places-api';
import {
  PLACE_SECTIONS,
  PlaceRecord,
  PlaceSection,
  placeRoute,
  PLANS,
  DEALER_PLANS,
} from './place.types';

type Section = (typeof PLACE_SECTIONS)[number];

/** The route parameters of the page. */
interface Source {
  readonly groupId: Signal<string>;
  readonly placeId: Signal<string | undefined>;
}

/** Reads a tab asks the state for when it is shown. */
export type PlaceLookup =
  | 'countries'
  | 'currencies'
  | 'priceLists'
  | 'companies'
  | 'places'
  | 'categories'
  | 'languages'
  | 'templates'
  | 'series';

/** What a save sends: one section, or every section with unsaved changes. */
export type SaveScope = PlaceSection | 'all';

/**
 * State of the place page, shared by its tabs (child routes): the place as the server has it with
 * its version (`ETag`), the whole form (one Signal Form with a property per tab, so switching tabs
 * loses nothing), what each tab has changed, the lookups the tabs need and the saves. It is
 * provided by the page, so every opened place has its own.
 *
 * Saving presents the version in `If-Match`: a tab saves with its own request (`PATCH` for the
 * general data, `PUT` for a block), "save all" sends the sections with changes in the unique
 * `PATCH`. A save puts back only the sections it wrote; the drafts of the others stay. `422`,
 * `409` and `403` errors with details land on the fields, whichever tab they are in. What the
 * user may change comes from the role, as the server decides it: the plan (platform
 * administrators; dealers choose it only when creating), the expiration date and the status
 * (platform administrators and dealers), Sentry (platform administrators).
 */
@Service({ autoProvided: false })
export class PlaceState {
  private readonly api = inject(PlacesApi);
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
  attach(groupId: Signal<string>, placeId: Signal<string | undefined>): void {
    this.source.set({ groupId, placeId });
  }

  /** Id of the group (the page attaches it before anything reads it). */
  readonly groupId = computed(() => (this.source() as Source).groupId());
  /** Id of the place; `undefined` on the page of a new place. */
  readonly placeId = computed(() => (this.source() as Source).placeId());
  /** Whether the page creates a place. */
  readonly isNew = computed(() => this.placeId() === undefined);

  private readonly resource = httpResource<ApiData<PlaceRecord>>(() => {
    const placeId = this.placeId();
    return placeId === undefined
      ? undefined
      : `/v1/groups/${encodeURIComponent(this.groupId())}/places/${encodeURIComponent(placeId)}`;
  });

  private readonly saved = linkedSignal<
    { value: ApiData<PlaceRecord>; etag: string | null } | undefined,
    VersionedPlace | null
  >({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () =>
      this.resource.hasValue()
        ? { value: this.resource.value(), etag: this.resource.headers()?.get('ETag') ?? null }
        : undefined,
    computation: (loaded) =>
      loaded === undefined ? null : { place: loaded.value.data, etag: loaded.etag },
  });

  /** The place as the server has it; `null` while loading, when it failed, or for a new one. */
  readonly place = computed(() => this.saved()?.place ?? null);
  /** Whether the place is being read. */
  readonly loading = this.resource.isLoading;
  /** Whether reading the place failed. */
  readonly loadFailed = computed(() => this.resource.error() !== undefined);
  /** Why reading failed, when the backend said so. */
  readonly loadError = computed(() => apiErrorOf(this.resource.error()));

  /** What the form holds; a reload of the place replaces it, a save replaces what it wrote. */
  readonly model = linkedSignal<ApiData<PlaceRecord> | undefined, PlaceModel>({
    source: () => (this.resource.hasValue() ? this.resource.value() : undefined),
    computation: (loaded) => toModel(loaded?.data ?? null),
  });

  /** The model of the saved place, to tell what changed. */
  readonly baseline = computed(() => toModel(this.place()));
  /** The sections with unsaved changes. */
  readonly dirty = computed(() => dirtySections(this.model(), this.baseline()));
  /** Whether any section has unsaved changes. */
  readonly anyDirty = computed(() => this.dirty().size > 0);

  // What the user may do.
  private readonly role = computed(() => this.session.me()?.role);
  private readonly privileged = computed(() => this.role() === 'PSA' || this.role() === 'D');
  /** Whether the user is a platform administrator or a dealer. */
  readonly isPrivileged = this.privileged;
  /** Whether the user may write (create on the new page, update otherwise). */
  readonly canWrite = computed(() =>
    this.session.can(this.isNew() ? 'places:create' : 'places:update'),
  );
  /** Whether the user may choose the plan: platform administrators, and dealers only for a new place. */
  readonly canPlan = computed(
    () => this.canWrite() && (this.role() === 'PSA' || (this.isNew() && this.role() === 'D')),
  );
  /** Whether the user may change the expiration date, the status and the web widget of the appointments. */
  readonly canReserved = computed(() => this.canWrite() && this.privileged());
  /** Whether the user may change the Sentry switch (platform administrators). */
  readonly canSentry = computed(() => this.canWrite() && this.role() === 'PSA');
  /** Whether the user may move the place to another company (a store administrator may not). */
  readonly canCompany = computed(() => this.canWrite() && this.role() !== 'PA');

  /** The plans the user may choose, with the stored one when it is not among them (a historical plan). */
  readonly plans = computed(() => {
    const allowed: readonly string[] = this.role() === 'D' ? DEALER_PLANS : PLANS;
    const stored = this.baseline().license.plan;
    return stored === '' || allowed.includes(stored) ? [...allowed] : [...allowed, stored];
  });

  /** The plans the user may choose as select options, a plan the interface does not know shown as stored. */
  readonly planOptions = computed(() =>
    this.plans().map((plan) => ({
      value: plan,
      label: (PLANS as readonly string[]).includes(plan)
        ? this.i18n.t(`PLACES.PLAN.${plan.toUpperCase().replace('-', '_')}`)
        : plan,
    })),
  );

  /** Whether the group has a feature (the interface of the places adapts to the modules of the group). */
  readonly hasFeature = (name: FeatureName): boolean => this.features.enabled(name);

  /** Whether a key of a tab is shown: the legacy rules by role and by the features of the group. */
  readonly isShown = (definition: FieldDef): boolean =>
    isVisible(definition, {
      privileged: this.privileged(),
      feature: (name) => this.features.enabled(name),
    });

  /** Whether the store key tab is offered: platform administrators and dealers, on an existing place. */
  readonly hasStoreKey = computed(() => !this.isNew() && this.session.can('storeKeys:read'));

  /** The tabs of a place the user sees: the legacy rules by plan, role and by the features of the group. */
  readonly sections = computed(() => {
    const secondary = this.place()?.license.plan === 'tgm-secondary';
    return PLACE_SECTIONS.filter((section) => {
      switch (section.id) {
        case 'general':
        case 'license':
          return true;
        case 'tables':
        case 'reservations':
        case 'delivery':
        case 'selfOrdering':
          return !secondary && this.features.enabled('rooms');
        case 'appointments':
          return !secondary && this.features.enabled('appointments');
        case 'tobacco':
          return (
            !secondary && (this.privileged() || this.features.enabled('tobaccosGamesMonopoly'))
          );
        case 'media':
          return !secondary && this.features.enabled('media');
        default:
          return !secondary;
      }
    });
  });

  /** The form: one property per section. */
  readonly form = form(this.model, (path) => {
    required(path.general.name);
    maxLength(path.general.name, 150);
    required(path.general.companyId);
    const created = { when: () => this.isNew() };
    required(path.general.address.street, created);
    maxLength(path.general.address.street, 150);
    required(path.general.address.postcode, created);
    maxLength(path.general.address.postcode, 20);
    required(path.general.address.city, created);
    maxLength(path.general.address.city, 100);
    required(path.general.address.country, created);
    maxLength(path.general.address.province, 10);
    maxLength(path.general.contactName, 100);
    maxLength(path.general.phone, 30);
    for (const schedule of [path.openingHours, path.openingHours.deliveryTime]) {
      for (const day of WEEK_DAYS) {
        applyEach(schedule.week[day].values, (slot) => {
          required(slot.start);
          required(slot.end);
        });
      }
      applyEach(schedule.special, (day) => {
        required(day.date);
        applyEach(day.values, (slot) => {
          required(slot.start);
          required(slot.end);
        });
      });
    }
    applyEach(path.payments.paymentTypes, (type) => {
      required(type.name);
      maxLength(type.name, 100);
    });
    applyEach(path.reservations.timeBlocks, (block) => {
      required(block.start);
      required(block.end);
    });
    disabled(path, { when: () => !this.canWrite() });
    disabled(path.general.companyId, { when: () => !this.canCompany() });
    disabled(path.license.plan, { when: () => !this.canPlan() });
    disabled(path.license.expirationDate, { when: () => !this.canReserved() });
    disabled(path.license.status, { when: () => !this.canReserved() });
    disabled(path.license.sentry, { when: () => !this.canSentry() });
    disabled(path.appointments.f['webWidgetStatus'], { when: () => !this.canReserved() });
  });

  /** Errors of each tab, to mark it: server errors, and client errors once the field was touched. */
  readonly errorCounts = computed<Readonly<Record<PlaceSection, number>>>(
    () =>
      Object.fromEntries(
        PLACE_SECTIONS.map(({ id }) => [
          id,
          (this.form[id] as FieldTree<unknown>)()
            .errorSummary()
            .filter((error) => error.kind === 'server' || error.fieldTree().touched()).length,
        ]),
      ) as Record<PlaceSection, number>,
  );

  // Lookups, read when a tab asks for them.
  private readonly needs = signal<ReadonlySet<PlaceLookup>>(new Set());

  /** Asks for a lookup (idempotent); the data arrives in the matching signal. */
  need(lookup: PlaceLookup): void {
    if (lookup === 'countries') {
      this.countries.need();
    }
    this.needs.update((current) => (current.has(lookup) ? current : new Set(current).add(lookup)));
  }

  private readonly currenciesResource = httpResource<ApiData<{ code: string }[]>>(() =>
    this.needs().has('currencies') && this.session.can('groups:read')
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/currencies`
      : undefined,
  );
  private readonly languagesResource = httpResource<ApiData<{ code: string }[]>>(() =>
    this.needs().has('languages') &&
    (this.session.can('places:update') || this.session.can('groups:read'))
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/lookup/languages`
      : undefined,
  );
  private readonly priceListsResource = resource({
    params: () => {
      const allowed =
        this.session.can('groups:read') ||
        this.session.can('users:read') ||
        this.session.can('fidelity:read');
      return this.needs().has('priceLists') && allowed ? this.groupId() : undefined;
    },
    loader: ({ params }) => this.store.page<PriceList>(params, 'price-lists'),
  });
  private readonly companiesResource = this.referenceResource(
    'companies',
    'companies',
    'companies:read',
  );
  private readonly placesResource = this.referenceResource('places', 'places', 'places:read');
  private readonly templatesResource = this.referenceResource(
    'templates',
    'email-templates',
    'places:update',
  );
  private readonly categoriesResource = this.referenceResource(
    'categories',
    'product-categories',
    'products:read',
  );
  private readonly seriesCompany = computed(() => this.model().general.companyId);
  /** Whether the company in the form is not the one the place has: its series come from the company. */
  private readonly companyChanged = computed(
    () => this.isNew() || this.seriesCompany() !== (this.place()?.companyId ?? ''),
  );
  private readonly placeSeriesResource = httpResource<ApiData<{ name: string }[]>>(() => {
    const placeId = this.placeId();
    return this.needs().has('series') &&
      !this.companyChanged() &&
      placeId !== undefined &&
      this.session.can('places:update')
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/places/${encodeURIComponent(placeId)}/invoice-series`
      : undefined;
  });
  private readonly seriesResource = httpResource<ApiData<CompanyRecord>>(() => {
    const companyId = this.seriesCompany();
    return this.needs().has('series') &&
      this.companyChanged() &&
      this.session.can('companies:read') &&
      companyId !== ''
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/companies/${encodeURIComponent(companyId)}`
      : undefined;
  });

  private referenceResource(lookup: PlaceLookup, kind: ReferenceKind, permission: string) {
    return resource({
      params: () =>
        this.needs().has(lookup) && this.session.can(permission) ? this.groupId() : undefined,
      loader: ({ params }) => loadAll(this.store, params, kind),
    });
  }

  /** Currency codes of the group; empty when not read (or when the user cannot read them). */
  readonly currencies = computed(() =>
    this.currenciesResource.hasValue()
      ? this.currenciesResource.value().data.map((c) => c.code)
      : [],
  );
  /** Languages of the group; empty when not read (or when the user cannot read the group). */
  readonly languages = computed(() =>
    this.languagesResource.hasValue()
      ? this.languagesResource.value().data.map((language) => language.code)
      : [],
  );
  /** Price lists of the group; empty when not read. */
  readonly priceLists = computed(() =>
    this.priceListsResource.hasValue() ? this.priceListsResource.value().data : [],
  );
  /** Companies of the group the user can see; empty when not read. */
  readonly companies = computed(() =>
    this.companiesResource.hasValue() ? this.companiesResource.value() : [],
  );
  /** Places of the group the user can see; empty when not read. */
  readonly places = computed(() =>
    this.placesResource.hasValue() ? this.placesResource.value() : [],
  );
  /** Product categories of the group; empty when not read. */
  readonly categories = computed(() =>
    this.categoriesResource.hasValue() ? this.categoriesResource.value() : [],
  );
  /** Email templates of the group; empty when not read. */
  readonly templates = computed(() =>
    this.templatesResource.hasValue() ? this.templatesResource.value() : [],
  );
  /**
   * Invoice series to choose from: those of the company of the place, or, after the company was
   * changed in the form, those of the new company; empty when not read.
   */
  readonly series = computed(() => {
    if (this.companyChanged()) {
      return this.seriesResource.hasValue()
        ? this.seriesResource.value().data.invoiceNumbering.values.map((value) => value.name)
        : [];
    }
    return this.placeSeriesResource.hasValue()
      ? this.placeSeriesResource.value().data.map((value) => value.name)
      : [];
  });
  /** Whether the company was changed and the user cannot read companies: the series of the new one are unknown. */
  readonly seriesUnknown = computed(
    () => this.companyChanged() && !this.session.can('companies:read'),
  );
  /** Whether a lookup could not be read (the select keeps the stored value). */
  readonly lookupFailed = computed(
    () =>
      this.countries.failed() ||
      [
        this.currenciesResource.error(),
        this.languagesResource.error(),
        this.priceListsResource.error(),
        this.companiesResource.error(),
        this.placesResource.error(),
        this.categoriesResource.error(),
        this.templatesResource.error(),
        this.placeSeriesResource.error(),
        this.seriesResource.error(),
      ].some((error) => error !== undefined),
  );

  // Saving.
  /** Message of the last failed save that does not belong to a field. */
  readonly failure = signal<string | null>(null);
  /** Whether the last save failed because the place changed meanwhile (`412`). */
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
  edit<S extends PlaceSection>(section: S, change: (value: PlaceModel[S]) => PlaceModel[S]): void {
    this.model.update((model) => ({ ...model, [section]: change(model[section]) }));
  }

  /** Reads the place again and drops every draft (after a `412`, or on request). */
  reload(): void {
    this.failure.set(null);
    this.stale.set(false);
    this.resource.reload();
  }

  /**
   * Saves one section, or every section with changes. Validates what it saves (the fields of the
   * section, or the whole form) and moves the focus to the first error.
   *
   * @param scope A section or `all`.
   * @returns Whether the save succeeded.
   */
  async save(scope: SaveScope): Promise<boolean> {
    const target = scope === 'all' ? this.form : (this.form[scope] as FieldTree<unknown>);
    this.saving.set(true);
    try {
      return await submit(target as FieldTree<unknown>, {
        action: () => this.send(scope),
        onInvalid: () => void this.reveal(scope),
      });
    } finally {
      this.saving.set(false);
    }
  }

  private async send(scope: SaveScope): Promise<TreeValidationResult> {
    this.failure.set(null);
    this.stale.set(false);
    const created = this.isNew();
    const sections: ReadonlySet<PlaceSection> = created
      ? new Set(PLACE_SECTIONS.map((section) => section.id))
      : scope === 'all'
        ? this.dirty()
        : new Set([scope]);
    let result: VersionedPlace;
    try {
      result = await this.request(scope, sections);
    } catch (error) {
      return this.reject(error);
    }
    const companyChanged = result.place.companyId !== (this.place()?.companyId ?? null);
    this.saved.set(result);
    if (companyChanged) {
      this.placeSeriesResource.reload();
    }
    this.model.update((model) => withSections(model, result.place, sections));
    for (const id of sections) {
      (this.form[id] as FieldTree<unknown>)().reset();
    }
    this.toast.success(this.i18n.t(created ? 'PLACES.CREATED' : 'PLACES.SAVED'));
    if (created) {
      this.createKey.reset();
      await this.router.navigate(placeRoute(result.place.groupId, result.place.id));
    }
    return undefined;
  }

  private request(scope: SaveScope, sections: ReadonlySet<PlaceSection>): Promise<VersionedPlace> {
    const groupId = this.groupId();
    const model = this.model();
    if (this.isNew()) {
      const body = createBody(model, this.privileged());
      return this.api.create(groupId, body, this.createKey.forBody(body));
    }
    const current = this.saved() as VersionedPlace;
    const placeId = current.place.id;
    if (scope !== 'all' && scope !== 'general') {
      return this.api.replace(
        groupId,
        placeId,
        scope,
        blockBody(model, scope, current.place),
        current.etag,
        current.place,
      );
    }
    return this.api.patch(
      groupId,
      placeId,
      patchBody(model, this.baseline(), sections, current.place),
      current.etag,
      current.place,
    );
  }

  private reject(error: unknown): TreeValidationResult {
    if (isStale(error)) {
      this.stale.set(true);
      this.failure.set(this.i18n.t('PLACES.CONFLICT'));
      return undefined;
    }
    if (!hasFieldDetails(error)) {
      this.failure.set(failureMessage(this.i18n, error));
      return undefined;
    }
    const fields: Record<string, ReadonlyFieldTree<unknown>> = {};
    for (const { field } of error.details) {
      const tree = resolvePlaceField(this.form, field);
      if (tree !== undefined) {
        fields[field] = tree;
      }
    }
    const mapped = serverFieldErrors(this.i18n, error, fields);
    if (error.code === 'FORBIDDEN') {
      this.failure.set(this.i18n.t('PLACES.NOT_ALLOWED'));
    } else if (mapped.unmatched) {
      this.failure.set(failureMessage(this.i18n, error));
    }
    return mapped.errors;
  }

  /** Opens the first tab that has an error and moves the focus to its first invalid field. */
  private async reveal(scope: SaveScope): Promise<void> {
    const id =
      scope === 'all'
        ? (PLACE_SECTIONS.find((candidate) => this.errorCounts()[candidate.id] > 0) as Section).id
        : scope;
    const section = PLACE_SECTIONS.find((candidate) => candidate.id === id) as Section;
    if (!this.isNew()) {
      const base = placeRoute(this.groupId(), this.placeId() as string);
      await this.router.navigate([...base, section.path].filter((segment) => segment !== ''));
    }
    afterNextRender(() => focusFirstError(this.form[section.id] as FieldTree<unknown>), {
      injector: this.injector,
    });
  }
}
