import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { SalesController } from './sales.controller.ts';
import { saleParams, saleQuery, salesQuery, salesSummaryQuery } from './sales.schemas.ts';

/** The URL segment of the sales under `/groups/{groupId}`. */
export const SALES_SEGMENT = 'sales';

/**
 * The sales routes (`doc/Tasks.md` step V1), read only, on every group: the list, the summary (which has to be declared before the detail, so `summary` is not taken for an id) and the detail, all with `sales:read` (the `documents` module of the
 * matrix). The server limits what each role reads: a company administrator the sales of his companies, a place administrator those of his places. Not open to a store key (the default), and not on `/public/v1`.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createSalesRoutes(controller: SalesController): RouteDefinition[] {
  const all = `/groups/:groupId/${SALES_SEGMENT}`;
  const auth = { kind: 'user' as const, permission: 'sales:read' as const, group: true };
  return [
    defineRoute({ method: 'GET', path: all, auth, middleware: [validateQuery(salesQuery)], handler: controller.list }),
    defineRoute({ method: 'GET', path: `${all}/summary`, auth, middleware: [validateQuery(salesSummaryQuery)], handler: controller.summary }),
    defineRoute({ method: 'GET', path: `${all}/:saleId`, auth, middleware: [validateParams(saleParams), validateQuery(saleQuery)], handler: controller.get }),
  ];
}
