import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { object } from '../../shared/validation/schema.ts';
import type { PublicSalesController } from './public-sales.controller.ts';
import { publicSaleParams, publicSalesQuery } from './public-sales.schemas.ts';

/**
 * The sales routes of the public API (`/public/v1`, `doc/Public-API.md`), read only, for an integration with a public API key and on the group of the key (the builder issues the verified access): the list (a page, with filters) and one sale,
 * both with `sales:read`. There is no write, and no route for the sales that are not fiscal.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/public/v1`.
 */
export function createPublicSalesRoutes(controller: PublicSalesController): RouteDefinition[] {
  const read = { kind: 'apiKey' as const, permission: 'sales:read' as const, group: true as const };
  return [
    defineRoute({ method: 'GET', path: '/sales', auth: read, middleware: [validateQuery(publicSalesQuery)], handler: controller.list }),
    defineRoute({ method: 'GET', path: '/sales/:saleId', auth: read, middleware: [validateParams(publicSaleParams), validateQuery(object({}))], handler: controller.get }),
  ];
}
