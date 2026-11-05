import { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { effectivePermissionsOf } from '../../shared/security/rbac/effective-permissions.ts';
import { flagsOf, normalizeMatrix } from '../../shared/security/rbac/permission-matrix.ts';
import type { PermissionMatrix } from '../../shared/security/rbac/permission-matrix.ts';
import type { Role } from '../../shared/security/rbac/permissions.ts';
import type { UserChangeView, UserChangeViolation } from '../../shared/security/rbac/user-management.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { AuthRecord, UserChanges } from './user.types.ts';
import type { GroupDirectoryRepository } from './group-directory.repository.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';

/** The permission part of a create or patch body. */
export interface PermissionsInput {
  readonly modules?: Readonly<Record<string, { readonly r?: boolean; readonly w?: boolean } | undefined>>;
  readonly canManagePermissions?: boolean;
}

/**
 * Applies a permission patch to a matrix: the flags sent replace the stored ones, the others stay,
 * modules that are not in the patch (also the non-core ones) are kept as they are.
 *
 * @param base The matrix before.
 * @param patch The flags sent by the client, if any.
 * @returns A new matrix.
 */
export function applyPermissions(base: PermissionMatrix, patch: PermissionsInput | undefined): PermissionMatrix {
  const modules: Record<string, { r: boolean; w: boolean }> = Object.create(null) as Record<string, { r: boolean; w: boolean }>;
  for (const [name, flags] of Object.entries(base.modules)) {
    modules[name] = { r: flags.r, w: flags.w };
  }
  for (const [name, flags] of Object.entries(patch?.modules ?? {})) {
    const current = flagsOf(base, name);
    modules[name] = { r: flags?.r ?? current.r, w: flags?.w ?? current.w };
  }
  return Object.freeze({ status: patch?.canManagePermissions ?? base.status, modules });
}

/**
 * The flags that differ between two matrices, in the shape `toLegacyUpdate` writes (targeted
 * `permissions.<module>.r|w` and `permissions.status`).
 *
 * @returns The differences, or `undefined` when the matrices grant the same.
 */
export function permissionChanges(before: PermissionMatrix, after: PermissionMatrix): UserChanges['permissions'] {
  const modules: Record<string, { r?: boolean; w?: boolean }> = {};
  for (const name of Object.keys(after.modules)) {
    const was = flagsOf(before, name);
    const now = flagsOf(after, name);
    const changed = { ...(was.r === now.r ? {} : { r: now.r }), ...(was.w === now.w ? {} : { w: now.w }) };
    if (Object.keys(changed).length > 0) {
      modules[name] = changed;
    }
  }
  const status = before.status === after.status ? {} : { status: after.status };
  return Object.keys(modules).length === 0 && Object.keys(status).length === 0 ? undefined : { ...status, ...(Object.keys(modules).length === 0 ? {} : { modules }) };
}

/**
 * The state of a user as the anti-escalation rules look at it.
 *
 * @param input Identity, perimeter and stored matrix.
 */
export function changeViewOf(input: { userId: ObjectId; role: Role; groupId: ObjectId | null; companyIds: readonly ObjectId[]; placeIds: readonly ObjectId[]; matrix: PermissionMatrix }): UserChangeView {
  return { ...input, companyIds: [...input.companyIds], placeIds: [...input.placeIds], permissions: effectivePermissionsOf(input.role, input.matrix).permissions };
}

/**
 * The view of a stored user.
 *
 * @param record The user read for management.
 */
export function storedChangeView(record: AuthRecord): UserChangeView {
  const { stored } = record;
  return changeViewOf({ ...stored, matrix: normalizeMatrix(stored.legacyPermissions) });
}

/**
 * Turns the violations of `checkUserChange` into the error of the response: anything about who the
 * actor is or what he holds is `403`; a perimeter problem is a `422` on the scope field, the same
 * answer as a reference that does not exist, so it tells nothing about ids the actor cannot see.
 *
 * @param violations What `checkUserChange` found.
 * @param role The role the user would have.
 * @returns The error to throw, or `null` when there is no violation.
 */
export function violationError(violations: readonly UserChangeViolation[], role: Role): AppError | null {
  if (violations.length === 0) {
    return null;
  }
  if (violations.some((violation) => violation !== 'outOfScope')) {
    return new AppError('FORBIDDEN');
  }
  return new AppError('VALIDATION_ERROR', { details: [{ field: role === 'CA' ? 'companyIds' : 'placeIds', issue: 'incorrect' }] });
}

/**
 * The scope a role needs (D-08): CA at least one company, PA and E at least one place, SA, PSA and D
 * none. A list a role cannot have is `incorrect`, a missing mandatory one `required`.
 *
 * @param role The role.
 * @param companyIds Companies of the user.
 * @param placeIds Places of the user.
 * @returns One detail per problem.
 */
export function scopeShapeIssues(role: Role, companyIds: readonly unknown[], placeIds: readonly unknown[]): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  if (role === 'CA' && companyIds.length === 0) {
    issues.push({ field: 'companyIds', issue: 'required' });
  }
  if ((role === 'PA' || role === 'E') && placeIds.length === 0) {
    issues.push({ field: 'placeIds', issue: 'required' });
  }
  if ((role === 'SA' || role === 'PSA' || role === 'D') && companyIds.length > 0) {
    issues.push({ field: 'companyIds', issue: 'incorrect' });
  }
  if ((role === 'SA' || role === 'PSA' || role === 'D') && placeIds.length > 0) {
    issues.push({ field: 'placeIds', issue: 'incorrect' });
  }
  return issues;
}

