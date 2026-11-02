import type { ReadOnlySet } from '../frozen.ts';
import type { ObjectId } from 'mongodb';
import type { AuthPrincipal, UserScopeView } from '../scope/principal.ts';
import { CORE_MODULES, EMPTY_MATRIX, defaultMatrix, flagsOf, matricesEqual } from './permission-matrix.ts';
import type { PermissionMatrix } from './permission-matrix.ts';
import type { Permission } from './permissions.ts';
import { ceilingOf, hasPermission, manageableRoles } from './policy.ts';

/**
 * A user as seen by the anti-escalation rules: identity, perimeter, the stored permission matrix
 * (the unit of what may be granted) and the effective permissions it produces.
 */
export interface UserChangeView extends UserScopeView {
  /** Normalized legacy matrix, non-core modules and `status` included. */
  readonly matrix: PermissionMatrix;
  /** Effective permissions of the user (role ceiling intersected with the matrix). */
  readonly permissions: ReadOnlySet<Permission>;
}

/** A rule broken by a user creation or change. */
export type UserChangeViolation = 'selfChange' | 'roleNotManageable' | 'outOfScope' | 'permissionNotHeld' | 'cannotManagePermissions';

const sameId = (a: ObjectId, b: ObjectId): boolean => a.equals(b);

const isSubset = (ids: readonly ObjectId[], allowed: readonly ObjectId[]): boolean =>
  ids.length > 0 && ids.every((id) => allowed.some((candidate) => sameId(id, candidate)));

/**
 * Whether a target sits inside the actor's perimeter (the rank is checked elsewhere). A CA manages
 * CA through their companies, and PA and E through their places (the legacy company of a PA is ignored).
 */
function insidePerimeter(actor: AuthPrincipal, target: UserScopeView): boolean {
  const { scope } = actor;
  switch (scope.kind) {
    case 'platform':
      return true;
    case 'dealer':
      return target.groupId !== null && scope.groupIds.has(target.groupId.toHexString());
    case 'group':
      return target.groupId !== null && sameId(target.groupId, scope.groupId);
    case 'companies':
      return (
        target.groupId !== null &&
        sameId(target.groupId, scope.groupId) &&
        (target.role === 'CA' ? isSubset(target.companyIds, scope.companyIds) : isSubset(target.placeIds, scope.placeIds))
      );
    case 'places':
      return target.groupId !== null && sameId(target.groupId, scope.groupId) && isSubset(target.placeIds, scope.placeIds);
    case 'none':
      return false;
  }
}

/** Rank problem, or else perimeter problem, of one target. */
function targetProblems(actor: AuthPrincipal, target: UserScopeView): UserChangeViolation[] {
  if (!manageableRoles(actor.role).includes(target.role)) {
    return ['roleNotManageable'];
  }
  return insidePerimeter(actor, target) ? [] : ['outOfScope'];
}

/**
 * Tells whether an actor may manage another user: the target is not the actor, its role is one
 * the actor's role manages, and it sits inside the actor's perimeter (a CA needs every company of a
 * CA target, and every place of a PA or E target, to be his own, and the target must have some).
 *
 * @param actor The authenticated caller.
 * @param target The user to manage.
 * @returns `true` when the actor may manage the target.
 */
export function canManageUser(actor: AuthPrincipal, target: UserScopeView): boolean {
  return !sameId(actor.userId, target.userId) && targetProblems(actor, target).length === 0;
}

/**
 * Whether the actor holds a flag of a module. Core modules: the corresponding effective
 * permissions (`r` the read one; `w` every write one the actor's role can have, and at least one).
 * Other modules: the actor's own raw flag.
 */
function actorHolds(actor: AuthPrincipal, module: string, flag: 'r' | 'w'): boolean {
  if (!Object.hasOwn(CORE_MODULES, module)) {
    return flagsOf(actor.matrix, module)[flag];
  }
  const core = CORE_MODULES[module]!;
  const needed = flag === 'r' ? core.read : core.write.filter((permission) => ceilingOf(actor.role).has(permission));
  return needed.length > 0 && needed.every((permission) => hasPermission(actor, permission));
}

