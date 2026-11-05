import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { ReferenceController } from './reference.controller.ts';
import { companiesQuery, groupsQuery, placesQuery } from './reference.schemas.ts';

/**
 * The read-only reference lists of the backoffice: groups, and the companies and places of a group. They feed
 * the selectors of the user management (group, companies and places of a user's scope).
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createReferenceRoutes(controller: ReferenceController): RouteDefinition[] {
  return [
    defineRoute({ method: 'GET', path: '/groups', auth: { kind: 'user', permission: 'groups:read' }, middleware: [validateQuery(groupsQuery)], handler: controller.listGroups }),
    defineRoute({
      method: 'GET',
      path: '/groups/:groupId/companies',
      auth: { kind: 'user', permission: 'companies:read', group: true },
      middleware: [validateQuery(companiesQuery)],
      handler: controller.listCompanies,
    }),
    defineRoute({
      method: 'GET',
      path: '/groups/:groupId/places',
      auth: { kind: 'user', permission: 'places:read', group: true },
      middleware: [validateQuery(placesQuery)],
      handler: controller.listPlaces,
    }),
  ];
}
