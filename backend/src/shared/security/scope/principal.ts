import type { ObjectId } from 'mongodb';
import { frozenArray } from '../frozen.ts';
import type { ReadOnlySet } from '../frozen.ts';
import { effectivePermissionsOf } from '../rbac/effective-permissions.ts';
import { normalizeMatrix } from '../rbac/permission-matrix.ts';
import type { PermissionMatrix } from '../rbac/permission-matrix.ts';
import type { Permission, Role } from '../rbac/permissions.ts';
import type { PublicPermission } from '../rbac/public-permissions.ts';
import { computeScope } from './scope.ts';
import type { ComputeScopeDeps, Scope, ScopeAnomaly, UserScope } from './scope.ts';

/** What identifies a user inside the data perimeter (scope ids already normalized, D-08). */
export interface UserScopeView {
  readonly userId: ObjectId;
  readonly role: Role;
  readonly groupId: ObjectId | null;
  readonly companyIds: readonly ObjectId[];
  readonly placeIds: readonly ObjectId[];
}

/**
 * Verified, deeply frozen authentication context of a backoffice user, stored in `res.locals.auth`.
 * Everything in it is computed by the server from the verified credential and the stored user,
 * never from client input.
 */
export interface AuthPrincipal extends UserScopeView {
  /** Effective permissions: role ceiling intersected with the user's own permissions (read-only). */
  readonly permissions: ReadOnlySet<Permission>;
  /** Whether the user may change other users' permission matrix. */
  readonly canManagePermissions: boolean;
  /** The user's own normalized matrix, core and non-core modules (used to limit what he can grant). */
  readonly matrix: PermissionMatrix;
  /** Data perimeter visible to the user. */
  readonly scope: UserScope;
}

/** The only part of a caller the perimeter checks need: the data perimeter. A backoffice user and a store key both have one. */
export interface ScopeHolder {
  readonly scope: Scope;
}

/**
 * Verified, deeply frozen context of the server of a point of sale that authenticated with its store key (`doc/Security-Model.md` section 5), stored in `res.locals.store`, never in
 * `res.locals.auth`: everything written for users (the permission check, the group check, the per-user rate limit, the services typed on {@link AuthPrincipal}) finds no principal
 * and refuses, so no path made for users is reachable by a store by mistake. Every field is computed by the server on every request from the key and the stored state of the place.
 */
export interface StorePrincipal extends ScopeHolder {
  /** Marks the store principal. */
  readonly kind: 'store';
  /** Id of the store key that authenticated the request. */
  readonly keyId: ObjectId;
  readonly groupId: ObjectId;
  /** Company the place belongs to now (read from the copy of the place on every request: a place can change company). */
  readonly companyId: ObjectId;
  readonly placeId: ObjectId;
  /** When the store key was activated. */
  readonly activatedAt: Date;
  /** `STORE_PROFILE`: the fixed allowlist of what a store may do (read-only). */
  readonly permissions: ReadOnlySet<Permission>;
  readonly scope: Extract<Scope, { readonly kind: 'store' }>;
}

/** A stored user, with the legacy permission matrix still untouched. */
export interface StoredUser extends UserScopeView {
  /** The legacy `permissions` value, of unknown shape. */
  readonly legacyPermissions: unknown;
}

/** Result of {@link buildPrincipal}. */
export interface BuiltPrincipal {
  readonly principal: AuthPrincipal;
  /** Anomalies found while computing the scope, to be logged by the caller. */
  readonly anomalies: readonly ScopeAnomaly[];
}

/**
 * Assembles the frozen principal of a user: effective permissions and scope.
 *
 * @param user The stored user.
 * @param deps Dealer group and company place lookups.
 * @returns The principal and the scope anomalies.
 */
export async function buildPrincipal(user: StoredUser, deps: ComputeScopeDeps): Promise<BuiltPrincipal> {
  const matrix = normalizeMatrix(user.legacyPermissions);
  const { permissions, canManagePermissions } = effectivePermissionsOf(user.role, matrix);
  const { scope, anomalies } = await computeScope(user, deps);
  const principal: AuthPrincipal = Object.freeze({
    userId: user.userId,
    role: user.role,
    groupId: user.groupId,
    companyIds: frozenArray(user.companyIds),
    placeIds: frozenArray(user.placeIds),
    permissions,
    canManagePermissions,
    matrix,
    scope,
  });
  return { principal, anomalies };
}

/** The restrictions of a public API key to some companies and some places of its group; `null` means no restriction on that kind. */
export interface ApiKeyRestrictions {
  readonly companyIds: readonly ObjectId[] | null;
  readonly placeIds: readonly ObjectId[] | null;
}

/**
 * Verified, deeply frozen context of an integration that authenticated with a public API key (`doc/Security-Model.md` section 6), stored in `res.locals.apiKey`, never in `res.locals.auth`
 * or `res.locals.store`: nothing written for users or stores finds it. Every field is computed by the server on every request from the stored key and the state of the group.
 */
export interface ApiKeyPrincipal {
  /** Marks the API key principal. */
  readonly kind: 'apiKey';
  /** Id of the key that authenticated the request. */
  readonly keyId: ObjectId;
  /** The only group the key sees. */
  readonly groupId: ObjectId;
  /** Name of the group, for `GET /me`. */
  readonly groupName: string;
  /** Name given to the key, for `GET /me`. */
  readonly name: string;
  /** First characters of the key, as the backoffice shows them. */
  readonly prefix: string;
  /** What the key may read (read-only). */
  readonly permissions: ReadOnlySet<PublicPermission>;
  readonly restrictions: ApiKeyRestrictions;
  /** Requests per minute allowed to the key. */
  readonly rateLimitPerMinute: number;
  /** Requests per UTC day allowed to the key. */
  readonly dailyQuota: number;
  /** Requests per minute allowed to all the keys of the group together. */
  readonly groupRateLimitPerMinute: number;
  /** Requests per UTC day allowed to all the keys of the group together. */
  readonly groupDailyQuota: number;
  /** When the key stops working, `null` when it never does. */
  readonly expiresAt: Date | null;
}