/** Names of the modules of two matrices. */
function moduleNames(...matrices: PermissionMatrix[]): string[] {
  return [...new Set(matrices.flatMap((matrix) => Object.keys(matrix.modules)))];
}

/** The matrix a user born from an actor without `canManagePermissions` gets: the role default limited to the actor's flags. */
function inheritedMatrix(actor: AuthPrincipal, role: UserScopeView['role']): PermissionMatrix {
  const base = defaultMatrix(role);
  const modules: Record<string, { r: boolean; w: boolean }> = Object.create(null) as Record<string, { r: boolean; w: boolean }>;
  for (const name of moduleNames(base)) {
    const flags = flagsOf(base, name);
    modules[name] = { r: flags.r && actorHolds(actor, name, 'r'), w: flags.w && actorHolds(actor, name, 'w') };
  }
  return { status: false, modules };
}

/**
 * Checks the creation (`before` is `null`) or the change of a user against the anti-escalation
 * rules and lists every violation.
 *
 * - Nobody changes himself (`selfChange`).
 * - Both the old and the new state must be manageable by the actor (rank and perimeter), so a user
 *   can neither be moved out of the actor's perimeter nor promoted beyond his rank.
 * - Effective permissions newly granted must be held by the actor (`permissionNotHeld`); the
 *   sessions of the user himself are not compared.
 * - Every matrix flag that turns on (core or not) must be held by the actor (`permissionNotHeld`);
 *   turning on `status` requires the actor to hold it (`cannotManagePermissions`).
 * - Changing the stored matrix (non-core modules and `status` included) requires
 *   `canManagePermissions`. A new user created by an actor without it gets the default matrix of the
 *   role limited to the actor's flags, and any other matrix is `cannotManagePermissions`.
 *
 * Constraint for the user area (area 3): the matrix is written only with targeted `$set` of
 * `permissions.<module>.r|w` and `permissions.status`, with modules from an allowlist, keeping the
 * rest of `permissions` (`apps.cash.*` included); `/v1` rejects with 422 any change to `apps`.
 *
 * @param actor The authenticated caller.
 * @param before The user as stored, or `null` for a creation.
 * @param after The user as it would be after the operation.
 * @returns The violations, empty when the operation is allowed.
 */
export function checkUserChange(actor: AuthPrincipal, before: UserChangeView | null, after: UserChangeView): UserChangeViolation[] {
  const violations = new Set<UserChangeViolation>();
  if (before !== null && sameId(before.userId, actor.userId)) {
    violations.add('selfChange');
  }
  for (const view of before === null ? [after] : [before, after]) {
    for (const problem of targetProblems(actor, view)) {
      violations.add(problem);
    }
  }

  const previous = before?.permissions;
  const isOwnSession = (permission: string): boolean => permission.startsWith('sessions:');
  const granted = [...after.permissions].filter((permission) => !isOwnSession(permission) && previous?.has(permission) !== true);
  if (granted.some((permission) => !hasPermission(actor, permission))) {
    violations.add('permissionNotHeld');
  }

  const beforeMatrix = before?.matrix ?? EMPTY_MATRIX;
  for (const name of moduleNames(beforeMatrix, after.matrix)) {
    for (const flag of ['r', 'w'] as const) {
      if (flagsOf(after.matrix, name)[flag] && !flagsOf(beforeMatrix, name)[flag] && !actorHolds(actor, name, flag)) {
        violations.add('permissionNotHeld');
      }
    }
  }
  if (after.matrix.status && !beforeMatrix.status && !actor.canManagePermissions) {
    violations.add('cannotManagePermissions');
  }
  if (!actor.canManagePermissions) {
    const allowed = before === null ? inheritedMatrix(actor, after.role) : before.matrix;
    if (!matricesEqual(allowed, after.matrix)) {
      violations.add('cannotManagePermissions');
    }
  }
  return [...violations];
}
