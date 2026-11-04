import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody } from '../../shared/validation/middleware.ts';
import { loginBody, refreshBody } from './auth.schemas.ts';
import type { AuthController } from './auth.controller.ts';

/** Body limit of the login and refresh routes: a few KB is plenty for a username, a password or a token. */
export const AUTH_BODY_LIMIT = '4kb';

/**
 * The routes of `/v1/auth`. Login and refresh are anonymous by nature and rate limited per IP before
 * the parser (login also per username after it); both return tokens, so their responses are never compressed.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createAuthRoutes(controller: AuthController, rules: RateLimitRules): RouteDefinition[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/auth/login',
      auth: { kind: 'anonymous', reason: 'obtains the credentials for the other routes' },
      bodyLimit: AUTH_BODY_LIMIT,
      rateLimit: [rules.loginPerIp, rules.loginPerUsername],
      compress: false,
      middleware: [validateBody(loginBody)],
      handler: controller.login,
    }),
    defineRoute({
      method: 'POST',
      path: '/auth/refresh',
      auth: { kind: 'anonymous', reason: 'the refresh token is the credential' },
      bodyLimit: AUTH_BODY_LIMIT,
      rateLimit: [rules.refreshPerIp],
      compress: false,
      middleware: [validateBody(refreshBody)],
      handler: controller.refresh,
    }),
    defineRoute({ method: 'POST', path: '/auth/logout', auth: { kind: 'user', permission: 'sessions:revoke' }, handler: controller.logout }),
    defineRoute({ method: 'POST', path: '/auth/logout-all', auth: { kind: 'user', permission: 'sessions:revoke' }, handler: controller.logoutAll }),
  ];
}
