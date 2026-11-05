import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { manageableRoles } from '../rbac/policy.ts';
import type { AuthPrincipal } from './principal.ts';
import type { Scope } from './scope.ts';

/** A filter that matches no document. */
const NOTHING: Filter<Document> = { _id: { $in: [] } };

/**
 * The only way to combine a scope filter with a query filter: both must hold. Whatever the query
 * contains (`$or`, `groupId`, ...), it can only narrow the scope, never widen it.
 *
 * @param scopeFilter A filter from this module.
 * @param filter The filter of the operation.
 * @returns `{ $and: [scopeFilter, filter] }`.
 */
export function withScope(scopeFilter: Filter<Document>, filter: Filter<Document>): Filter<Document> {
  return { $and: [scopeFilter, filter] };
}

/**
 * Filter restricting `common.users` to the users a principal may see: inside the perimeter and of a
 * role the principal's role manages (a SA does not see PSA or D, a D does not see other D). A user
 * with no `role` counts as `E`, as in the legacy. A CA sees the CA of his companies (by company) and the PA and E whose
 * places belong to his companies (by place, the legacy company of a PA is ignored). Combine with {@link withScope}.
 *
 * @param principal Role and scope of the caller.
 * @returns A MongoDB filter; it matches nothing for the scope `none`.
 */
export function usersScopeFilter(principal: Pick<AuthPrincipal, 'role' | 'scope'>): Filter<Document> {
  const { scope } = principal;
  if (scope.kind === 'platform') {
    return {};
  }
  const roles = manageableRoles(principal.role);
  const role = { $in: roles.includes('E') ? [...roles, null] : [...roles] };
  switch (scope.kind) {
    case 'dealer':
      return { groupId: { $in: [...scope.groupIds].map((hex) => ObjectId.createFromHexString(hex)) }, role };
    case 'group':
      return { groupId: scope.groupId, role };
    case 'companies': {
      // Same rule as canManageUser: a CA is reached through the companies, a PA or E through the places.
      const placeIds = [...scope.placeIds];
      const others = roles.filter((candidate) => candidate !== 'CA');
      return {
        groupId: scope.groupId,
        $or: [
          { role: { $in: roles.filter((candidate) => candidate === 'CA') }, companyId: { $in: [...scope.companyIds] } },
          { role: { $in: others.includes('E') ? [...others, null] : others }, $or: [{ placeId: { $in: placeIds } }, { placesId: { $in: placeIds } }] },
        ],
      };
    }
    case 'places':
      return { groupId: scope.groupId, role, $or: [{ placeId: { $in: [...scope.placeIds] } }, { placesId: { $in: [...scope.placeIds] } }] };
    case 'none':
      return NOTHING;
  }
}

/**
 * Filter restricting `common.groups` to the groups inside a perimeter: all of them for the platform, the groups
 * of the dealer, the own group for the group scopes (`group`, `companies`, `places`). Combine with {@link withScope}.
 *
 * @param scope Scope of the caller.
 * @returns A MongoDB filter; it matches nothing for `none`.
 */
export function groupsScopeFilter(scope: Scope): Filter<Document> {
  switch (scope.kind) {
    case 'platform':
      return {};
    case 'dealer':
      return { _id: { $in: [...scope.groupIds].map((hex) => ObjectId.createFromHexString(hex)) } };
    case 'group':
    case 'companies':
    case 'places':
      return { _id: scope.groupId };
    case 'none':
      return NOTHING;
  }
}

/**
 * Filter restricting `companies` of a group database (already resolved from a verified group
 * access) to the companies inside a perimeter. Combine with {@link withScope}.
 *
 * @param scope Scope of the caller.
 * @returns A MongoDB filter; it matches nothing for `places` and `none`.
 */
export function companiesScopeFilter(scope: Scope): Filter<Document> {
  switch (scope.kind) {
    case 'platform':
    case 'dealer':
    case 'group':
      return {};
    case 'companies':
      return { _id: { $in: [...scope.companyIds] } };
    case 'places':
    case 'none':
      return NOTHING;
  }
}

/**
 * Filter restricting `places` of a group database (already resolved from a verified group
 * access) to the places inside a perimeter. Combine with {@link withScope}.
 *
 * @param scope Scope of the caller.
 * @returns A MongoDB filter; it matches nothing for `none`.
 */
export function placesScopeFilter(scope: Scope): Filter<Document> {
  switch (scope.kind) {
    case 'platform':
    case 'dealer':
    case 'group':
      return {};
    case 'companies':
      return { companyId: { $in: [...scope.companyIds] } };
    case 'places':
      return { _id: { $in: [...scope.placeIds] } };
    case 'none':
      return NOTHING;
  }
}

/**
 * Filter restricting `common.activityLog` to the entries a principal may read. A PSA reads everything; a
 * dealer the entries of his groups, a group administrator those of his group; a company or place
 * administrator only his own actions. Entries of the `error` category are the PSA's alone, so for every
 * other role they are excluded here. Combine with {@link withScope}.
 *
 * @param principal Id and scope of the caller.
 * @returns A MongoDB filter; it matches nothing for the scope `none`.
 */
export function activityLogScopeFilter(principal: Pick<AuthPrincipal, 'userId' | 'scope'>): Filter<Document> {
  const { scope } = principal;
  const notErrors: Filter<Document> = { category: { $ne: 'error' } };
  switch (scope.kind) {
    case 'platform':
      return {};
    case 'dealer':
      return { ...notErrors, groupId: { $in: [...scope.groupIds].map((hex) => ObjectId.createFromHexString(hex)) } };
    case 'group':
      return { ...notErrors, groupId: scope.groupId };
    case 'companies':
    case 'places':
      return { ...notErrors, 'actor.id': principal.userId };
    case 'none':
      return NOTHING;
  }
}
