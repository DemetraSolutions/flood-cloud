import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { LookupController } from './lookup.controller.ts';
import { lookupProductsQuery, lookupQuery } from './lookup.schemas.ts';

/**
 * The compact reads (`id` and name, search and cursor pagination) of the group catalogs the favorites and promotions selectors need. They need
 * `products:read` (the permission of favorites and promotions, which are what use them) and no feature of the group, and are read only.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createLookupRoutes(controller: LookupController): RouteDefinition[] {
  const auth = { kind: 'user', permission: 'products:read', group: true } as const;
  return [
    defineRoute({ method: 'GET', path: '/groups/:groupId/lookup/products', auth, middleware: [validateQuery(lookupProductsQuery)], handler: controller.products }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/lookup/product-categories', auth, middleware: [validateQuery(lookupQuery)], handler: controller.categories }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/lookup/customers', auth, middleware: [validateQuery(lookupQuery)], handler: controller.customers }),
    defineRoute({ method: 'GET', path: '/groups/:groupId/lookup/contact-groups', auth, middleware: [validateQuery(lookupQuery)], handler: controller.contactGroups }),
  ];
}
