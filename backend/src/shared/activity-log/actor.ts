import type { AuthPrincipal } from '../security/scope/principal.ts';
import type { ActivityActor } from './activity-log.ts';

/**
 * The actor of an activity.
 *
 * @param principal The authenticated caller, or `undefined` for an anonymous request.
 * @returns A `user` actor with id and role, or an `anonymous` one.
 */
export function actorOf(principal: Pick<AuthPrincipal, 'userId' | 'role'> | undefined): ActivityActor {
  return principal === undefined ? { kind: 'anonymous' } : { kind: 'user', id: principal.userId, role: principal.role };
}
