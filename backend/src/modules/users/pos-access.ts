import { AppError } from '../../shared/http/errors.ts';
import type { Role } from '../../shared/security/rbac/permissions.ts';
import { AUTOMATIC_CASH_DEVICES, defaultPos, offPos } from './pos.catalog.ts';
import type { Pos, PosGrantsPatch, PosPatch } from './pos.catalog.ts';
import { diffPos } from './pos.mapper.ts';

/**
 * The rules on who may give which POS permission (`doc/Tasks.md` 3.4, anti-escalation applied to the POS data). The POS data have two parts:
 * the app switch and the grants are permissions, the options are interface preferences and free to whoever can modify the user.
 *
 * - Changing a permission needs `canManagePermissions`, as for the other permissions. A new user created by someone without it gets the
 *   default of his role, limited to what the creator can give.
 * - PSA, D and SA can give any POS permission.
 * - CA and PA give only what they have themselves: a flag turns on only if they hold it, the app is enabled only if it is for them, and the
 *   discount cap cannot be raised beyond theirs (no cap is the highest: a creator with a cap can neither remove it nor exceed it).
 */

/** Whether a role is limited to the POS permissions it holds (CA and PA). */
export const isPosLimited = (role: Role): boolean => role === 'CA' || role === 'PA';

/** The one who gives the permissions. */
export interface PosActor {
  readonly role: Role;
  readonly canManagePermissions: boolean;
  /** Reads his own POS data; called only when the rules need them (CA and PA). */
  readonly pos: () => Promise<Pos>;
}

/**
 * The POS data a new user starts with when nobody chose them: the default of the role, limited for a CA or PA creator to the permissions he
 * holds (the discount cap included).
 *
 * @param actorPos POS data of a limited creator, `null` for the others.
 * @param role Role of the new user.
 */
export function inheritedPos(actorPos: Pos | null, role: Role): Pos {
  const base = defaultPos(role);
  if (actorPos === null) {
    return base;
  }
  const flags = Object.fromEntries(Object.entries(base.grants).filter(([, value]) => typeof value === 'boolean').map(([name, value]) => [name, value === true && actorPos.grants[name as keyof Pos['grants'] & string] === true]));
  return {
    ...base,
    enabled: base.enabled && actorPos.enabled,
    grants: { ...base.grants, ...flags, discountMaxPercentage: actorPos.grants.discountMaxPercentage, automaticCash: base.grants.automaticCash },
  };
}

/** The part of a POS patch that is permissions. */
function permissionPart(patch: PosPatch | undefined): PosPatch | undefined {
  if (patch === undefined) {
    return undefined;
  }
  const part: { enabled?: boolean; grants?: PosGrantsPatch } = {};
  if (patch.enabled !== undefined) {
    part.enabled = patch.enabled;
  }
  if (patch.grants !== undefined) {
    part.grants = patch.grants;
  }
  return Object.keys(part).length === 0 ? undefined : part;
}

/**
 * Whether a change of the POS data changes permissions: the app switch or any grant. A change of the options alone (interface preferences)
 * does not. A change of permissions is treated as one of the module flags: security event and end of the sessions (D-11).
 *
 * @param before The POS data before.
 * @param after The POS data after.
 */
export function posPermissionsChanged(before: Pos, after: Pos): boolean {
  return permissionPart(diffPos(before, after)) !== undefined;
}

/**
 * The permission fields a limited actor cannot give: flags he does not hold, the app if it is off for him, and a discount cap above his.
 *
 * @param actor POS data of the actor.
 * @param patch What would change.
 * @param after The data as they would be after.
 * @param checkCap Whether the cap is checked even if it is not in the patch (a creation).
 */
function notHeld(actor: Pos, patch: PosPatch, after: Pos, checkCap: boolean): string[] {
  const refused: string[] = [];
  if (patch.enabled === true && !actor.enabled) {
    refused.push('pos.enabled');
  }
  for (const [name, value] of Object.entries(patch.grants ?? {})) {
    if (name === 'automaticCash') {
      for (const device of AUTOMATIC_CASH_DEVICES) {
        for (const [key, flag] of Object.entries((value as Record<string, Record<string, boolean>>)[device] ?? {})) {
          if (flag && !(actor.grants.automaticCash[device] as Record<string, boolean>)[key]) {
            refused.push(`pos.grants.automaticCash.${device}.${key}`);
          }
        }
      }
    } else if (value === true && actor.grants[name as keyof Pos['grants']] !== true) {
      refused.push(`pos.grants.${name}`);
    }
  }
  const cap = actor.grants.discountMaxPercentage;
  const given = after.grants.discountMaxPercentage;
  if ((checkCap || patch.grants?.discountMaxPercentage !== undefined) && cap !== null && (given === null || given > cap)) {
    refused.push('pos.grants.discountMaxPercentage');
  }
  return refused;
}

/**
 * Checks a creation (`before` is `null`) or a change of the POS data of a user against the rules above.
 *
 * @param actor Who gives the permissions.
 * @param role Role the user has (after the change).
 * @param before The POS data of the user as stored, or `null` for a creation.
 * @param after The POS data as they would be after the operation.
 * @returns `FORBIDDEN` (without details when the actor cannot manage permissions, with a `notAllowed` detail on each field he cannot give), or `null` when the operation is allowed.
 */
export async function posAccessError(actor: PosActor, role: Role, before: Pos | null, after: Pos): Promise<AppError | null> {
  const limited = isPosLimited(actor.role);
  const actorPos = limited ? await actor.pos() : null;
  // What the actor may give without managing permissions: the data as they are, or for a creation the default of the role.
  const allowed = before ?? inheritedPos(actorPos, role);
  if (permissionPart(diffPos(allowed, after)) === undefined) {
    return null;
  }
  if (!actor.canManagePermissions) {
    return new AppError('FORBIDDEN');
  }
  if (actorPos === null) {
    return null;
  }
  // From nothing for a creation, so that the default flags and the ones the request adds are all held by the actor.
  const patch = permissionPart(diffPos(before ?? offPos(), after)) ?? {};
  const refused = notHeld(actorPos, patch, after, before === null);
  return refused.length === 0 ? null : new AppError('FORBIDDEN', { details: refused.map((field) => ({ field, issue: 'notAllowed' })) });
}
