import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { StoreContextController } from './store-context.controller.ts';
import { storeUsersQuery } from './store-context.users.ts';

/**
 * The routes that give the server of a point of sale the complete configuration of its group, its company and its place, and the countries (`doc/Security-Model.md` section 5), all on `/v1` and only for a
 * store key (`403 FORBIDDEN` to a user): no path parameter, the ids come from the store principal alone. The responses carry the credentials of the integrations and of the devices in clear, so
 * they are never compressed. The route builder issues the verified access to the group of the store (`group: true`).
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createStoreContextRoutes(controller: StoreContextController): RouteDefinition[] {
  const read = (path: string, handler: StoreContextController['group']): RouteDefinition =>
    defineRoute({ method: 'GET', path: `/store-context/${path}`, auth: { kind: 'store', group: true }, compress: false, handler });
  return [
    read('group', controller.group),
    read('company', controller.company),
    read('place', controller.place),
    // The users of the place carry PINs: never compressed, a page at a time (`limit` and `cursor` only).
    defineRoute({ method: 'GET', path: '/store-context/users', auth: { kind: 'store', group: true }, compress: false, middleware: [validateQuery(storeUsersQuery)], handler: controller.users }),
    // Platform data, not group data: no group access, no credentials, so the default compression applies.
    defineRoute({ method: 'GET', path: '/store-context/countries', auth: { kind: 'store' }, handler: controller.countries }),
  ];
}
