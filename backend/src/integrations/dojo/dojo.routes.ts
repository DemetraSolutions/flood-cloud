import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateParams } from '../../shared/validation/middleware.ts';
import { perUserRule, placeCallParams } from '../place-call.ts';
import type { DojoController } from './dojo.controller.ts';

/** Lists of terminals per user per hour: each is a call to the provider with the key of a place. */
export const DOJO_TERMINALS_PER_USER_HOUR = 30;

/**
 * `GET /v1/groups/{groupId}/places/{placeId}/integrations/dojo/terminals`: the terminals of the Dojo account of a place, to show next to the field where the staff copies the identifier of one. For who can
 * change the place (`places:update`), on a user token only (never a store key, never an API key). The key comes from the place, never from the request.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createDojoRoutes(controller: DojoController): RouteDefinition[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/groups/:groupId/places/:placeId/integrations/dojo/terminals',
      auth: { kind: 'user', permission: 'places:update', group: true },
      rateLimit: [perUserRule('integrations-dojo:user', DOJO_TERMINALS_PER_USER_HOUR, 3600)],
      middleware: [validateParams(placeCallParams)],
      handler: controller.terminals,
    }),
  ];
}
