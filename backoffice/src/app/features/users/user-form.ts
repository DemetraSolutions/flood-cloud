import { httpResource } from '@angular/common/http';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import {
  disabled,
  email,
  FieldTree,
  form,
  FormField,
  hidden,
  maxLength,
  pattern,
  required,
  submit,
  TreeValidationResult,
  validate,
} from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { ApiData, ApiPage } from '../../core/api/api.types';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { Can } from '../../core/auth/can';
import { GroupContext } from '../../core/groups/group-context';
import { I18nService } from '../../core/i18n/i18n.service';
import { SUPPORTED_LANGUAGES } from '../../core/i18n/language';
import { TPipe } from '../../core/i18n/t-pipe';
import { ReferenceApi, ReferenceItem } from '../../core/reference/reference-api';
import { SessionService } from '../../core/session/session.service';
import { Role } from '../../core/session/session.types';
import {
  fieldErrorMessage,
  focusFirstError,
  serverFieldErrors,
} from '../../shared/forms/form-errors';
import { Button } from '../../shared/ui/button/button';
import { Checkbox } from '../../shared/ui/checkbox/checkbox';
import { ErrorState } from '../../shared/ui/error-state/error-state';
import { FormError } from '../../shared/ui/form-error/form-error';
import { Select } from '../../shared/ui/select/select';
import { StatusBadge } from '../../shared/ui/status-badge/status-badge';
import { TextField } from '../../shared/ui/text-field/text-field';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { createDebouncer } from '../../shared/util/debouncer';
import { apiErrorOf } from '../profile/sessions';
import { PasswordGenerator } from './password-generator';
import { ReferenceLoader, ReferencePicker } from './reference-picker';
import {
  areaOf,
  assignableRoles,
  emptyMatrix,
  inheritedMatrix,
  matrixOf,
  PERMISSION_MODULES,
  PermissionMatrix,
  PermissionsPatch,
  scopeKindOf,
  UserArea,
  UserCreate,
  UserRecord,
  UserStatus,
  UserWrite,
} from './user.types';
import { UserAction, UserActions } from './user-actions';
import { UsersApi } from './users-api';
import { userFailureMessage } from './users-errors';

/** Username rule of the backend: ASCII, 3-64 characters among letters, digits and `. _ @ + -`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9._@+-]{3,64}$/;
const PHONE_PATTERN = /^[0-9 +\-()]*$/;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const TEXT_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;

/** Values of the user form (text fields are `''` when empty). */
export interface UserFormModel {
  username: string;
  password: string;
  role: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  language: string;
  status: string;
  companyIds: string[];
  placeIds: string[];
  permissions: PermissionMatrix;
}

/**
 * Initial form values: those of the stored user, or the defaults for a new one.
 *
 * @param user The user being edited, or `null` for a new one.
 * @param role Role proposed for a new user.
 */
