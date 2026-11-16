import { frozenSet } from '../frozen.ts';
import type { ReadOnlySet } from '../frozen.ts';

/** Roles of the platform, from the most to the least powerful. */
export const ROLES = Object.freeze(['PSA', 'D', 'SA', 'CA', 'PA', 'E'] as const);

/** A role of the platform (`doc/Security-Model.md` section 8.1). */
export type Role = (typeof ROLES)[number];

/**
 * Rank of each role: a higher number is a more powerful role (PSA > D > SA > CA > PA > E).
 * Used only to order roles; who may manage whom is decided by `MANAGEABLE_ROLES`.
 */
export const ROLE_RANK: Readonly<Record<Role, number>> = Object.freeze({ PSA: 5, D: 4, SA: 3, CA: 2, PA: 1, E: 0 });

/**
 * Catalog of the `resource:action` permissions of the core domains. A route declares one of these
 * values; nothing outside this catalog can be required or granted.
 */
export const PERMISSIONS = Object.freeze({
  GROUPS_READ: 'groups:read',
  GROUPS_CREATE: 'groups:create',
  GROUPS_UPDATE: 'groups:update',
  GROUPS_SUSPEND: 'groups:suspend',
  GROUPS_TRASH: 'groups:trash',
  DEALERS_READ: 'dealers:read',
  DEALERS_CREATE: 'dealers:create',
  DEALERS_UPDATE: 'dealers:update',
  COMPANIES_READ: 'companies:read',
  COMPANIES_CREATE: 'companies:create',
  COMPANIES_UPDATE: 'companies:update',
  COMPANIES_TRASH: 'companies:trash',
  COMPANIES_DELETE: 'companies:delete',
  PLACES_READ: 'places:read',
  PLACES_CREATE: 'places:create',
  PLACES_UPDATE: 'places:update',
  PLACES_TRASH: 'places:trash',
  PLACES_DELETE: 'places:delete',
  USERS_READ: 'users:read',
  USERS_CREATE: 'users:create',
  USERS_UPDATE: 'users:update',
  USERS_TRASH: 'users:trash',
  USERS_DELETE: 'users:delete',
  FIDELITY_READ: 'fidelity:read',
  FIDELITY_UPDATE: 'fidelity:update',
  PRODUCTS_READ: 'products:read',
  PRODUCTS_UPDATE: 'products:update',
  ACTIVITY_LOG_READ: 'activityLog:read',
  SESSIONS_READ: 'sessions:read',
  SESSIONS_REVOKE: 'sessions:revoke',
  PROFILE_READ: 'profile:read',
  PROFILE_UPDATE: 'profile:update',
  CLIENT_ERRORS_CREATE: 'clientErrors:create',
  STORE_KEYS_READ: 'storeKeys:read',
  STORE_KEYS_MANAGE: 'storeKeys:manage',
} as const);

/** A permission of the catalog, as `resource:action`. */
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Every permission of the catalog. */
export const ALL_PERMISSIONS: ReadOnlySet<Permission> = frozenSet(Object.values(PERMISSIONS));

/**
 * Tells whether a value is a permission of the catalog.
 *
 * @param value Any value.
 * @returns `true` only for a string present in {@link PERMISSIONS}.
 */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (ALL_PERMISSIONS as ReadOnlySet<string>).has(value);
}

/**
 * Tells whether a value is a role.
 *
 * @param value Any value.
 * @returns `true` only for one of {@link ROLES}.
 */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
