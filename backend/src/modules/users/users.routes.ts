import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { UsersController } from './users.controller.ts';
import {
  allUsersQuery,
  createGroupUserBody,
  createPlatformUserBody,
  groupUserParams,
  groupUsersQuery,
  patchGroupUserBody,
  patchPlatformUserBody,
  platformUserParams,
  resetPasswordBody,
  usernameParams,
} from './users.schemas.ts';

/** Body limit of the user writes: the data of a user are some kilobytes (POS grants, shifts) and the picture can be 200 KB, a third more in base64. */
const USERS_BODY_LIMIT = '512kb';

/**
 * The user management routes (`doc/Tasks.md` 3.4). Users of a group live under `/groups/{groupId}/users`,
 * where the group is verified against the caller's perimeter before the permission; platform users
 * (PSA and dealers) under `/users`, which only a PSA manages; `GET /users` is also the transversal list of
 * the PSA and the dealers. Every route declares its permission, and the service applies the perimeter and the
 * anti-escalation rules.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createUsersRoutes(controller: UsersController, rules: RateLimitRules): RouteDefinition[] {
  const group = (permission: 'users:read' | 'users:create' | 'users:update' | 'users:trash' | 'users:delete') => ({ kind: 'user' as const, permission, group: true });
  const platform = (permission: 'users:read' | 'users:create' | 'users:update' | 'users:trash' | 'users:delete') => ({ kind: 'user' as const, permission });
  return [
    defineRoute({ method: 'GET', path: '/groups/:groupId/users', auth: group('users:read'), middleware: [validateQuery(groupUsersQuery)], handler: controller.listGroup }),
    defineRoute({
      method: 'POST',
      path: '/groups/:groupId/users',
      auth: group('users:create'),
      bodyLimit: USERS_BODY_LIMIT,
      rateLimit: [rules.userCredentialsPerUser],
      middleware: [validateBody(createGroupUserBody)],
      handler: controller.create,
    }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/users/:userId', auth: group('users:read'), middleware: [validateParams(groupUserParams)], handler: controller.get }),
    defineRoute({
      method: 'PATCH',
      path: '/groups/:groupId/users/:userId',
      auth: group('users:update'),
      bodyLimit: USERS_BODY_LIMIT,
      middleware: [validateParams(groupUserParams), validateBody(patchGroupUserBody)],
      handler: controller.update,
    }),
    defineRoute({
      method: 'PUT',
      path: '/groups/:groupId/users/:userId/password',
      auth: group('users:update'),
      bodyLimit: '4kb',
      rateLimit: [rules.userCredentialsPerUser],
      middleware: [validateParams(groupUserParams), validateBody(resetPasswordBody)],
      handler: controller.resetPassword,
    }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/users/:userId/trash', auth: group('users:trash'), middleware: [validateParams(groupUserParams)], handler: controller.trash }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/users/:userId/restore', auth: group('users:trash'), middleware: [validateParams(groupUserParams)], handler: controller.restore }),
    defineRoute({ method: 'DELETE', path: '/groups/:groupId/users/:userId', auth: group('users:delete'), middleware: [validateParams(groupUserParams)], handler: controller.remove }),

    defineRoute({ method: 'GET', path: '/users', auth: platform('users:read'), middleware: [validateQuery(allUsersQuery)], handler: controller.listAll }),
    defineRoute({ method: 'POST', path: '/users', auth: platform('users:create'), bodyLimit: USERS_BODY_LIMIT, rateLimit: [rules.userCredentialsPerUser], middleware: [validateBody(createPlatformUserBody)], handler: controller.create }),
    defineRoute({ method: 'GET', path: '/users/:userId', auth: platform('users:read'), middleware: [validateParams(platformUserParams)], handler: controller.get }),
    defineRoute({
      method: 'PATCH',
      path: '/users/:userId',
      auth: platform('users:update'),
      bodyLimit: USERS_BODY_LIMIT,
      middleware: [validateParams(platformUserParams), validateBody(patchPlatformUserBody)],
      handler: controller.update,
    }),
    defineRoute({
      method: 'PUT',
      path: '/users/:userId/password',
      auth: platform('users:update'),
      bodyLimit: '4kb',
      rateLimit: [rules.userCredentialsPerUser],
      middleware: [validateParams(platformUserParams), validateBody(resetPasswordBody)],
      handler: controller.resetPassword,
    }),
    defineRoute({ method: 'POST', path: '/users/:userId/trash', auth: platform('users:trash'), middleware: [validateParams(platformUserParams)], handler: controller.trash }),
    defineRoute({ method: 'POST', path: '/users/:userId/restore', auth: platform('users:trash'), middleware: [validateParams(platformUserParams)], handler: controller.restore }),
    defineRoute({ method: 'DELETE', path: '/users/:userId', auth: platform('users:delete'), middleware: [validateParams(platformUserParams)], handler: controller.remove }),

    defineRoute({
      method: 'GET',
      path: '/usernames/:username/availability',
      auth: platform('users:create'),
      rateLimit: [rules.usernameCheckPerUser],
      middleware: [validateParams(usernameParams)],
      handler: controller.usernameAvailability,
    }),
  ];
}
