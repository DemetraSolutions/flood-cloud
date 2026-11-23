import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { StoreContextController } from './store-context.controller.ts';

/**
 * The routes that give the server of a point of sale the complete configuration of its group, its company and its place (`doc/Security-Model.md` section 5), all on `/v1` and only for a
 * store key (`403 FORBIDDEN` to a user): no path parameter, the ids come from the store principal alone. The responses carry the credentials of the integrations and of the devices in clear, so
 * they are never compressed. The route builder issues the verified access to the group of the store (`group: true`).
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createStoreContextRoutes(controller: StoreContextController): RouteDefinition[] {
  const read = (path: string, handler: StoreContextController['group']): RouteDefinition =>
    defineRoute({ method: 'GET', path: `/store-context/${path}`, auth: { kind: 'store', group: true }, compress: false, handler });
  return [read('group', controller.group), read('company', controller.company), read('place', controller.place)];
}
