import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { ReferenceController } from './reference.controller.ts';
import { groupsQuery } from './reference.schemas.ts';

/**
 * The read-only reference lists of the backoffice: groups and the countries (the companies and the places have their own modules, `companies` and `places`). They feed
 * the selectors of the user management.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createReferenceRoutes(controller: ReferenceController): RouteDefinition[] {
  return [
    defineRoute({ method: 'GET', path: '/groups', auth: { kind: 'user', permission: 'groups:read' }, middleware: [validateQuery(groupsQuery)], handler: controller.listGroups }),
    // Every authenticated user reads the countries (the catalog's always-granted permission): they are public data of the platform, the same for everybody.
    defineRoute({ method: 'GET', path: '/countries', auth: { kind: 'user', permission: 'profile:read' }, handler: controller.listCountries }),
  ];
}
