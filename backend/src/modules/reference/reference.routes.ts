import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { ReferenceController } from './reference.controller.ts';
import { groupsQuery, placesQuery } from './reference.schemas.ts';

/**
 * The read-only reference lists of the backoffice: groups, the countries and the places of a group (the companies have their own module, `companies`). They feed
 * the selectors of the user management (group and places of a user's scope).
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createReferenceRoutes(controller: ReferenceController): RouteDefinition[] {
  return [
    defineRoute({ method: 'GET', path: '/groups', auth: { kind: 'user', permission: 'groups:read' }, middleware: [validateQuery(groupsQuery)], handler: controller.listGroups }),
    // Every authenticated user reads the countries (the catalog's always-granted permission): they are public data of the platform, the same for everybody.
    defineRoute({ method: 'GET', path: '/countries', auth: { kind: 'user', permission: 'profile:read' }, handler: controller.listCountries }),
    defineRoute({
      method: 'GET',
      path: '/groups/:groupId/places',
      auth: { kind: 'user', permission: 'places:read', group: true },
      middleware: [validateQuery(placesQuery)],
      handler: controller.listPlaces,
    }),
  ];
}
