import { listQueryShape } from '../../shared/http/list.ts';
import { SUPPORTED_LANGUAGES } from '../me/me.schemas.ts';
import { USER_THEMES } from './user.mapper.ts';
import { array, boolean, email, enumOf, nullable, object, objectId, optional, personName, phone, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { MAX_SERVICE_IDS, avatarSchema, descriptionSchema, pinSchema, posSchema, shiftTimeSchema } from './user-fields.schemas.ts';
import { USERS_LIST } from './users.list.ts';

/** Roles of the users that belong to a group: the ones `/v1/groups/{groupId}/users` creates and lists. */
export const GROUP_ROLES = ['SA', 'CA', 'PA', 'E'] as const;

/** Roles of the platform users, managed through `/v1/users` by the PSA only. */
export const PLATFORM_ROLES = ['PSA', 'D'] as const;

/** Every role, as the transversal list can filter on. */
export const ALL_ROLES = ['PSA', 'D', ...GROUP_ROLES] as const;

/** Most companies or places one user can be tied to in a single request. */
export const MAX_SCOPE_IDS = 100;

/** Longest password accepted in a request, in UTF-16 units (the policy then checks 12 to 128 code points). */
const MAX_PASSWORD_LENGTH = 1024;

/**
 * A new or changed username: 3 to 64 ASCII characters, letters, digits, `.`, `_`, `@`, `+` and `-`, no
 * spaces (trimmed first). ASCII only, so no look-alike spelling (full-width letters, ligatures, Cyrillic)
 * can pass for another user's name. Uniqueness is checked by the service (D-15), not here; existing
 * usernames are not validated until they change.
 */
export function usernameSchema() {
  return string({ min: 3, max: 64, trim: true, pattern: /^[A-Za-z0-9._@+-]+$/ });
}

const name = () => nullable(personName(100));

const moduleFlags = () => object({ r: optional(boolean()), w: optional(boolean()) });

/** The modules of the legacy matrix (`LEGACY_MODULES`), one optional pair of flags each; `logs` has only the read flag. */
const modulesSchema = () =>
  object({
    groups: optional(moduleFlags()),
    users: optional(moduleFlags()),
    companies: optional(moduleFlags()),
    places: optional(moduleFlags()),
    documents: optional(moduleFlags()),
    products: optional(moduleFlags()),
    calendar: optional(moduleFlags()),
    warehouse: optional(moduleFlags()),
    contacts: optional(moduleFlags()),
    fidelity: optional(moduleFlags()),
    settings: optional(moduleFlags()),
    stats: optional(moduleFlags()),
    logs: optional(object({ r: optional(boolean()) })),
  });

/** The permission matrix of a user in a request: core module flags and the right to manage other matrices. */
const permissionsSchema = () => object({ modules: optional(modulesSchema()), canManagePermissions: optional(boolean()) });

const scopeIds = () => array(objectId(), { max: MAX_SCOPE_IDS });

/**
 * The fields of a user's own data beyond identity and scope, the same in a creation and a modification: the notes, the picture, the PIN,
 * the statistics switch, the POS data and the shifts. `null` clears a nullable value.
 */
const dataFields = () => ({
  description: optional(nullable(descriptionSchema())),
  avatar: optional(nullable(avatarSchema())),
  pin: optional(nullable(pinSchema())),
  hiddenInStats: optional(boolean()),
  pos: optional(posSchema()),
  shiftTime: optional(shiftTimeSchema()),
});

/** The services a user of a group can provide. */
const serviceFields = () => ({ serviceIds: optional(array(objectId(), { max: MAX_SERVICE_IDS })) });

/**
 * Body of the creation of a group user (`POST /v1/groups/{groupId}/users`). The group comes from the
 * path, never from the body. `status` defaults to active, `permissions` to the default of the role limited
 * to what the creator holds.
 */
export const createGroupUserBody = object({
  username: usernameSchema(),
  password: string({ max: MAX_PASSWORD_LENGTH, normalize: false }),
  role: enumOf(GROUP_ROLES),
  firstName: optional(name()),
  lastName: optional(name()),
  email: optional(nullable(email())),
  phone: optional(nullable(phone())),
  language: optional(enumOf(SUPPORTED_LANGUAGES)),
  theme: optional(enumOf(USER_THEMES)),
  companyIds: optional(scopeIds()),
  placeIds: optional(scopeIds()),
  status: optional(enumOf(['active', 'disabled'] as const)),
  permissions: optional(permissionsSchema()),
  ...dataFields(),
  ...serviceFields(),
});

/** Validated body of the creation of a group user. */
export type CreateGroupUserBody = Infer<typeof createGroupUserBody>;

/** Body of the creation of a platform user (`POST /v1/users`): a PSA or a dealer, with no group and no scope. */
export const createPlatformUserBody = object({
  username: usernameSchema(),
  password: string({ max: MAX_PASSWORD_LENGTH, normalize: false }),
  role: enumOf(PLATFORM_ROLES),
  firstName: optional(name()),
  lastName: optional(name()),
  email: optional(nullable(email())),
  phone: optional(nullable(phone())),
  language: optional(enumOf(SUPPORTED_LANGUAGES)),
  theme: optional(enumOf(USER_THEMES)),
  status: optional(enumOf(['active', 'disabled'] as const)),
  permissions: optional(permissionsSchema()),
  ...dataFields(),
});

/** Validated body of the creation of a platform user. */
export type CreatePlatformUserBody = Infer<typeof createPlatformUserBody>;

/** Body of the modification of a group user (JSON Merge Patch): an absent field is left alone, `null` clears the personal ones. */
export const patchGroupUserBody = object({
  username: optional(usernameSchema()),
  role: optional(enumOf(GROUP_ROLES)),
  firstName: optional(name()),
  lastName: optional(name()),
  email: optional(nullable(email())),
  phone: optional(nullable(phone())),
  language: optional(enumOf(SUPPORTED_LANGUAGES)),
  theme: optional(enumOf(USER_THEMES)),
  companyIds: optional(scopeIds()),
  placeIds: optional(scopeIds()),
  status: optional(enumOf(['active', 'disabled'] as const)),
  permissions: optional(permissionsSchema()),
  ...dataFields(),
  ...serviceFields(),
});

/** Validated body of the modification of a group user. */
export type PatchGroupUserBody = Infer<typeof patchGroupUserBody>;

/** Body of the modification of a platform user. */
export const patchPlatformUserBody = object({
  username: optional(usernameSchema()),
  role: optional(enumOf(PLATFORM_ROLES)),
  firstName: optional(name()),
  lastName: optional(name()),
  email: optional(nullable(email())),
  phone: optional(nullable(phone())),
  language: optional(enumOf(SUPPORTED_LANGUAGES)),
  theme: optional(enumOf(USER_THEMES)),
  status: optional(enumOf(['active', 'disabled'] as const)),
  permissions: optional(permissionsSchema()),
  ...dataFields(),
});

/** Validated body of the modification of a platform user. */
export type PatchPlatformUserBody = Infer<typeof patchPlatformUserBody>;

/** Body of a password reset: the provisional password chosen by the administrator, kept exactly as sent. */
export const resetPasswordBody = object({ password: string({ max: MAX_PASSWORD_LENGTH, normalize: false }) });

/** Validated body of a password reset. */
export type ResetPasswordBody = Infer<typeof resetPasswordBody>;

/** Path parameters of the routes on one group user; the group was already verified by the route. */
export const groupUserParams = object({ userId: objectId() }, { allowUnknown: true });

/** Path parameters of the routes on one platform user. */
export const platformUserParams = object({ userId: objectId() });

/** Path parameters of the availability check. */
export const usernameParams = object({ username: usernameSchema() });

const filters = {
  status: optional(enumOf(['active', 'disabled'] as const)),
  trashed: optional(enumOf(['true', 'false'] as const)),
};

/** Query of `GET /v1/groups/{groupId}/users`. */
export const groupUsersQuery = object({ ...listQueryShape(USERS_LIST), ...filters, role: optional(enumOf(GROUP_ROLES)) });

/** Validated query of the group user list. */
export type GroupUsersQuery = Infer<typeof groupUsersQuery>;

/** Query of `GET /v1/users`: the same, over every role, with the filters by group and dealer. */
export const allUsersQuery = object({
  ...listQueryShape(USERS_LIST),
  ...filters,
  role: optional(enumOf(ALL_ROLES)),
  groupId: optional(objectId()),
  dealerId: optional(objectId()),
});

/** Validated query of the transversal user list. */
export type AllUsersQuery = Infer<typeof allUsersQuery>;
