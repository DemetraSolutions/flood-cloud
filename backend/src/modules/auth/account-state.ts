import { ObjectId } from 'mongodb';
import type { GroupsRepository } from '../../shared/security/scope/groups.repository.ts';
import type { User } from '../users/user.types.ts';

/** Why an account cannot use the backoffice right now; recorded in the activity log, never shown to the client. */
export type AccountDenial = 'userMissing' | 'roleNotAllowed' | 'userDisabled' | 'userTrashed' | 'groupMissing' | 'groupUnavailable';

/** Roles that may sign in to the backoffice: `E` operates through the point-of-sale server only (D-07). */
const BACKOFFICE_ROLES: ReadonlySet<string> = new Set(['PSA', 'D', 'SA', 'CA', 'PA']);

/** Roles that belong to one group and are therefore subject to its state. */
const GROUP_ROLES: ReadonlySet<string> = new Set(['SA', 'CA', 'PA']);

/**
 * Decides whether an account may sign in or keep a session: the same rule at login, at refresh and
 * on every request. The user must exist, have a backoffice role (not `E`, not a retired or unknown
 * role such as `API`), be active and not trashed; a SA, CA or PA also needs a group that exists and
 * is neither suspended nor trashed (a group-less one is corrupt data and gets no access).
 *
 * @param user The stored user, or `null` when it no longer exists.
 * @param groups Group lookup.
 * @returns `null` when the account is allowed, otherwise the reason.
 */
export async function checkAccount(user: User | null, groups: GroupsRepository): Promise<AccountDenial | null> {
  if (user === null) {
    return 'userMissing';
  }
  if (!BACKOFFICE_ROLES.has(user.role)) {
    return 'roleNotAllowed';
  }
  if (user.status !== 'active') {
    return 'userDisabled';
  }
  if (user.trashed) {
    return 'userTrashed';
  }
  if (GROUP_ROLES.has(user.role)) {
    if (user.groupId === null) {
      return 'groupMissing';
    }
    const availability = await groups.findAvailability(ObjectId.createFromHexString(user.groupId));
    if (availability === null) {
      return 'groupMissing';
    }
    return availability === 'available' ? null : 'groupUnavailable';
  }
  return null;
}
