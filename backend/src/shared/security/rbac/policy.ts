import { frozenArray, frozenSet } from '../frozen.ts';
import type { ReadOnlySet } from '../frozen.ts';
import { PERMISSIONS as P, isRole } from './permissions.ts';
import type { Permission, Role } from './permissions.ts';

const SESSIONS = [P.SESSIONS_READ, P.SESSIONS_REVOKE] as const;
const PROFILE = [P.PROFILE_READ, P.PROFILE_UPDATE] as const;
const CLIENT_ERRORS = [P.CLIENT_ERRORS_CREATE] as const;
const USERS = [P.USERS_READ, P.USERS_CREATE, P.USERS_UPDATE, P.USERS_TRASH] as const;
/** Permanent deletion of a user from the trash (D-14): only PSA, D and SA. */
const USERS_DELETE = [P.USERS_DELETE] as const;
/** The dealer registry (`doc/Tasks.md` D-09): only the PSA reaches it. */
const DEALERS = [P.DEALERS_READ, P.DEALERS_CREATE, P.DEALERS_UPDATE] as const;
const COMPANIES = [P.COMPANIES_READ, P.COMPANIES_CREATE, P.COMPANIES_UPDATE, P.COMPANIES_TRASH, P.COMPANIES_DELETE] as const;
/** Loyalty data and the product data kept in the group document (favorites, promotions): every role that works in a group; the user's own matrix narrows it. */
const GROUP_DATA = [P.FIDELITY_READ, P.FIDELITY_UPDATE, P.PRODUCTS_READ, P.PRODUCTS_UPDATE] as const;
/** The places a group administrator manages: read, update, trash and delete (a trashed place is deleted for good with its own permission, like `users:delete`); he does not create them. A CA and a PA read and update (a CA the places of his companies, a PA his own). */
const PLACES = [P.PLACES_READ, P.PLACES_UPDATE, P.PLACES_TRASH, P.PLACES_DELETE] as const;

/** The key of the server of a point of sale (`doc/Security-Model.md` section 5): see and manage it, only the PSA and the dealers (D-24). The store itself never holds them. */
const STORE_KEYS = [P.STORE_KEYS_READ, P.STORE_KEYS_MANAGE] as const;

/** The public API keys of a group (`doc/Security-Model.md` section 6): see them and manage them (create, change, revoke), only the PSA and the dealers. The limits of a key are the PSA's alone, which the service decides. */
const API_KEYS = [P.API_KEYS_READ, P.API_KEYS_MANAGE] as const;

/** The national tobacco price list of the platform (`doc/Tasks.md` 9-bis, step T3): read it and replace it with the official file, only the PSA. */
const TOBACCOS = [P.TOBACCOS_READ, P.TOBACCOS_IMPORT] as const;

/** The countries and provinces of the platform (`doc/Tasks.md` 9-ter): create, rename and delete them, only the PSA. Reading them is `profile:read`, for every user. */
const COUNTRIES = [P.COUNTRIES_MANAGE] as const;

/** Emptying the trash of a group, tab by tab (`doc/Tasks.md` 9-ter, step P2): only the PSA. Restoring and deleting selected items use the permissions of each domain. */
const TRASH = [P.TRASH_EMPTY] as const;

/** The electronic invoices and credit notes of the legacy send queue that Aruba refused or that ended in error (`doc/Tasks.md` 9-ter, step 3): read only, the PSA and the dealers (the legacy page was theirs). */
const ERROR_DOCUMENTS = [P.ERROR_DOCUMENTS_READ] as const;

/**
 * What the server of a point of sale may do with its store key (`doc/Security-Model.md` section 8.2): an explicit allowlist, never derived from a role, a matrix or a request, and never
 * extended from the interface. For now only the reading of its own place; the domains that come later (cash desk, sales, catalog) add what they decide, each with its own step.
 */
export const STORE_PROFILE: ReadOnlySet<Permission> = frozenSet<Permission>([P.PLACES_READ]);

