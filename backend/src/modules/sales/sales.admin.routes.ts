import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { SalesAdminController } from './sales.admin.controller.ts';
import { SALES_SEGMENT } from './sales.routes.ts';
import { saleParams, saleQuery } from './sales.schemas.ts';
import { SALE_BODY_LIMIT, adminCancelSaleBody, adminCreateSaleBody, adminPatchSaleBody, adminRefundSaleBody } from './sales.write.schemas.ts';

/**
 * The write routes of the sales for the backoffice (`doc/Tasks.md` step VS4b), on every group, beside the reads of {@link createSalesRoutes}: the creation (`sales:write`, idempotent: `Idempotency-Key` is required, besides the natural key
 * `timestampId`), the amendment, the refunds and the cancellation (`sales:write`, `If-Match` required) and the definitive deletion of a sale that is not fiscal (`sales:delete`, `If-Match` required, `nonFiscal=include` required: without it the
 * sale is not found). A company administrator writes on the sales of his companies, a place administrator on those of his places; the server decides it, never the request. Not open to a store key (the default), which has its own routes.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createSalesAdminRoutes(controller: SalesAdminController, idempotency: IdempotencyStore): RouteDefinition[] {
  const all = `/groups/:groupId/${SALES_SEGMENT}`;
  const one = `${all}/:saleId`;
  const write = { kind: 'user' as const, permission: 'sales:write' as const, group: true as const };
  const erase = { kind: 'user' as const, permission: 'sales:delete' as const, group: true as const };
  const target = [validateParams(saleParams), validateQuery(saleQuery), requireIfMatch];
  return [
    defineRoute({ method: 'POST', path: all, auth: write, bodyLimit: SALE_BODY_LIMIT, middleware: [validateBody(adminCreateSaleBody)], handler: idempotent(idempotency, controller.create) }),
    defineRoute({ method: 'PATCH', path: one, auth: write, bodyLimit: SALE_BODY_LIMIT, middleware: [...target, validateBody(adminPatchSaleBody)], handler: controller.amend }),
    defineRoute({ method: 'POST', path: `${one}/refunds`, auth: write, bodyLimit: SALE_BODY_LIMIT, middleware: [...target, validateBody(adminRefundSaleBody)], handler: controller.refund }),
    defineRoute({ method: 'POST', path: `${one}/cancellation`, auth: write, bodyLimit: SALE_BODY_LIMIT, middleware: [...target, validateBody(adminCancelSaleBody)], handler: controller.cancel }),
    defineRoute({ method: 'DELETE', path: one, auth: erase, middleware: target, handler: controller.remove }),
  ];
}
