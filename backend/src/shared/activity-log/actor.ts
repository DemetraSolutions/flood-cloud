import type { Response } from 'express';
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

/**
 * The actor of the request a response belongs to: the store (by the id of its store key) when the request authenticated with a store key, the user when it authenticated as one, anonymous otherwise.
 *
 * @param res The response, whose locals hold the principal.
 */
export function responseActorOf(res: Response): ActivityActor {
  return res.locals.store === undefined ? actorOf(res.locals.auth) : { kind: 'store', id: res.locals.store.keyId };
}
