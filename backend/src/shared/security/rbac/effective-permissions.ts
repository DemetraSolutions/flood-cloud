import { frozenSet } from '../frozen.ts';
import type { ReadOnlySet } from '../frozen.ts';
import { CORE_MODULES, flagsOf, normalizeMatrix } from './permission-matrix.ts';
import type { PermissionMatrix } from './permission-matrix.ts';
import { PERMISSIONS as P, isRole } from './permissions.ts';
import type { Permission, Role } from './permissions.ts';
import { ceilingOf } from './policy.ts';

/** Result of {@link effectivePermissions}. */
export interface EffectivePermissions {
  /** Role ceiling intersected with the user's own permissions (read-only). */
  readonly permissions: ReadOnlySet<Permission>;
  /** Whether the user may change other users' permission matrix (legacy `permissions.status`). */
  readonly canManagePermissions: boolean;
}

/** Permissions every user holds on his own account, within the role ceiling (no legacy module). */
const OWN_SESSION_PERMISSIONS: readonly Permission[] = [P.SESSIONS_READ, P.SESSIONS_REVOKE];

/**
 * Computes what a user may do (D-06) from an already normalized matrix: the ceiling of the role
 * limited by the matrix. `r` grants `read`; `w` grants every write action of the resource;
 * non-core modules produce no permission; the user's own sessions are always allowed within the
 * ceiling.
 *
 * @param role Role of the user; an invalid role (corrupt data) gets nothing, without throwing.
 * @param matrix Normalized matrix.
 */
export function effectivePermissionsOf(role: Role, matrix: PermissionMatrix): EffectivePermissions {
  if (!isRole(role)) {
    return { permissions: frozenSet(), canManagePermissions: false };
  }
  const ceiling = ceilingOf(role);
  const granted = new Set<Permission>();
  const grant = (permissions: readonly Permission[]): void => {
    for (const permission of permissions) {
      if (ceiling.has(permission)) {
        granted.add(permission);
      }
    }
  };
  for (const [name, module] of Object.entries(CORE_MODULES)) {
    const flags = flagsOf(matrix, name);
    if (flags.r) {
      grant(module.read);
    }
    if (flags.w) {
      grant(module.write);
    }
  }
  grant(OWN_SESSION_PERMISSIONS);
  return { permissions: frozenSet(granted), canManagePermissions: role !== 'E' && matrix.status };
}

/**
 * Computes what a user may do (D-06) from the legacy `permissions` value of unknown shape.
 * See {@link effectivePermissionsOf} and {@link normalizeMatrix}: only own data properties equal
 * to `true` count, so a missing or malformed matrix grants nothing and getters never run.
 *
 * @param role Role of the user.
 * @param legacyPermissions The legacy `permissions` value (never trusted).
 * @returns Effective permissions and whether the user may manage permission matrices.
 */
export function effectivePermissions(role: Role, legacyPermissions: unknown): EffectivePermissions {
  return effectivePermissionsOf(role, normalizeMatrix(legacyPermissions));
}
