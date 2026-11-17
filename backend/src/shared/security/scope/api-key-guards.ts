import type { RequestHandler } from 'express';
import { AppError } from '../../http/errors.ts';
import type { PublicPermission } from '../rbac/public-permissions.ts';

/**
 * Builds the guard of a route of the public surface: the API key authentication must have set the principal (else `401 UNAUTHENTICATED`, which cannot happen
 * through the route builder and is the deny-by-default net) and, when the route needs a permission, the key must hold it (else `403 FORBIDDEN`).
 *
 * @param permission The permission of the public catalog the key must hold, or `null` for a route every valid key may call (`GET /me`).
 * @returns The handler.
 */
export function requireApiKeyPermission(permission: PublicPermission | null): RequestHandler {
  return (_req, res, next) => {
    const principal = res.locals.apiKey;
    if (principal === undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    if (permission !== null && !principal.permissions.has(permission)) {
      throw new AppError('FORBIDDEN');
    }
    next();
  };
}
