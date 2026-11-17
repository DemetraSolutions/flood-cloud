import type { RequestHandler } from 'express';
import type { Permission } from '../../shared/security/rbac/permissions.ts';
import { validate, array, enumOf, object, objectId, optional } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/** Body limit of the bulk routes: at most 100 ids of 24 characters. */
export const TRASH_BODY_LIMIT = '8kb';

/** Most ids a restore or a deletion may name in one call. */
export const MAX_TRASH_IDS = 100;

/** Most items one call of the emptying deletes: the backoffice repeats the call while items remain. */
export const EMPTY_BATCH_SIZE = 200;

/** The kinds of the trash of a group, in the order of the tabs. The groups have their own route: they are platform-wide and are never deleted. */
export const TRASH_KINDS = Object.freeze(['companies', 'places', 'users'] as const);

/** A kind of item that can be in the trash of a group. */
export type TrashKind = (typeof TRASH_KINDS)[number];

/** The permission each operation needs on each kind: restoring is `<kind>:trash`, deleting is `<kind>:delete`, the ones of the single-item routes. */
export const KIND_PERMISSIONS: Readonly<Record<'restore' | 'delete', Readonly<Record<TrashKind, Permission>>>> = Object.freeze({
  restore: Object.freeze({ companies: 'companies:trash', places: 'places:trash', users: 'users:trash' }),
  delete: Object.freeze({ companies: 'companies:delete', places: 'places:delete', users: 'users:delete' }),
});

/** Path parameters of the routes of a group's trash: an unknown kind is a `422`. */
export const trashParams = object({ kind: enumOf(TRASH_KINDS) }, { allowUnknown: true });

/** Middleware of the routes that name their kind in the path: the kind is the one of the route, and goes where the validated parameters of the other routes go. */
export function fixedKind(kind: TrashKind): RequestHandler {
  return (_req, res, next) => {
    res.locals.input = { ...res.locals.input, params: { kind } satisfies TrashParams };
    next();
  };
}

/** Validated path parameters. */
export type TrashParams = Infer<typeof trashParams>;

/** Body of a bulk restore or deletion: 1 to 100 ids, nothing else. Duplicates are removed by the service. */
export const idsBody = object({ ids: array(objectId(), { min: 1, max: MAX_TRASH_IDS }) });

/** Validated body of a bulk restore or deletion. */
export type IdsBody = Infer<typeof idsBody>;

/** The body of the emptying: none, an empty object, or the cursor `after` of the previous call. */
export const emptyBody = object({ after: optional(objectId()) });

/** Validated body of the emptying. */
export type EmptyBody = Infer<typeof emptyBody>;

/**
 * Middleware of the emptying: the body is optional. A request without a body is the same as `{}`; `{ after }` is the cursor; anything else is a `422` (`unknown` on another key, `format` on
 * a malformed `after`, `type` on a non-object). The validated body goes in `res.locals.input`.
 */
export const parseEmptyBody: RequestHandler = (req, res, next) => {
  res.locals.input = { ...res.locals.input, body: validate(emptyBody, req.body === undefined ? {} : req.body, '(body)') };
  next();
};
