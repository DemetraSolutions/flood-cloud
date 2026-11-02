import type { ReadOnlySet } from '../../src/shared/security/frozen.ts';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { effectivePermissions } from '../../src/shared/security/rbac/effective-permissions.ts';
import { defaultMatrix } from '../../src/shared/security/rbac/permission-matrix.ts';
import type { PermissionMatrix } from '../../src/shared/security/rbac/permission-matrix.ts';
import type { Permission, Role } from '../../src/shared/security/rbac/permissions.ts';
import { ROLE_CEILING } from '../../src/shared/security/rbac/policy.ts';
import { buildPrincipal } from '../../src/shared/security/scope/principal.ts';
import type { AuthPrincipal } from '../../src/shared/security/scope/principal.ts';
import { legacyScopeIds } from '../../src/shared/security/scope/legacy-scope.ts';
import type { ComputeScopeDeps } from '../../src/shared/security/scope/scope.ts';
import { fixtureId } from './legacy-fixtures.ts';

/** Overrides accepted by {@link principalOf}. */
export interface PrincipalSpec {
  readonly userId?: ObjectId;
  readonly groupId?: ObjectId | null;
  readonly companyIds?: readonly ObjectId[];
  readonly placeIds?: readonly ObjectId[];
  /** Effective permissions; the whole ceiling of the role by default. */
  readonly permissions?: ReadOnlySet<Permission>;
  readonly canManagePermissions?: boolean;
  /** Stored matrix of the principal; the role default (with `status` from `canManagePermissions`) by default. */
  readonly matrix?: PermissionMatrix;
  /** Dealer groups (hex ids), used only when the role is `D`. */
  readonly dealerGroupIds?: readonly ObjectId[];
}

/**
 * Builds a principal by hand (no database): the scope follows the role, the permissions are the
 * whole ceiling of the role unless overridden.
 *
 * @param role Role of the principal.
 * @param spec Overrides.
 */
export function principalOf(role: Role, spec: PrincipalSpec = {}): AuthPrincipal {
  const groupId = spec.groupId === undefined ? (role === 'PSA' || role === 'D' ? null : fixtureId('group', 1)) : spec.groupId;
  const companyIds = spec.companyIds ?? [];
  const placeIds = spec.placeIds ?? [];
  const canManagePermissions = spec.canManagePermissions ?? role !== 'E';
  const base = {
    userId: spec.userId ?? fixtureId('user', 900),
    role,
    groupId,
    companyIds,
    placeIds,
    permissions: spec.permissions ?? ROLE_CEILING[role],
    canManagePermissions,
    matrix: spec.matrix ?? { ...defaultMatrix(role), status: canManagePermissions },
  };
  switch (role) {
    case 'PSA':
      return { ...base, scope: { kind: 'platform' } };
    case 'D':
      return { ...base, scope: { kind: 'dealer', groupIds: new Set((spec.dealerGroupIds ?? []).map((id) => id.toHexString())) } };
    case 'E':
      return { ...base, scope: { kind: 'none' } };
    case 'SA':
      return { ...base, scope: { kind: 'group', groupId: groupId! } };
    case 'CA':
      return { ...base, scope: { kind: 'companies', groupId: groupId!, companyIds, placeIds } };
    case 'PA':
      return { ...base, scope: { kind: 'places', groupId: groupId!, placeIds } };
  }
}

/**
 * Builds the principal of a legacy `users` document, the way the authentication area will:
 * normalized scope ids, effective permissions and scope computed by the real code.
 *
 * @param user Legacy user document.
 * @param deps Dealer group lookup.
 */
export async function principalFromLegacyUser(user: Document, deps: ComputeScopeDeps): Promise<AuthPrincipal> {
  const role = user['role'] as Role;
  const groupId = user['groupId'] instanceof ObjectId ? user['groupId'] : null;
  const { principal } = await buildPrincipal(
    { userId: user['_id'] as ObjectId, role, groupId, ...legacyScopeIds(user), legacyPermissions: user['permissions'] },
    deps,
  );
  return principal;
}

/** Effective permissions of a legacy matrix, for tests that need only the set. */
export function permissionsOf(role: Role, legacyPermissions: unknown): ReadOnlySet<Permission> {
  return effectivePermissions(role, legacyPermissions).permissions;
}
