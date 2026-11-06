import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { GroupServicesController } from './services.controller.ts';
import { servicesQuery } from './services.schemas.ts';

/**
 * The compact read of the services of a group, for the user form (`serviceIds`). It needs the permission to read users and the `services`
 * feature of the group.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createGroupServicesRoutes(controller: GroupServicesController): RouteDefinition[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/groups/:groupId/services',
      auth: { kind: 'user', permission: 'users:read', group: true, feature: 'services' },
      middleware: [validateQuery(servicesQuery)],
      handler: controller.list,
    }),
  ];
}