/**
 * Ceiling of each role: the most a user of that role can ever do. A user's own permissions
 * (D-06) can only narrow it. `E` has an empty ceiling: no access to the backoffice. Deeply
 * immutable.
 */
export const ROLE_CEILING: Readonly<Record<Role, ReadOnlySet<Permission>>> = Object.freeze({
  PSA: frozenSet<Permission>([P.GROUPS_READ, P.GROUPS_CREATE, P.GROUPS_UPDATE, P.GROUPS_SUSPEND, P.GROUPS_TRASH, ...DEALERS, ...TOBACCOS, ...COUNTRIES, ...TRASH, ...ERROR_DOCUMENTS, ...COMPANIES, ...PLACES, P.PLACES_CREATE, ...STORE_KEYS, ...API_KEYS, ...GROUP_DATA, ...USERS, ...USERS_DELETE, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  D: frozenSet<Permission>([P.GROUPS_READ, P.GROUPS_CREATE, P.GROUPS_UPDATE, ...ERROR_DOCUMENTS, ...COMPANIES, ...PLACES, P.PLACES_CREATE, ...STORE_KEYS, ...API_KEYS, ...GROUP_DATA, ...USERS, ...USERS_DELETE, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  SA: frozenSet<Permission>([P.GROUPS_READ, P.GROUPS_UPDATE, ...COMPANIES, ...PLACES, ...GROUP_DATA, ...USERS, ...USERS_DELETE, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  CA: frozenSet<Permission>([P.COMPANIES_READ, P.COMPANIES_UPDATE, P.PLACES_READ, P.PLACES_UPDATE, ...GROUP_DATA, ...USERS, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  PA: frozenSet<Permission>([P.PLACES_READ, P.PLACES_UPDATE, ...GROUP_DATA, ...USERS, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  E: frozenSet<Permission>(),
});

/**
 * Roles each role may create and manage (always inside its own perimeter). Peers are included
 * where the product decision says so (PSA over PSA, SA over SA, CA over CA, PA over PA); a dealer
 * does not manage other dealers. Deeply immutable.
 */
export const MANAGEABLE_ROLES: Readonly<Record<Role, readonly Role[]>> = Object.freeze({
  PSA: frozenArray<Role>(['PSA', 'D', 'SA', 'CA', 'PA', 'E']),
  D: frozenArray<Role>(['SA', 'CA', 'PA', 'E']),
  SA: frozenArray<Role>(['SA', 'CA', 'PA', 'E']),
  CA: frozenArray<Role>(['CA', 'PA', 'E']),
  PA: frozenArray<Role>(['PA', 'E']),
  E: frozenArray<Role>([]),
});

/**
 * Ceiling of a role that may come from stored data.
 *
 * @param role Any value.
 * @returns The ceiling, or an empty set when the value is not a role.
 */
export function ceilingOf(role: unknown): ReadOnlySet<Permission> {
  return isRole(role) ? ROLE_CEILING[role] : ROLE_CEILING.E;
}

/**
 * Roles a role manages.
 *
 * @param role Any value.
 * @returns The manageable roles, none when the value is not a role.
 */
export function manageableRoles(role: unknown): readonly Role[] {
  return isRole(role) ? MANAGEABLE_ROLES[role] : MANAGEABLE_ROLES.E;
}

/** The part of an authenticated principal the policy looks at. */
export interface PermissionHolder {
  readonly role: Role;
  /** Effective permissions of the user (already narrowed by the user's own matrix). */
  readonly permissions: ReadOnlySet<Permission>;
}

/**
 * Tells whether a principal holds a permission. Both the role ceiling and the effective
 * permissions must contain it, so a corrupted set or role can never exceed the role.
 *
 * @param principal Role and effective permissions of the caller.
 * @param permission Permission to check.
 * @returns `true` when the caller may exercise the permission.
 */
export function hasPermission(principal: PermissionHolder, permission: Permission): boolean {
  return ceilingOf(principal.role).has(permission) && principal.permissions.has(permission);
}
