import type { RequestHandler } from 'express';
import { AppError } from '../../http/errors.ts';
import type { Permission } from '../rbac/permissions.ts';

/**
 * The refusal of every route that does not declare `store: true` (or `auth: { kind: 'store' }`) to a caller who authenticated with a store key: the credential is valid, the route is not for
 * it, so `403 FORBIDDEN` before anything else runs. This is the default for every route there is: a store reaches only what was opened to it, one route at a time.
 */
export const refuseStore: RequestHandler = (_req, res, next) => {
  if (res.locals.store !== undefined) {
    throw new AppError('FORBIDDEN');
  }
  next();
};

/** The guard of the routes only a store may call (`auth: { kind: 'store' }`): a request without a store principal (a user, say) is `403 FORBIDDEN`. */
export const requireStore: RequestHandler = (_req, res, next) => {
  if (res.locals.store === undefined) {
    throw new AppError('FORBIDDEN');
  }
  next();
};

/** The text of an id as the validation of the ids accepts it. */
const OBJECT_ID_TEXT = /^[0-9a-fA-F]{24}$/;

/**
 * Builds the check of the path parameters of a route only a store may call: each one must be the text of an id (24 hexadecimal characters), `422 VALIDATION_ERROR` (`format`) otherwise, before anything
 * else of the route runs. The route builder puts it in front of every store route that declares `params`, so a store route never reads a path value that was not checked for its shape.
 *
 * @param names The names of the path parameters the route declares.
 * @returns The handler.
 */
export function requireStoreParams(names: readonly string[]): RequestHandler {
  return (req, _res, next) => {
    const malformed = names.filter((name) => !OBJECT_ID_TEXT.test(String(req.params[name])));
    if (malformed.length > 0) {
      throw new AppError('VALIDATION_ERROR', { details: malformed.map((field) => ({ field, issue: 'format' })) });
    }
    next();
  };
}

/**
 * Restricts a route on `/groups/:groupId/places/:placeId` to the place of the store key: any other place (of the same group or not) is the same `404` as one that does not exist.
 * It runs before the validation of the parameters, so the raw value is compared with the id of the place as 24 lower case hexadecimal characters.
 */
export const requireStorePlace: RequestHandler = (req, res, next) => {
  const store = res.locals.store;
  if (store === undefined) {
    throw new AppError('UNAUTHENTICATED');
  }
  if (req.params['placeId'] !== store.placeId.toHexString()) {
    throw new AppError('NOT_FOUND');
  }
  next();
};

/**
 * Builds the permission check of a store: the permission of the route must be in the fixed profile of the store (`STORE_PROFILE`, carried by the principal).
 *
 * @param permission The permission the route declares.
 * @returns The handler: `401 UNAUTHENTICATED` without a store principal, `403 FORBIDDEN` when the profile does not hold the permission.
 */
export function requireStorePermission(permission: Permission): RequestHandler {
  return (_req, res, next) => {
    const store = res.locals.store;
    if (store === undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    if (!store.permissions.has(permission)) {
      throw new AppError('FORBIDDEN');
    }
    next();
  };
}
