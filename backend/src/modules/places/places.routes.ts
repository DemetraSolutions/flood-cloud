import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { PLACES_BODY_LIMIT, PLACES_LARGE_BODY_LIMIT, allPlacesQuery, createPlaceBody, patchPlaceBody, placeParams, placesQuery, putLicenseBody, putOpeningHoursBody } from './places.schemas.ts';
import { SETTING_BLOCKS } from '../../shared/legacy-write/place-settings.ts';
import { required } from '../companies/companies.schemas.ts';
import { LIST_SEGMENTS, listBlockSchema } from './place-lists.schemas.ts';
import { SETTING_SEGMENTS, settingsSchema } from './place-settings.schemas.ts';
import type { PlacesController } from './places.controller.ts';

/**
 * The place routes (`doc/Tasks.md` area 7, steps 7A to 7F), all on a group: the group is verified against the caller's perimeter before the permission, and the service applies the
 * perimeter of the place (a company administrator reaches the places of his companies, a place administrator his own). The compact list is the one the backoffice's reference store reads.
 * Every write of an existing place needs `If-Match`. Creating, trashing and deleting a place are for the PSA, the dealers and the group administrators (`places:trash` and `places:delete` are in the ceiling of those roles only); creating and duplicating (`places:create`) are the PSA's and the dealers'.
 *
 * Creating and duplicating are idempotent: they need the `Idempotency-Key` header (`shared/http/idempotency.ts`).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createPlacesRoutes(controller: PlacesController, idempotency: IdempotencyStore): RouteDefinition[] {
  const group = (permission: 'places:read' | 'places:create' | 'places:update' | 'places:trash' | 'places:delete') => ({ kind: 'user' as const, permission, group: true });
  const one = '/groups/:groupId/places/:placeId';
  const put = (segment: string, handler: PlacesController['replace'][string], body: Parameters<typeof validateBody>[0], bodyLimit = PLACES_BODY_LIMIT): RouteDefinition =>
    defineRoute({
      method: 'PUT',
      path: `${one}/${segment}`,
      auth: group('places:update'),
      bodyLimit,
      middleware: [validateParams(placeParams), requireIfMatch, validateBody(body)],
      handler,
    });
  return [
    // Across groups: a platform route (no group in the path); the service lets only the PSA and the dealers through and applies their perimeter.
    defineRoute({ method: 'GET', path: '/places', auth: { kind: 'user', permission: 'places:read' }, middleware: [validateQuery(allPlacesQuery)], handler: controller.listAll }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/places', auth: group('places:read'), middleware: [validateQuery(placesQuery)], handler: controller.list }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/places', auth: group('places:create'), bodyLimit: PLACES_BODY_LIMIT, middleware: [validateBody(createPlaceBody)], handler: idempotent(idempotency, controller.create) }),
    // The one route a store key may call here: its own place (the server of a point of sale reads its place through the same route the backoffice does).
    defineRoute({ method: 'GET', path: one, auth: { kind: 'user', permission: 'places:read', group: true, store: true }, middleware: [validateParams(placeParams)], handler: controller.get }),
    defineRoute({
      method: 'PATCH',
      path: one,
      auth: group('places:update'),
      bodyLimit: PLACES_LARGE_BODY_LIMIT,
      middleware: [validateParams(placeParams), requireIfMatch, validateBody(patchPlaceBody)],
      handler: controller.update,
    }),
    // The series of the company of the place, for the invoice series choice of the place (a place administrator has no `companies:read`): scoped like the place.
    defineRoute({ method: 'GET', path: `${one}/invoice-series`, auth: group('places:update'), middleware: [validateParams(placeParams)], handler: controller.invoiceSeries }),
    put('license', controller.replace['license']!, putLicenseBody),
    put('opening-hours', controller.replace['openingHours']!, putOpeningHoursBody),
    ...Object.keys(SETTING_BLOCKS).map((name) => put(SETTING_SEGMENTS[name]!, controller.replace[name]!, settingsSchema(name, required))),
    // The lists of items (step 7F): the rooms can carry up to a thousand tables, so their `PUT` has the larger limit.
    ...Object.keys(LIST_SEGMENTS).map((name) => put(LIST_SEGMENTS[name]!, controller.replace[name]!, listBlockSchema(name, required), name === 'rooms' ? PLACES_LARGE_BODY_LIMIT : PLACES_BODY_LIMIT)),
    defineRoute({ method: 'POST', path: `${one}/trash`, auth: group('places:trash'), middleware: [validateParams(placeParams), requireIfMatch], handler: controller.trash }),
    defineRoute({ method: 'POST', path: `${one}/restore`, auth: group('places:trash'), middleware: [validateParams(placeParams), requireIfMatch], handler: controller.restore }),
    defineRoute({ method: 'POST', path: `${one}/duplicate`, auth: group('places:create'), middleware: [validateParams(placeParams)], handler: idempotent(idempotency, controller.duplicate) }),
    defineRoute({ method: 'DELETE', path: one, auth: group('places:delete'), middleware: [validateParams(placeParams), requireIfMatch], handler: controller.remove }),
  ];
}
