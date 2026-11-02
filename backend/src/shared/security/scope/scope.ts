import type { ObjectId } from 'mongodb';
import { frozenArray, frozenSet } from '../frozen.ts';
import type { ReadOnlySet } from '../frozen.ts';
import { isRole } from '../rbac/permissions.ts';
import type { UserScopeView } from './principal.ts';

/**
 * Data perimeter of a principal, computed by the server. Deeply immutable.
 *
 * - `platform`: every group (PSA).
 * - `dealer`: the available groups whose `dealerId` is the dealer (D); ids as lower-case hex.
 * - `group`: one group (SA).
 * - `companies`: some companies of one group and the places of those companies (CA).
 * - `places`: some places of one group (PA).
 * - `none`: nothing; roles without backoffice access (E) and users missing the data they need.
 */
export type Scope =
  | { readonly kind: 'platform' }
  | { readonly kind: 'dealer'; readonly groupIds: ReadOnlySet<string> }
  | { readonly kind: 'group'; readonly groupId: ObjectId }
  | { readonly kind: 'companies'; readonly groupId: ObjectId; readonly companyIds: readonly ObjectId[]; readonly placeIds: readonly ObjectId[] }
  | { readonly kind: 'places'; readonly groupId: ObjectId; readonly placeIds: readonly ObjectId[] }
  | { readonly kind: 'none' };

/** Reasons why a scope is empty although the role would have one. */
export type ScopeAnomaly = 'invalidRole' | 'missingGroup' | 'companyAdminWithoutCompanies' | 'placeAdminWithoutPlaces';

/** Dependencies of {@link computeScope}. */
export interface ComputeScopeDeps {
  /** Ids of the available (active, not trashed) groups whose `dealerId` is the given user. */
  listDealerGroupIds(dealerUserId: ObjectId): Promise<readonly ObjectId[]>;
  /** Ids of the places of the given companies, in the database of the given group. */
  listCompanyPlaceIds(groupId: ObjectId, companyIds: readonly ObjectId[]): Promise<readonly ObjectId[]>;
}

/** Result of {@link computeScope}. */
export interface ComputedScope {
  readonly scope: Scope;
  readonly anomalies: readonly ScopeAnomaly[];
}

const NONE: Scope = Object.freeze({ kind: 'none' });
const PLATFORM: Scope = Object.freeze({ kind: 'platform' });

const empty = (anomaly: ScopeAnomaly): ComputedScope => ({ scope: NONE, anomalies: [anomaly] });

/**
 * Computes the data perimeter of a user from his role (PSA: all; D: his groups; SA: his group;
 * CA: his companies and their places; PA: his places; E: nothing). An unknown role, or a SA, CA or
 * PA without group, has no access; a CA without companies or a PA without places sees nothing; the
 * anomaly is reported.
 *
 * @param user Role and scope ids of the user.
 * @param deps Dealer group and company place lookups.
 * @returns The scope (frozen) and the anomalies found.
 */
export async function computeScope(user: UserScopeView, deps: ComputeScopeDeps): Promise<ComputedScope> {
  if (!isRole(user.role)) {
    return empty('invalidRole');
  }
  switch (user.role) {
    case 'PSA':
      return { scope: PLATFORM, anomalies: [] };
    case 'D': {
      const ids = await deps.listDealerGroupIds(user.userId);
      return { scope: Object.freeze({ kind: 'dealer', groupIds: frozenSet(ids.map((id) => id.toHexString())) }), anomalies: [] };
    }
    case 'E':
      return { scope: NONE, anomalies: [] };
    case 'SA':
    case 'CA':
    case 'PA':
      break;
  }
  const { groupId } = user;
  if (groupId === null) {
    return empty('missingGroup');
  }
  if (user.role === 'SA') {
    return { scope: Object.freeze({ kind: 'group', groupId }), anomalies: [] };
  }
  if (user.role === 'CA') {
    if (user.companyIds.length === 0) {
      return empty('companyAdminWithoutCompanies');
    }
    const placeIds = await deps.listCompanyPlaceIds(groupId, user.companyIds);
    return { scope: Object.freeze({ kind: 'companies', groupId, companyIds: frozenArray(user.companyIds), placeIds: frozenArray(placeIds) }), anomalies: [] };
  }
  return user.placeIds.length === 0
    ? empty('placeAdminWithoutPlaces')
    : { scope: Object.freeze({ kind: 'places', groupId, placeIds: frozenArray(user.placeIds) }), anomalies: [] };
}
