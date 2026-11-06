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
const COMPANIES = [P.COMPANIES_READ, P.COMPANIES_CREATE, P.COMPANIES_UPDATE, P.COMPANIES_TRASH] as const;
const PLACES = [P.PLACES_READ, P.PLACES_CREATE, P.PLACES_UPDATE, P.PLACES_TRASH] as const;

/**
 * Ceiling of each role: the most a user of that role can ever do. A user's own permissions
 * (D-06) can only narrow it. `E` has an empty ceiling: no access to the backoffice. Deeply
 * immutable.
 */
export const ROLE_CEILING: Readonly<Record<Role, ReadOnlySet<Permission>>> = Object.freeze({
  PSA: frozenSet<Permission>([P.GROUPS_READ, P.GROUPS_CREATE, P.GROUPS_UPDATE, P.GROUPS_SUSPEND, P.GROUPS_TRASH, ...DEALERS, ...COMPANIES, ...PLACES, ...USERS, ...USERS_DELETE, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  D: frozenSet<Permission>([P.GROUPS_READ, P.GROUPS_CREATE, P.GROUPS_UPDATE, ...COMPANIES, ...PLACES, ...USERS, ...USERS_DELETE, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  SA: frozenSet<Permission>([P.GROUPS_READ, P.GROUPS_UPDATE, ...COMPANIES, ...PLACES, ...USERS, ...USERS_DELETE, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  CA: frozenSet<Permission>([P.COMPANIES_READ, P.COMPANIES_UPDATE, ...PLACES, ...USERS, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
  PA: frozenSet<Permission>([P.PLACES_READ, P.PLACES_UPDATE, ...USERS, P.ACTIVITY_LOG_READ, ...SESSIONS, ...PROFILE, ...CLIENT_ERRORS]),
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
