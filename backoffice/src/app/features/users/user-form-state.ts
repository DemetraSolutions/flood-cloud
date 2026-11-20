import { httpResource } from '@angular/common/http';
import {
  computed,
  effect,
  inject,
  linkedSignal,
  resource,
  Service,
  Signal,
  signal,
} from '@angular/core';
import {
  apply,
  disabled,
  email,
  FieldTree,
  form,
  hidden,
  maxLength,
  pattern,
  required,
  validate,
} from '@angular/forms/signals';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { apiErrorMessageKey } from '../../core/api/api-error';
import { GroupFeatures } from '../../core/groups/group-features';
import { I18nService } from '../../core/i18n/i18n.service';
import { SUPPORTED_LANGUAGES } from '../../core/i18n/language';
import { ReferenceApi, ReferenceItem } from '../../core/reference/reference-api';
import { ReferenceStore } from '../../core/reference/reference-store';
import { SessionService } from '../../core/session/session.service';
import { Role } from '../../core/session/session.types';
import {
  AUTOMATIC_CASH,
  AUTOMATIC_CASH_DEVICES,
  AutomaticCashDevice,
  PosFlag,
  POS_FLAGS,
  POS_GRANTS_ON_BY_DEFAULT,
} from '../../core/users/pos.catalog';
import { PIN_PATTERN } from '../../core/users/pin';
import { initialsOf } from '../../shared/ui/avatar/avatar';
import { fieldErrorMessage } from '../../shared/forms/form-errors';
import { apiErrorOf } from '../profile/sessions';
import { PriceList } from '../groups/catalogs/catalog.types';
import { shiftTimeSchema } from './shift-time-schema';
import { hasGroupDuties, toUserFormModel } from './user-model';
import { percentIssue } from './percent';
import { buildPatch, WriteScope } from './user-payload';
import {
  assignableRoles,
  canGrantFlag,
  PERMISSION_MODULES,
  PermissionModule,
  scopeKindOf,
  UserArea,
  UserRecord,
} from './user.types';
import { UsersApi } from './users-api';

/** Username rule of the backend: ASCII, 3-64 characters among letters, digits and `. _ @ + -`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._@+-]{3,64}$/;
const PHONE_PATTERN = /^[0-9 +\-()]*$/;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const MAX_SERVICES = 200;

/** A product favorites list of the group, as the form needs it. */
export interface FavoritesRef {
  readonly id: string;
  readonly name: string;
}

/**
 * State shared by the sections of the user form: the user, the form model and its rules, what
 * the signed-in user may do and which sections apply. It is provided by the form page (not in
 * the root), so each opened user has its own; the page attaches the route parameters.
 *
 * What the client enforces is an aid: the server decides on every write.
 */
@Service({ autoProvided: false })
export class UserFormState {
  private readonly api = inject(UsersApi);
  private readonly reference = inject(ReferenceApi);
  private readonly store = inject(ReferenceStore);
  private readonly session = inject(SessionService);
  private readonly features = inject(GroupFeatures);
  readonly i18n = inject(I18nService);

  private readonly source = signal<{
    groupId: Signal<string | undefined>;
    userId: Signal<string | undefined>;
  } | null>(null);

  /** Binds the state to the route parameters of the page (called once by the page). */
  attach(groupId: Signal<string | undefined>, userId: Signal<string | undefined>): void {
    this.source.set({ groupId, userId });
  }

  readonly groupId = computed(() => this.source()?.groupId());
  readonly userId = computed(() => this.source()?.userId());
  readonly area = computed<UserArea>(() => {
    const groupId = this.groupId();
    return groupId === undefined ? { kind: 'platform' } : { kind: 'group', groupId };
  });
  readonly isNew = computed(() => this.userId() === undefined);

