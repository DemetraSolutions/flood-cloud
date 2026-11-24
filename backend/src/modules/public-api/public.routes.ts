import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { PublicController } from './public.controller.ts';
import { companyParams, noQuery, placeParams, publicListQuery } from './public.schemas.ts';

/**
 * The routes of the public API (`/public/v1`, `doc/Public-API.md`), all read only and all for an integration authenticated with a public API key (`X-Api-Key`). Every route declares the permission of the public
 * catalog it needs (`GET /me` declares `null`: every valid key may call it); the per-key rate limit and the daily quota are the authentication's own.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/public/v1`.
 */
export function createPublicRoutes(controller: PublicController): RouteDefinition[] {
  const key = (permission: 'places:read' | 'companies:read' | 'catalog:read' | null) => ({ kind: 'apiKey' as const, permission });
  return [
    defineRoute({ method: 'GET', path: '/me', auth: key(null), middleware: [validateQuery(noQuery)], handler: controller.me }),
    defineRoute({ method: 'GET', path: '/places', auth: key('places:read'), middleware: [validateQuery(publicListQuery)], handler: controller.places }),
    defineRoute({ method: 'GET', path: '/places/:placeId', auth: key('places:read'), middleware: [validateParams(placeParams), validateQuery(noQuery)], handler: controller.place }),
    defineRoute({ method: 'GET', path: '/companies', auth: key('companies:read'), middleware: [validateQuery(publicListQuery)], handler: controller.companies }),
    defineRoute({ method: 'GET', path: '/companies/:companyId', auth: key('companies:read'), middleware: [validateParams(companyParams), validateQuery(noQuery)], handler: controller.company }),
    defineRoute({ method: 'GET', path: '/price-lists', auth: key('catalog:read'), middleware: [validateQuery(noQuery)], handler: controller.priceLists }),
    defineRoute({ method: 'GET', path: '/taxes', auth: key('catalog:read'), middleware: [validateQuery(noQuery)], handler: controller.taxes }),
    defineRoute({ method: 'GET', path: '/currencies', auth: key('catalog:read'), middleware: [validateQuery(noQuery)], handler: controller.currencies }),
    defineRoute({ method: 'GET', path: '/measure-units', auth: key('catalog:read'), middleware: [validateQuery(noQuery)], handler: controller.measureUnits }),
  ];
}
