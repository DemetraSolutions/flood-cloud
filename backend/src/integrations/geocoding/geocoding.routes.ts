import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams } from '../../shared/validation/middleware.ts';
import { perUserRule, placeCallParams } from '../place-call.ts';
import type { GeocodingController } from './geocoding.controller.ts';
import { GEOCODING_BODY_LIMIT, geocodingBody } from './geocoding.schemas.ts';

/** Geocodings per user per minute. */
export const GEOCODINGS_PER_USER_MINUTE = 20;

/** Geocodings per user per day. */
export const GEOCODINGS_PER_USER_DAY = 200;

/**
 * `POST /v1/groups/{groupId}/places/{placeId}/geocoding`: the coordinates of the address of the form of a place. For who can change the place (`places:update`), on a user token only. It saves nothing:
 * the browser never calls the provider and never holds its key. The platform's daily cap is applied by the service, on the calls that are really made.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createGeocodingRoutes(controller: GeocodingController): RouteDefinition[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/groups/:groupId/places/:placeId/geocoding',
      auth: { kind: 'user', permission: 'places:update', group: true },
      bodyLimit: GEOCODING_BODY_LIMIT,
      rateLimit: [perUserRule('integrations-geocoding:user', GEOCODINGS_PER_USER_MINUTE), perUserRule('integrations-geocoding-day:user', GEOCODINGS_PER_USER_DAY, 86_400)],
      middleware: [validateParams(placeCallParams), validateBody(geocodingBody)],
      handler: controller.geocode,
    }),
  ];
}
