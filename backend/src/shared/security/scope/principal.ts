import type { ObjectId } from 'mongodb';
import { frozenArray } from '../frozen.ts';
import type { ReadOnlySet } from '../frozen.ts';
import { effectivePermissionsOf } from '../rbac/effective-permissions.ts';
import { normalizeMatrix } from '../rbac/permission-matrix.ts';
import type { PermissionMatrix } from '../rbac/permission-matrix.ts';
import type { Permission, Role } from '../rbac/permissions.ts';
import { computeScope } from './scope.ts';
import type { ComputeScopeDeps, Scope, ScopeAnomaly } from './scope.ts';

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
  readonly scope: Scope;
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
