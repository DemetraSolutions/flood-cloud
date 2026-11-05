import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody, validateParams } from '../../shared/validation/middleware.ts';
import type { MeController } from './me.controller.ts';
import { changePasswordBody, patchMeBody, sessionParams } from './me.schemas.ts';

/** Body limit of the `/v1/me` writes. */
const ME_BODY_LIMIT = '8kb';

/**
 * The routes of the authenticated user on his own account. They need no permission beyond the
 * catalog ones every backoffice user holds on his own account: `profile:read` to read the profile and
 * list the sessions, `profile:update` to edit the profile and change the password, `sessions:revoke` to end sessions.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createMeRoutes(controller: MeController, rules: RateLimitRules): RouteDefinition[] {
  return [
    defineRoute({ method: 'GET', path: '/me', auth: { kind: 'user', permission: 'profile:read', allowWithPendingPasswordChange: true }, handler: controller.get }),
    defineRoute({
      method: 'PATCH',
      path: '/me',
      auth: { kind: 'user', permission: 'profile:update' },
      bodyLimit: ME_BODY_LIMIT,
      middleware: [validateBody(patchMeBody)],
      handler: controller.patch,
    }),
    defineRoute({
      method: 'PUT',
      path: '/me/password',
      auth: { kind: 'user', permission: 'profile:update', allowWithPendingPasswordChange: true },
      bodyLimit: ME_BODY_LIMIT,
      rateLimit: [rules.passwordChangePerUser],
      middleware: [validateBody(changePasswordBody)],
      handler: controller.changePassword,
    }),
    defineRoute({ method: 'GET', path: '/me/sessions', auth: { kind: 'user', permission: 'profile:read' }, handler: controller.listSessions }),
    defineRoute({
      method: 'DELETE',
      path: '/me/sessions/:sessionId',
      auth: { kind: 'user', permission: 'sessions:revoke' },
      middleware: [validateParams(sessionParams)],
      handler: controller.revokeSession,
    }),
  ];
}