export function toUserFormModel(user: UserRecord | null, role: string): UserFormModel {
  return {
    username: user?.username ?? '',
    password: '',
    role: user?.role ?? role,
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    phone: user?.phone ?? '',
    language: user?.language ?? 'it',
    status: user?.status ?? 'active',
    companyIds: [...(user?.companyIds ?? [])],
    placeIds: [...(user?.placeIds ?? [])],
    permissions: user === null ? emptyMatrix() : matrixOf(user),
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function textOrNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

/** Perimeter fields of a body for a role (empty object for roles without perimeter). */
function scopeOf(model: UserFormModel): Pick<UserWrite, 'companyIds' | 'placeIds'> {
  switch (scopeKindOf(model.role as Role)) {
    case 'companies':
      return { companyIds: model.companyIds };
    case 'places':
      return { placeIds: model.placeIds };
    case 'none':
      return {};
  }
}

/** Whole matrix as a request body. */
function fullMatrix(matrix: PermissionMatrix): PermissionsPatch {
  return {
    modules: Object.fromEntries(
      PERMISSION_MODULES.map((module) => [module, { ...matrix.modules[module] }]),
    ),
    canManagePermissions: matrix.canManagePermissions,
  };
}

/**
 * Body of the creation. The matrix is sent only when `matrix` is given (an actor who manages
 * permissions chose a custom one); otherwise the server applies the defaults of the role.
 */
export function buildCreateBody(model: UserFormModel, matrix: PermissionMatrix | null): UserCreate {
  const body: UserCreate = {
    username: model.username.trim(),
    password: model.password,
    role: model.role as Role,
    language: model.language,
    status: model.status as UserStatus,
    ...scopeOf(model),
  };
  for (const field of TEXT_FIELDS) {
    const value = textOrNull(model[field]);
    if (value !== null) {
      body[field] = value;
    }
  }
  if (matrix !== null) {
    body.permissions = fullMatrix(matrix);
  }
  return body;
}

/**
 * Body of the modification: only what differs from the stored user (an emptied text field
 * becomes `null`). When the role changes the perimeter of the new role is always sent. The
 * matrix is compared only when `includeMatrix` is true (the actor may change it).
 */
export function buildPatch(
  model: UserFormModel,
  user: UserRecord | null,
  includeMatrix: boolean,
): UserWrite {
  const patch: UserWrite = {};
  if (user === null) {
    return patch;
  }
  if (model.username.trim() !== user.username) {
    patch.username = model.username.trim();
  }
  for (const field of TEXT_FIELDS) {
    const value = textOrNull(model[field]);
    if (value !== user[field]) {
      patch[field] = value;
    }
  }
  if (model.language !== user.language) {
    patch.language = model.language;
  }
  if (model.status !== user.status) {
    patch.status = model.status as UserStatus;
  }
  const roleChanged = model.role !== user.role;
  if (roleChanged) {
    patch.role = model.role as Role;
  }
  const scope = scopeOf(model);
  if (
    scope.companyIds !== undefined &&
    (roleChanged || !sameIds(scope.companyIds, user.companyIds))
  ) {
    patch.companyIds = scope.companyIds;
  }
  if (scope.placeIds !== undefined && (roleChanged || !sameIds(scope.placeIds, user.placeIds))) {
    patch.placeIds = scope.placeIds;
  }
  if (includeMatrix) {
    const permissions = diffMatrix(model.permissions, matrixOf(user));
    if (permissions !== null) {
      patch.permissions = permissions;
    }
  }
  return patch;
}

function diffMatrix(next: PermissionMatrix, current: PermissionMatrix): PermissionsPatch | null {
  const patch: PermissionsPatch = {};
  for (const module of PERMISSION_MODULES) {
    if (next.modules[module].r !== current.modules[module].r) {
      patch.modules = {
        ...patch.modules,
        [module]: { ...patch.modules?.[module], r: next.modules[module].r },
      };
    }
    if (next.modules[module].w !== current.modules[module].w) {
      patch.modules = {
        ...patch.modules,
        [module]: { ...patch.modules?.[module], w: next.modules[module].w },
      };
    }
  }
  if (next.canManagePermissions !== current.canManagePermissions) {
    patch.canManagePermissions = next.canManagePermissions;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Returns the error with the details of list items (`placeIds.3`) attributed to the list. */
export function collapseIndexes(error: ApiError): ApiError {
  return new ApiError({
    status: error.status,
    code: error.code as ApiError['code'],
    message: error.message,
    requestId: error.requestId,
    details: error.details.map((detail) => ({
      field: detail.field.replace(/\.\d+$/, ''),
      issue: detail.issue,
    })),
  });
}

/** State of the username availability check. */
export type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'error';

/**
 * Create and edit page of a user (`.../users/new`, `.../users/:userId`), for the users of a
 * group and for the platform users. The form is a Signal Form; the roles offered depend on who
 * is editing, the perimeter is chosen among the real companies and stores of the group, the
 * username is checked for availability, and the permission matrix can be changed only by users
 * who may manage permissions. Server `422`/`409` errors land on the fields.
 */
@Component({
  selector: 'fc-user-form',
  imports: [
    Button,
    Can,
    Checkbox,
    ErrorState,
    FormError,
    FormField,
    PasswordGenerator,
    ReferencePicker,
    RouterLink,
    Select,
    StatusBadge,
    TextField,
    TPipe,
    UserActions,
  ],
  templateUrl: './user-form.html',
  styleUrl: './user-form.css',
})
export class UserForm {
  private readonly api = inject(UsersApi);
  private readonly reference = inject(ReferenceApi);
  private readonly session = inject(SessionService);
  private readonly groups = inject(GroupContext);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly availabilityDebouncer = createDebouncer();
  protected readonly i18n = inject(I18nService);

  /** Route parameters; the group is absent in the platform area, the user when creating. */
  readonly groupId = input<string>();
  readonly userId = input<string>();

  protected readonly area = computed<UserArea>(() => {
    const groupId = this.groupId();
    return groupId === undefined ? { kind: 'platform' } : { kind: 'group', groupId };
  });
  protected readonly isNew = computed(() => this.userId() === undefined);
  protected readonly modules = PERMISSION_MODULES;
  protected readonly listRoute = computed(() =>
    this.area().kind === 'platform' ? ['/platform', 'users'] : ['/groups', this.groupId(), 'users'],
  );

  private readonly userResource = httpResource<ApiData<UserRecord>>(() => {
    const userId = this.userId();
    return userId === undefined ? undefined : `${this.api.userUrl(this.area(), userId)}`;
  });
  private readonly saved = linkedSignal<ApiData<UserRecord> | undefined, UserRecord | null>({
    // `value()` throws while the resource is in error: read it only when there is one.
    source: () => (this.userResource.hasValue() ? this.userResource.value() : undefined),
    computation: (value) => value?.data ?? null,
  });
  protected readonly user = this.saved.asReadonly();
  protected readonly failed = computed(() => this.userResource.error() !== undefined);
  protected readonly loadError = computed(() => apiErrorOf(this.userResource.error()));
  protected readonly loadErrorMessage = computed(() => {
    const error = this.loadError();
    return this.i18n.t(error === null ? 'ERRORS.GENERIC.MESSAGE' : apiErrorMessageKey(error));
  });
  protected readonly loading = computed(() => !this.isNew() && this.userResource.isLoading());

  private readonly actorRole = computed(() => this.session.me()?.role as Role);
  protected readonly isSelf = computed(() => this.user()?.id === this.session.me()?.id);
  protected readonly canWrite = computed(
    () => this.session.can(this.isNew() ? 'users:create' : 'users:update') && !this.isSelf(),
  );
  private readonly roles = computed(() => {
    const roles = assignableRoles(this.actorRole(), this.area());
    const current = this.user()?.role;
    return current !== undefined && !roles.includes(current) ? [current, ...roles] : roles;
  });
  protected readonly roleOptions = computed(() =>
    this.roles().map((role) => ({ value: role, label: this.i18n.t(`ROLE.${role}`) })),
  );
  protected readonly statusOptions = computed(() => [
    { value: 'active', label: this.i18n.t('USERS.STATUS.ACTIVE') },
    { value: 'disabled', label: this.i18n.t('USERS.STATUS.DISABLED') },
  ]);
  protected readonly languages = SUPPORTED_LANGUAGES.map((language) => ({
    value: language,
    label: this.i18n.t(`LANGUAGE.NAME.${language.toUpperCase()}`),
  }));

  /** In creation: apply the default permissions of the role instead of a custom matrix. */
  protected readonly useDefaultPermissions = signal(true);
  protected readonly canManagePermissions = computed(
    () => this.session.me()?.canManagePermissions === true,
  );
  protected readonly matrixEditable = computed(
    () =>
      this.canWrite() &&
      this.canManagePermissions() &&
      (!this.isNew() || !this.useDefaultPermissions()),
  );

  protected readonly model = linkedSignal(() =>
    toUserFormModel(this.user(), this.roles()[0] ?? ''),
  );
  protected readonly userForm = form(this.model, (path) => {
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
    required(path.role);
    maxLength(path.firstName, 100);
    maxLength(path.lastName, 100);
    maxLength(path.email, 254);
    email(path.email);
    maxLength(path.phone, 32);
    pattern(path.phone, PHONE_PATTERN);
    hidden(path.companyIds, ({ valueOf }) => valueOf(path.role) !== 'CA');
    validate(path.companyIds, ({ value }) =>
      value().length === 0 ? { kind: 'required' } : undefined,
    );
    hidden(path.placeIds, ({ valueOf }) => scopeKindOf(valueOf(path.role) as Role) !== 'places');
    validate(path.placeIds, ({ value }) =>
      value().length === 0 ? { kind: 'required' } : undefined,
    );
    disabled(path, () => !this.canWrite());
    disabled(path.permissions, () => !this.matrixEditable());
  });

  protected readonly scopeKind = computed(() => scopeKindOf(this.model().role as Role));
  protected readonly patch = computed(() =>
    buildPatch(this.model(), this.user(), this.matrixEditable()),
  );
  protected readonly hasChanges = computed(
    () => this.isNew() || Object.keys(this.patch()).length > 0,
  );
  protected readonly failure = signal<string | null>(null);
  protected readonly submitting = computed(() => this.userForm().submitting());

  // Perimeter pickers: only companies/stores of the group, filtered by company for stores.
  protected readonly showCompanyFilter = computed(
    () => this.groupId() !== undefined && this.session.can('companies:read'),
  );
  protected readonly companyFilter = signal('');
  private readonly companiesResource = httpResource<ApiPage<ReferenceItem>>(() =>
    this.showCompanyFilter() && this.scopeKind() === 'places'
      ? {
          url: `/v1/groups/${encodeURIComponent(this.groupId() as string)}/companies`,
          params: { limit: 200 },
        }
      : undefined,
  );
  protected readonly companyOptions = computed(() =>
    (this.companiesResource.hasValue() ? this.companiesResource.value().data : []).map(
      (company) => ({
        value: company.id,
        label: company.name,
      }),
    ),
  );
  protected readonly companyLoader = computed<ReferenceLoader>(
    () => (query) => this.reference.companies(this.groupId() as string, query),
  );
  protected readonly placeLoader = computed<ReferenceLoader>(() => {
    const companyId = this.companyFilter();
    return (query) =>
      this.reference.places(this.groupId() as string, {
        ...query,
        companyId: companyId === '' ? undefined : companyId,
      });
  });

  // Username availability.
  private readonly roleValue = computed(() => this.model().role);
  private readonly usernameValue = computed(() => this.model().username.trim());
  private readonly needsCheck = computed(() => {
    const username = this.usernameValue();
    return (
      this.canWrite() &&
      USERNAME_PATTERN.test(username) &&
      (this.isNew() || username !== this.user()?.username)
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
    return state === 'idle' ? null : this.i18n.t(`USERS.FORM.USERNAME_${state.toUpperCase()}`);
  });

  constructor() {
    // The page loaded: the group in the URL becomes the working group of the selector.
    effect(() => {
      const groupId = this.groupId();
      if (groupId !== undefined && this.user() !== null) {
        untracked(() => this.groups.adopt(groupId));
      }
    });
    // While the defaults of the role apply, the matrix shows them (limited to what the actor holds).
    effect(() => {
      const role = this.roleValue();
      if (this.isNew() && !this.matrixEditable()) {
        const permissions = inheritedMatrix(role as Role, (permission) =>
          this.session.can(permission),
        );
        untracked(() => this.model.update((model) => ({ ...model, permissions })));
      }
    });
    effect(() => {
      const username = this.usernameValue();
      if (this.needsCheck()) {
        this.availabilityDebouncer.schedule(() => void this.checkUsername(username));
      } else {
        this.availabilityDebouncer.cancel();
      }
    });
  }

  protected error(field: FieldTree<string> | FieldTree<string[]>): string | null {
    return fieldErrorMessage(this.i18n, field());
  }

  protected usernameError(): string | null {
    const message = this.error(this.userForm.username);
    return message ?? (this.availability() === 'taken' ? this.i18n.t('FORM.ISSUE.TAKEN') : null);
  }

  protected moduleLabel(module: string): string {
    return this.i18n.t(`USERS.MODULE.${module.toUpperCase()}`);
  }

  protected onGenerated(password: string): void {
    this.userForm.password().value.set(password);
  }

  protected onAction(action: UserAction): void {
    if (action === 'delete') {
      void this.router.navigate(this.listRoute());
    } else {
      this.userResource.reload();
    }
  }

  protected reload(): void {
    this.userResource.reload();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.userForm, {
      action: async () => {
        this.failure.set(null);
        const wasNew = this.isNew();
        try {
          if (wasNew) {
            await this.api.create(
              this.area(),
              buildCreateBody(
                this.model(),
                this.matrixEditable() ? this.model().permissions : null,
              ),
            );
          } else {
            this.saved.set(
              await this.api.update(this.area(), this.userId() as string, this.patch()),
            );
          }
        } catch (error) {
          return this.reject(error);
        }
        this.userForm().reset();
        this.toast.success(this.i18n.t(wasNew ? 'USERS.FORM.CREATED' : 'USERS.FORM.SAVED'));
        if (wasNew && this.groupId() !== undefined) {
          // The backend accepted the creation in this group: it is a real working group.
          this.groups.adopt(this.groupId() as string);
        }
        if (wasNew) {
          await this.router.navigate(this.listRoute());
        }
        return undefined;
      },
      onInvalid: () => focusFirstError(this.userForm),
    });
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

  private reject(error: unknown): TreeValidationResult {
    const fieldsError =
      error instanceof ApiError &&
      (error.code === 'VALIDATION_ERROR' || error.code === 'CONFLICT') &&
      error.details.length > 0;
    if (fieldsError) {
      const form = this.userForm;
      const mapped = serverFieldErrors(this.i18n, collapseIndexes(error), {
        username: form.username,
        password: form.password,
        role: form.role,
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        language: form.language,
        status: form.status,
        companyIds: form.companyIds,
        placeIds: form.placeIds,
      });
      if (mapped.unmatched) {
        this.failure.set(this.i18n.t('ERRORS.API.VALIDATION_ERROR'));
      }
      return mapped.errors;
    }
    this.failure.set(userFailureMessage(this.i18n, error));
    return undefined;
  }
}
