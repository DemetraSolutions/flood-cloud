import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateParams } from '../../shared/validation/middleware.ts';
import { perUserRule, placeCallParams } from '../place-call.ts';
import type { TshController } from './tsh.controller.ts';

/** Synchronizations per user per hour: each is three calls to the provider. */
export const TSH_SYNCS_PER_USER_HOUR = 20;

/**
 * `POST /v1/groups/{groupId}/places/{placeId}/integrations/tsh/charge-categories/sync`: downloads the categories of charge of the property of a place and stores the copy the place keeps. For who can
 * change the place (`places:update`), on a user token only, conditional on the version of the place (`If-Match`). It has no body: the credentials come from the place.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createTshRoutes(controller: TshController): RouteDefinition[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/groups/:groupId/places/:placeId/integrations/tsh/charge-categories/sync',
      auth: { kind: 'user', permission: 'places:update', group: true },
      rateLimit: [perUserRule('integrations-tsh:user', TSH_SYNCS_PER_USER_HOUR, 3600)],
      middleware: [validateParams(placeCallParams), requireIfMatch],
      handler: controller.sync,
    }),
  ];
}
