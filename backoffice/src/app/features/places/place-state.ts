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
  validate,
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
import { FIELDS, FieldDef, isVisible } from './place-fields';
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
import {
  PLACE_TABS,
  PlaceTabId,
  SETTINGS_ENTRIES,
  SettingsEntry,
  sectionLocation,
  tabSections,
} from './place-nav';
import { PlacesApi, VersionedPlace } from './places-api';
import {
  PLACE_SECTIONS,
  PlaceRecord,
  PlaceSection,
  placeRoute,
  PLANS,
  DEALER_PLANS,
} from './place.types';

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
  | 'series'
  | 'taxes'
  | 'users'
  | 'favorites';

/**
 * State of the place page, shared by its tabs and settings entries (child routes): the place as
 * the server has it with its version (`ETag`), the whole form (one Signal Form with a property
 * per section, so switching tabs loses nothing), what each tab and each entry of the settings
 * menu has changed, the lookups they need and the one save.
 *
 * As in the legacy backoffice there is one "Salva": it sends the unique `PATCH` with every section
 * that changed, presenting the version in `If-Match`, and puts back only what it wrote. `422`,
 * `409` and `403` errors with details land on the fields, whichever tab or entry they are in, and
 * the tab and the entry are marked. What the user may change comes from the role, as the server
 * decides it: the plan (platform administrators; dealers choose it only when creating), the
 * expiration date, the status and the integration switches (platform administrators and dealers),
 * Sentry (platform administrators).
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
  readonly hasFeature = (name: FeatureName): boolean =>
    this.features.enabledFor(this.groupId(), name);

  /** Whether a key of a tab is shown: the legacy rules by role and by the features of the group. */
  readonly isShown = (definition: FieldDef): boolean =>
    isVisible(definition, {
      privileged: this.privileged(),
      feature: (name) => this.features.enabledFor(this.groupId(), name),
    });

  /** Whether the store key panel is offered: platform administrators and dealers, on an existing place. */
  readonly hasStoreKey = computed(() => !this.isNew() && this.session.can('storeKeys:read'));

  /** Whether the place has the plan of the secondary tobacco company (its page is only the general tab). */
  private readonly secondary = computed(() => this.place()?.license.plan === 'tgm-secondary');

  /** The top tabs the user sees: the legacy rules by plan, role and by the features of the group. */
  readonly tabs = computed(() => {
    const secondary = this.secondary();
    const privileged = this.privileged();
    return PLACE_TABS.filter((tab) => {
      switch (tab.id) {
        case 'general':
          return true;
        case 'devices':
          return !secondary && (privileged || this.features.enabledFor(this.groupId(), 'cash'));
        case 'printStations':
          return !secondary && (privileged || this.features.enabledFor(this.groupId(), 'ordering'));
        case 'rooms':
          return !secondary && (privileged || this.features.enabledFor(this.groupId(), 'rooms'));
        case 'media':
          return !secondary && (privileged || this.features.enabledFor(this.groupId(), 'media'));
        default:
          return !secondary;
      }
    });
  });

  /** The entries of the side menu of the settings the user sees. */
  readonly entries = computed(() =>
    SETTINGS_ENTRIES.filter(
      (entry) =>
        this.privileged() ||
        (entry.privileged !== true &&
          (entry.needs === undefined || this.features.enabledFor(this.groupId(), entry.needs))),
    ),
  );

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
    applyEach(path.devices.items, (device) => {
      required(device.name);
      maxLength(device.name, 100);
    });
    applyEach(path.printStations.stations, (station) => {
      required(station.name);
      required(station.host);
    });
    applyEach(path.printStations.productionCenters, (center) => required(center.name));
    applyEach(path.rooms.items, (room) => {
      required(room.name);
      applyEach(room.tables, (table) => required(table.name));
    });
    applyEach(path.storages.items, (storage) => required(storage.name));
    for (const list of [path.tables.discountReasons, path.tables.deleteReasons]) {
      applyEach(list, (reason) => {
        required(reason);
        maxLength(reason, 100);
        validate(reason, ({ value }) =>
          value().includes(';') ? { kind: 'semicolon' } : undefined,
        );
      });
    }
    validate(path.integrations.f['multisafepay.terminalGroupId'], ({ value }) =>
      /^[A-Za-z0-9_-]{0,64}$/.test(value() as string) ? undefined : { kind: 'pattern' },
    );
    validate(path.integrations.f['multisafepay.qrSecondsActive'], ({ value }) => {
      const seconds = value() as string;
      if (seconds === '') {
        return undefined;
      }
      return Number(seconds) < 60
        ? { kind: 'minimum' }
        : Number(seconds) > 31_536_000
          ? { kind: 'maximum' }
          : undefined;
    });
    applyEach(path.devices.items, (device) => {
      applyEach(device.multisafepayTerminals, (terminal) => {
        required(terminal.terminalId);
        pattern(terminal.terminalId, /^[A-Za-z0-9_-]{1,64}$/);
        validate(terminal.terminalId, ({ value, valueOf }) =>
          valueOf(device.multisafepayTerminals).filter((other) => other.terminalId === value())
            .length > 1
            ? { kind: 'incorrect' }
            : undefined,
        );
        required(terminal.name);
        maxLength(terminal.name, 100);
      });
    });
    disabled(path, { when: () => !this.canWrite() });
    disabled(path.devices, { when: () => !this.model().devices.editable });
    disabled(path.printStations.stations, {
      when: () => !this.model().printStations.stationsEditable,
    });
    disabled(path.printStations.productionCenters, {
      when: () => !this.model().printStations.productionCentersEditable,
    });
    disabled(path.rooms, { when: () => !this.model().rooms.editable });
    disabled(path.storages, { when: () => !this.model().storages.editable });
    disabled(path.general.companyId, { when: () => !this.canCompany() });
    disabled(path.license.plan, { when: () => !this.canPlan() });
    disabled(path.license.expirationDate, { when: () => !this.canReserved() });
    disabled(path.license.status, { when: () => !this.canReserved() });
    disabled(path.dealerSettings.f['sentry'], { when: () => !this.canSentry() });
    disabled(path.appointments.f['webWidgetStatus'], { when: () => !this.canReserved() });
    for (const definition of FIELDS.integrations.filter((candidate) => candidate.reserved)) {
      disabled(path.integrations.f[definition.key], { when: () => !this.canReserved() });
    }
  });

  /** The errors of a section the user should see: server errors, and client errors once the field was touched. */
  private errorsOf(section: PlaceSection) {
    return (this.form[section] as FieldTree<unknown>)()
      .errorSummary()
      .filter((error) => error.kind === 'server' || error.fieldTree().touched());
  }

  /** Whether an error is on the key of the "other settings" entry (the receipts cancellation). */
  private isCancellation(error: { fieldTree: unknown }): boolean {
    return error.fieldTree === this.form.cashSettings.f['receiptsCancellation'];
  }

  /** Errors of each section. */
  readonly errorCounts = computed<Readonly<Record<PlaceSection, number>>>(
    () =>
      Object.fromEntries(PLACE_SECTIONS.map((id) => [id, this.errorsOf(id).length])) as Record<
        PlaceSection,
        number
      >,
  );

  /** Errors of a top tab: those of its sections. */
  readonly tabErrors = computed<Readonly<Record<PlaceTabId, number>>>(
    () =>
      Object.fromEntries(
        PLACE_TABS.map((tab) => [
          tab.id,
          tabSections(tab.id).reduce((sum, section) => sum + this.errorCounts()[section], 0),
        ]),
      ) as Record<PlaceTabId, number>,
  );

  /** Errors of each entry of the settings menu (the cash settings are split between two entries). */
  readonly entryErrors = computed<Readonly<Record<string, number>>>(() => {
    const cancellation = this.errorsOf('cashSettings').filter((error) =>
      this.isCancellation(error),
    ).length;
    return Object.fromEntries(
      SETTINGS_ENTRIES.map((entry) => {
        const count = this.errorCounts()[entry.section];
        return [
          entry.id,
          entry.scope === 'other'
            ? cancellation
            : entry.scope === 'main'
              ? count - cancellation
              : count,
        ];
      }),
    );
  });

  /** Whether a top tab has unsaved changes. */
  readonly tabDirty = computed<Readonly<Record<PlaceTabId, boolean>>>(
    () =>
      Object.fromEntries(
        PLACE_TABS.map((tab) => [
          tab.id,
          tabSections(tab.id).some((section) => this.dirty().has(section)),
        ]),
      ) as Record<PlaceTabId, boolean>,
  );

  /** Whether each entry of the settings menu has unsaved changes. */
  readonly entryDirty = computed<Readonly<Record<string, boolean>>>(() => {
    const changed = (key: 'model' | 'baseline') =>
      this[key]().cashSettings.f['receiptsCancellation'];
    const cancellation = changed('model') !== changed('baseline');
    return Object.fromEntries(
      SETTINGS_ENTRIES.map((entry) => {
        const dirty = this.dirty().has(entry.section);
        if (entry.section !== 'cashSettings') {
          return [entry.id, dirty];
        }
        return [
          entry.id,
          entry.scope === 'other' ? cancellation : dirty && !this.onlyCancellation(),
        ];
      }),
    );
  });

  /** Whether the only change of the cash settings is the receipts cancellation. */
  private readonly onlyCancellation = computed(() => {
    const strip = (model: PlaceModel) => {
      const { receiptsCancellation, ...rest } = model.cashSettings.f;
      void receiptsCancellation;
      return JSON.stringify({ ...model.cashSettings, f: rest });
    };
    return strip(this.model()) === strip(this.baseline());
  });

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
  private readonly taxesResource = httpResource<
    ApiData<{ id: string; rate: number; description: string | null }[]>
  >(() =>
    this.needs().has('taxes') && this.session.can('groups:read')
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/taxes`
      : undefined,
  );
  private readonly favoritesResource = httpResource<ApiData<{ id: string; name: string }[]>>(() =>
    this.needs().has('favorites') && this.session.can('products:read')
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/product-favorites`
      : undefined,
  );
  private readonly usersResource = httpResource<ApiData<{ id: string; username: string }[]>>(() =>
    this.needs().has('users') && this.session.can('users:read')
      ? `/v1/groups/${encodeURIComponent(this.groupId())}/users?limit=100`
      : undefined,
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
  /** Tax rates of the group (the rooms' service tax); empty when not read. */
  readonly taxes = computed(() =>
    this.taxesResource.hasValue() ? this.taxesResource.value().data : [],
  );
  /** Lists of favorite products of the group; empty when not read. */
  readonly favorites = computed(() =>
    this.favoritesResource.hasValue() ? this.favoritesResource.value().data : [],
  );
  /** Users of the group (the table assignment); empty when not read (the first hundred). */
  readonly users = computed(() =>
    this.usersResource.hasValue() ? this.usersResource.value().data : [],
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
        this.taxesResource.error(),
        this.favoritesResource.error(),
        this.usersResource.error(),
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
   * The unique save: creates the place on the page of a new one, otherwise sends every section
   * with unsaved changes. Validates the whole form and, when it is not valid (or the server
   * refuses fields), opens the tab or the entry with the first error and moves the focus to its
   * first invalid field.
   *
   * @returns Whether the save succeeded.
   */
  async save(): Promise<boolean> {
    this.saving.set(true);
    let revealed = false;
    try {
      const saved = await submit(this.form as FieldTree<unknown>, {
        action: () => this.send(),
        onInvalid: () => {
          revealed = true;
          void this.reveal();
        },
      });
      if (!saved && !revealed) {
        // The server refused fields: show the first one, as for the errors found by the form.
        await this.reveal();
      }
      return saved;
    } finally {
      this.saving.set(false);
    }
  }

  private async send(): Promise<TreeValidationResult> {
    this.failure.set(null);
    this.stale.set(false);
    const created = this.isNew();
    const sections: ReadonlySet<PlaceSection> = created
      ? new Set<PlaceSection>(['general', 'license'])
      : this.dirty();
    let result: VersionedPlace;
    try {
      result = await this.request(sections);
    } catch (error) {
      return this.reject(error);
    }
    const companyChanged = result.place.companyId !== (this.place()?.companyId ?? null);
    this.saved.set(result);
    if (companyChanged) {
      this.placeSeriesResource.reload();
    }
    // A created place is read back whole: what the server defaults is what the form holds.
    const written: ReadonlySet<PlaceSection> = created ? new Set(PLACE_SECTIONS) : sections;
    this.model.update((model) => withSections(model, result.place, written));
    for (const id of written) {
      (this.form[id] as FieldTree<unknown>)().reset();
    }
    this.toast.success(this.i18n.t(created ? 'PLACES.CREATED' : 'PLACES.SAVED'));
    if (created) {
      this.createKey.reset();
      await this.router.navigate(placeRoute(result.place.groupId, result.place.id));
    }
    return undefined;
  }

  private request(sections: ReadonlySet<PlaceSection>): Promise<VersionedPlace> {
    const groupId = this.groupId();
    const model = this.model();
    if (this.isNew()) {
      const body = createBody(model, this.privileged());
      return this.api.create(groupId, body, this.createKey.forBody(body));
    }
    const current = this.saved() as VersionedPlace;
    return this.api.patch(
      groupId,
      current.place.id,
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

  /**
   * Opens the first tab or entry that has an error and moves the focus to its first invalid field.
   * It reads the errors of the form itself: when the save is refused the fields are marked as
   * touched only after this runs, so the counts shown to the user may still be zero.
   */
  private async reveal(): Promise<void> {
    const failing = (id: PlaceSection) => (this.form[id] as FieldTree<unknown>)().errorSummary();
    const section = PLACE_SECTIONS.find(
      (candidate) => failing(candidate).length > 0,
    ) as PlaceSection;
    const other =
      section === 'cashSettings' && failing(section).every((error) => this.isCancellation(error));
    if (!this.isNew()) {
      const base = placeRoute(this.groupId(), this.placeId() as string);
      await this.router.navigate([...base, ...sectionLocation(section, other)]);
    }
    afterNextRender(() => focusFirstError(this.form[section] as FieldTree<unknown>), {
      injector: this.injector,
    });
  }
}