  // The stored user.
  private readonly userResource = httpResource<ApiData<UserRecord>>(() => {
    const userId = this.userId();
    return userId === undefined ? undefined : this.api.userUrl(this.area(), userId);
  });
  private readonly saved = linkedSignal<ApiData<UserRecord> | undefined, UserRecord | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.userResource.hasValue() ? this.userResource.value() : undefined),
    computation: (value) => value?.data ?? null,
  });
  /** The stored user; `null` while loading, on error and when creating. */
  readonly user = this.saved.asReadonly();
  readonly failed = computed(() => this.userResource.error() !== undefined);
  readonly loadError = computed(() => apiErrorOf(this.userResource.error()));
  readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  readonly loading = computed(() => !this.isNew() && this.userResource.isLoading());

  /** Reads the user again. */
  reload(): void {
    this.userResource.reload();
  }

  /** Takes a user returned by the server as the stored one (the form shows its values). */
  apply(user: UserRecord): void {
    this.saved.set(user);
  }

  /** Whether the stored user has a PIN; set by the PIN actions without touching the form. */
  readonly pinSet = linkedSignal(() => this.user()?.pinSet ?? false);

  // Who is acting.
  readonly actorRole = computed(() => this.session.me()?.role as Role);
  readonly isSelf = computed(() => this.user()?.id === this.session.me()?.id);
  readonly canWrite = computed(
    () => this.session.can(this.isNew() ? 'users:create' : 'users:update') && !this.isSelf(),
  );
  readonly canManagePermissions = computed(() => this.session.me()?.canManagePermissions === true);
  private readonly actorPos = computed(() => this.session.me()?.pos ?? null);
  /** PSA, D and SA give any POS permission; CA and PA only what they hold. */
  private readonly posFree = computed(() => ['PSA', 'D', 'SA'].includes(this.actorRole()));
  /** Highest discount a limited actor may give (`null` when not limited or without a cap). */
  readonly discountCap = computed(() =>
    this.posFree() ? null : (this.actorPos()?.grants.discountMaxPercentage ?? null),
  );

  readonly canReadCompanies = computed(() => this.session.can('companies:read'));

  readonly roles = computed(() => {
    const roles = assignableRoles(this.actorRole(), this.area());
    const current = this.user()?.role;
    return current !== undefined && !roles.includes(current) ? [current, ...roles] : roles;
  });
  readonly roleOptions = computed(() =>
    this.roles().map((role) => ({ value: role, label: this.i18n.t(`ROLE.${role}`) })),
  );
  readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('USERS.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('USERS.STATUS.DISABLED') },
  ]);
  readonly languages = SUPPORTED_LANGUAGES.map((language) => ({
    value: language,
    label: this.i18n.t(`LANGUAGE.NAME.${language.toUpperCase()}`),
  }));

  // The form.
  readonly model = linkedSignal(() => toUserFormModel(this.user(), this.roles()[0] ?? ''));
  /** Form model of the stored user (blank when creating): the baseline of every comparison. */
  readonly baseline = computed(() => toUserFormModel(this.user(), ''));
  readonly role = computed(() => this.model().role as Role);
  readonly scopeKind = computed(() => scopeKindOf(this.role()));

  /** PSA and D have every permission, always: their matrix is shown, never edited. */
  readonly fixedPermissions = computed(() => this.role() === 'PSA' || this.role() === 'D');
  readonly matrixEditable = computed(
    () =>
      this.canWrite() && this.canManagePermissions() && !this.fixedPermissions() && !this.isNew(),
  );

  // Sections that depend on the group.
  readonly servicesApply = computed(() => {
    const groupId = this.groupId();
    return (
      groupId !== undefined &&
      this.features.enabledFor(groupId, 'services') &&
      hasGroupDuties(this.role())
    );
  });
  readonly posApplies = computed(() => {
    const groupId = this.groupId();
    return (
      groupId !== undefined &&
      this.features.enabledFor(groupId, 'cash') &&
      hasGroupDuties(this.role())
    );
  });
  /** Whether the group of the user has the rooms feature (the handheld app and the room options). */
  readonly roomsApply = computed(() => {
    const groupId = this.groupId();
    return groupId !== undefined && this.features.enabledFor(groupId, 'rooms');
  });
  readonly posGrantsEditable = computed(
    () => this.posApplies() && this.canWrite() && this.canManagePermissions() && !this.isNew(),
  );
  readonly posOptionsEditable = computed(
    () => this.posApplies() && this.canWrite() && !this.isNew(),
  );

  /** Sections of the form, in order. */
  readonly sections = computed(() => [
    'profile',
    'access',
    'scope',
    'permissions',
    ...(this.posApplies() ? ['pos'] : []),
    'shifts',
  ]);

  /** What the actor can write, for the request bodies. */
  readonly writeScope = computed<WriteScope>(() => ({
    matrix: this.matrixEditable(),
    pos: this.posApplies(),
    posPermissions: this.posGrantsEditable(),
    services: this.servicesApply(),
  }));

  /** Whether the actor may give a POS permission (an aid): see {@link UserFormState}. */
  canGiveFlag(flag: PosFlag): boolean {
    if (this.posFree() || this.baseline().pos.grants[flag]) {
      return true;
    }
    // What the actor holds; the two app switches are on for an actor who has no value stored.
    const held = this.actorPos()?.grants[flag];
    return POS_GRANTS_ON_BY_DEFAULT.includes(flag) ? held !== false : held === true;
  }

  /** Whether the actor may give a flag of an automatic cash device (an aid). */
  canGiveAutomatic(device: AutomaticCashDevice, key: string): boolean {
    const stored = (this.baseline().pos.grants.automaticCash[device] as Record<string, boolean>)[
      key
    ];
    const held = (
      this.actorPos()?.grants.automaticCash[device] as Record<string, boolean> | undefined
    )?.[key];
    return this.posFree() || stored || held === true;
  }

  /** Whether the actor may switch the POS on (an aid). */
  canEnablePos(): boolean {
    return this.posFree() || this.baseline().pos.enabled || this.actorPos()?.enabled === true;
  }

  /** Whether the actor may give a flag of a module of the matrix (an aid). */
  canGiveModule(module: PermissionModule, flag: 'r' | 'w'): boolean {
    return (
      this.baseline().permissions.modules[module][flag] ||
      canGrantFlag(this.actorRole(), (permission) => this.session.can(permission), module, flag)
    );
  }

  readonly userForm = form(this.model, (path) => {
    required(path.username);
    pattern(path.username, USERNAME_PATTERN);
    hidden(path.password, () => !this.isNew());
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
    hidden(path.pin, () => !this.isNew());
    validate(path.pin, ({ value }) =>
      value() === '' || PIN_PATTERN.test(value()) ? undefined : { kind: 'pattern' },
    );
    required(path.role);
    maxLength(path.firstName, 100);
    maxLength(path.lastName, 100);
    maxLength(path.email, 254);
    email(path.email);
    maxLength(path.phone, 32);
    pattern(path.phone, PHONE_PATTERN);
    maxLength(path.description, 1000);
    hidden(path.companyIds, ({ valueOf }) => valueOf(path.role) !== 'CA');
    validate(path.companyIds, ({ value }) =>
      value().length === 0 ? { kind: 'required' } : undefined,
    );
    hidden(path.placeIds, ({ valueOf }) => scopeKindOf(valueOf(path.role) as Role) !== 'places');
    validate(path.placeIds, ({ value }) =>
      value().length === 0 ? { kind: 'required' } : undefined,
    );
    validate(path.serviceIds, ({ value }) =>
      value().length > MAX_SERVICES ? { kind: 'tooMany' } : undefined,
    );

    // POS data.
    validate(path.pos.grants.discountMaxPercentage, ({ value }) => {
      const issue = percentIssue(value());
      if (issue !== undefined) {
        return issue;
      }
      const cap = this.discountCap();
      const changed = value() !== this.baseline().pos.grants.discountMaxPercentage;
      return cap !== null && changed && (value().trim() === '' || Number(value()) > cap)
        ? { kind: 'notAllowed' }
        : undefined;
    });
    validate(path.pos.grants.servicePercentage, ({ value }) => percentIssue(value()));
    validate(path.pos.options.quickDiscount, ({ value }) => percentIssue(value()));

    // Shifts.
    apply(path.shiftTime, shiftTimeSchema);

    // Who can edit what.
    disabled(path, () => !this.canWrite());
    disabled(path.permissions, () => !this.matrixEditable());
    for (const module of PERMISSION_MODULES) {
      for (const flag of ['r', 'w'] as const) {
        disabled(path.permissions.modules[module][flag], () => !this.canGiveModule(module, flag));
      }
    }
    disabled(path.pos.options, () => !this.posOptionsEditable());
    disabled(path.pos.enabled, () => !this.posGrantsEditable() || !this.canEnablePos());
    disabled(path.pos.grants, () => !this.posGrantsEditable());
    for (const flag of POS_FLAGS) {
      disabled(path.pos.grants[flag], () => !this.canGiveFlag(flag));
    }
    for (const device of AUTOMATIC_CASH_DEVICES) {
      for (const key of AUTOMATIC_CASH[device]) {
        disabled(
          (
            path.pos.grants.automaticCash[device] as unknown as Record<
              string,
              typeof path.pos.enabled
            >
          )[key],
          () => !this.canGiveAutomatic(device, key),
        );
      }
    }
  });

  // The request.
  readonly patch = computed(() => buildPatch(this.model(), this.user(), this.writeScope()));
  readonly hasChanges = computed(() => this.isNew() || Object.keys(this.patch()).length > 0);

  // Groups data the POS section needs.
  readonly canReadFavorites = computed(() => this.session.can('products:read'));
  private readonly priceListsResource = resource({
    params: () => {
      const groupId = this.groupId();
      return this.user() !== null && this.posApplies() && groupId !== undefined
        ? groupId
        : undefined;
    },
    loader: ({ params }) => this.store.page<PriceList>(params, 'price-lists'),
  });
  private readonly favoritesResource = httpResource<ApiData<FavoritesRef[]>>(() => {
    const groupId = this.groupId();
    return this.user() !== null &&
      this.posApplies() &&
      this.canReadFavorites() &&
      groupId !== undefined
      ? `/v1/groups/${encodeURIComponent(groupId)}/product-favorites`
      : undefined;
  });
  /** Price lists of the group; empty until read (or when the actor cannot read them). */
  readonly priceLists = computed(() =>
    this.priceListsResource.hasValue() ? this.priceListsResource.value().data : [],
  );
  readonly priceListsLoading = this.priceListsResource.isLoading;
  readonly priceListsFailed = computed(() => this.priceListsResource.error() !== undefined);
  /** Favorites lists of the group; `null` when the actor cannot read them or they are not read yet. */
  readonly favorites = computed<readonly FavoritesRef[] | null>(() =>
    this.favoritesResource.hasValue() ? this.favoritesResource.value().data : null,
  );

  reloadPriceLists(): void {
    this.priceListsResource.reload();
  }

  // Names of the selected services (the services read has no `ids` filter).
  readonly serviceLabels = signal<Readonly<Record<string, string>>>({});

  constructor() {
    effect(() => {
      const groupId = this.groupId();
      const ids = this.user()?.serviceIds ?? [];
      if (groupId !== undefined && this.servicesApply() && ids.length > 0) {
        void this.resolveServiceNames(groupId, ids);
      }
    });
  }

  private async resolveServiceNames(groupId: string, ids: readonly string[]): Promise<void> {
    try {
      const names = await this.reference.serviceNames(groupId, ids);
      this.serviceLabels.update((labels) => ({ ...labels, ...names }));
    } catch (error) {
      // The names only decorate the selection: the selected services stay selected.
      console.warn('Cannot read the names of the services', error);
    }
  }

  /** A page of the services of the group, for the picker. */
  readonly serviceLoader = computed(() => {
    const groupId = this.groupId() as string;
    return (query: { q: string; cursor: string | null }): Promise<ApiPage<ReferenceItem>> =>
      this.reference.services(groupId, query);
  });

  /** Message of a field, or `null` (server errors always, client errors once touched). */
  error(field: FieldTree<unknown>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  /** Initials for the avatar preview. */
  readonly initials = computed(() => initialsOf(this.model()));
}
