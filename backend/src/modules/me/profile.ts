import { toResponse } from '../users/user.mapper.ts';
import type { User, UserResponse } from '../users/user.types.ts';
import { ALL_PERMISSIONS } from '../../shared/security/rbac/permissions.ts';
import { hasPermission } from '../../shared/security/rbac/policy.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { GroupSummary } from './group-summary.repository.ts';

/** Most dealer group ids listed in the profile; the total is always given. */
export const MAX_SCOPE_SUMMARY_IDS = 100;

/** A short description of the data perimeter: counts, never the full lists (a dealer can have thousands of groups). */
export type ScopeSummary =
  | { readonly kind: 'platform' }
  | { readonly kind: 'dealer'; readonly groups: number; readonly groupIds: readonly string[] }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'companies'; readonly groupId: string; readonly companies: number; readonly places: number }
  | { readonly kind: 'places'; readonly groupId: string; readonly places: number }
  | { readonly kind: 'none' };

/** What `GET /v1/me` returns: the user, his effective permissions, scope summary and group. No secret. */
export type Profile = Omit<UserResponse, 'permissions'> & {
  /** Effective permissions (`resource:action`), sorted. */
  readonly permissions: readonly string[];
  readonly canManagePermissions: boolean;
  readonly scope: ScopeSummary;
  /** Id and name of the group for SA, CA and PA; `null` otherwise. */
  readonly group: GroupSummary | null;
};

/**
 * Summarizes a scope for the profile.
 *
 * @param principal The authenticated user.
 */
export function summarizeScope({ scope }: AuthPrincipal): ScopeSummary {
  switch (scope.kind) {
    case 'platform':
    case 'none':
      return { kind: scope.kind };
    case 'dealer':
      return { kind: 'dealer', groups: scope.groupIds.size, groupIds: [...scope.groupIds].sort().slice(0, MAX_SCOPE_SUMMARY_IDS) };
    case 'group':
      return { kind: 'group', groupId: scope.groupId.toHexString() };
    case 'companies':
      return { kind: 'companies', groupId: scope.groupId.toHexString(), companies: scope.companyIds.length, places: scope.placeIds.length };
    case 'places':
      return { kind: 'places', groupId: scope.groupId.toHexString(), places: scope.placeIds.length };
  }
}

/**
 * Builds the profile from the stored user, through the explicit response mapper, plus what the
 * server computed for the session.
 *
 * @param user The stored user.
 * @param principal The authenticated principal (permissions and scope recomputed on this request).
 * @param group Summary of the user's group, or `null`.
 */
export function toProfile(user: User, principal: AuthPrincipal, group: GroupSummary | null): Profile {
  return {
    ...toResponse(user),
    permissions: [...ALL_PERMISSIONS].filter((permission) => hasPermission(principal, permission)).sort(),
    canManagePermissions: principal.canManagePermissions,
    scope: summarizeScope(principal),
    group,
  };
}