/** What {@link scopeReferenceIssues} checks. */
export interface ScopeReferences {
  /** Final companies of the user. */
  readonly companyIds: readonly ObjectId[];
  /** Final places of the user. */
  readonly placeIds: readonly ObjectId[];
  /** Ids the user already has (hex), not checked again: an unrelated change must not fail because a place was trashed since. */
  readonly known?: { readonly companyIds: ReadonlySet<string>; readonly placeIds: ReadonlySet<string> };
}

/**
 * Checks that the new companies and places exist in the group and are not in the trash, and that every
 * new place belongs to one of the user's companies when he has any. A missing, trashed or foreign
 * reference is one and the same `incorrect` on its position, so it says nothing about other groups.
 *
 * @param directory Reads the group's companies and places.
 * @param principal The authenticated caller.
 * @param access Verified access to the group.
 * @param references The final scope and what the user already had.
 * @returns One detail per bad reference, empty when all are fine.
 */
export async function scopeReferenceIssues(
  directory: Pick<GroupDirectoryRepository, 'findCompanies' | 'findPlaces'>,
  principal: AuthPrincipal,
  access: GroupAccess,
  references: ScopeReferences,
): Promise<ErrorDetail[]> {
  const { companyIds, placeIds } = references;
  const isNew = (known: ReadonlySet<string> | undefined, id: ObjectId): boolean => known?.has(id.toHexString()) !== true;
  const newCompanies = companyIds.filter((id) => isNew(references.known?.companyIds, id));
  const newPlaces = placeIds.filter((id) => isNew(references.known?.placeIds, id));
  const issues: ErrorDetail[] = [];
  if (newCompanies.length > 0) {
    const found = new Set((await directory.findCompanies(principal, access, newCompanies)).map((id) => id.toHexString()));
    companyIds.forEach((id, index) => {
      if (newCompanies.includes(id) && !found.has(id.toHexString())) {
        issues.push({ field: `companyIds.${String(index)}`, issue: 'incorrect' });
      }
    });
  }
  if (newPlaces.length > 0) {
    const found = new Map((await directory.findPlaces(principal, access, newPlaces)).map((place) => [place.id.toHexString(), place]));
    placeIds.forEach((id, index) => {
      if (!newPlaces.includes(id)) {
        return;
      }
      const place = found.get(id.toHexString());
      const company = place?.companyId ?? null;
      const inCompany = companyIds.length === 0 || (company !== null && companyIds.some((companyId) => companyId.equals(company)));
      if (place === undefined || !inCompany) {
        issues.push({ field: `placeIds.${String(index)}`, issue: 'incorrect' });
      }
    });
  }
  return issues;
}
