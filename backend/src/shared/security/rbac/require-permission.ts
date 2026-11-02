import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../../http/errors.ts';
import { hasPermission } from './policy.ts';
import type { Permission } from './permissions.ts';
import type { AuthPrincipal } from '../scope/principal.ts';

/** Called with the outcome of the permission check, before a denial is turned into a 403. */
export type PermissionDecisionHook = (principal: AuthPrincipal, granted: boolean, req: Request, res: Response) => void | Promise<void>;

/**
 * Builds the middleware that enforces a permission. It must run after the authentication
 * middleware (and after the group access check on group routes).
 *
 * @param permission Permission the route requires.
 * @param onDecision Optional hook told the outcome (used to audit cross-group access, so a denied
 * request is recorded as denied and not as an access). If it fails, the request fails.
 * @returns A handler answering `401 UNAUTHENTICATED` when `res.locals.auth` is missing and
 * `403 FORBIDDEN` when the principal lacks the permission; otherwise it continues.
 */
export function requirePermission(permission: Permission, onDecision?: PermissionDecisionHook): RequestHandler {
  return async (req, res, next) => {
    const principal = res.locals.auth;
    if (principal === undefined) {
      throw new AppError('UNAUTHENTICATED');
    }
    const granted = hasPermission(principal, permission);
    if (onDecision !== undefined) {
      await onDecision(principal, granted, req, res);
    }
    if (!granted) {
      throw new AppError('FORBIDDEN');
    }
    next();
  };
}
