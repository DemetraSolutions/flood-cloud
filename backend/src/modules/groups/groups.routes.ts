import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody } from '../../shared/validation/middleware.ts';
import type { GroupsController } from './groups.controller.ts';
import { patchGroupBody } from './groups.schemas.ts';

/** Body limit of the modification of a group: a few hundred bytes of settings. */
const GROUPS_BODY_LIMIT = '16kb';

/**
 * The routes of one group (`doc/Tasks.md` 4.3 and 4.4): the detail, the modification, the suspension and the trash.
 * Every one is a group route, so the group is verified against the caller's perimeter before the permission: a dealer reaches
 * only his groups, a group administrator only his own, a suspended or trashed group only the PSA. Suspension and trash are
 * for the PSA alone, through their own permissions. The list is `GET /groups` of the reference module.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createGroupsRoutes(controller: GroupsController): RouteDefinition[] {
  const group = (permission: 'groups:read' | 'groups:update' | 'groups:suspend' | 'groups:trash') => ({ kind: 'user' as const, permission, group: true });
  return [
    defineRoute({ method: 'GET', path: '/groups/:groupId', auth: group('groups:read'), handler: controller.get }),
    defineRoute({ method: 'PATCH', path: '/groups/:groupId', auth: group('groups:update'), bodyLimit: GROUPS_BODY_LIMIT, middleware: [validateBody(patchGroupBody)], handler: controller.update }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/suspension', auth: group('groups:suspend'), handler: controller.suspend }),
    defineRoute({ method: 'DELETE', path: '/groups/:groupId/suspension', auth: group('groups:suspend'), handler: controller.reactivate }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/trash', auth: group('groups:trash'), handler: controller.trash }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/restore', auth: group('groups:trash'), handler: controller.restore }),
  ];
}
