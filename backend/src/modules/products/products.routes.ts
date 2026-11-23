import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { TRASH_BODY_LIMIT, idsBody } from '../trash/trash.schemas.ts';
import type { ProductsController } from './products.controller.ts';
import { PRODUCT_BODY_LIMIT, createProductBody, patchProductBody, productParams, productsQuery } from './products.schemas.ts';

/** The URL segment of the products under `/groups/{groupId}`. */
export const PRODUCTS_SEGMENT = 'products';

/**
 * The product routes (`doc/Tasks.md` step C3), on every group (no feature of the group is needed for the products themselves; a field of a function the group lacks is refused one by one): `GET` list and detail
 * with `products:read`; the creation, the modification (`If-Match`), the duplication, the trash and the restore (`If-Match`), the bulk trash and the deletion of a product in the trash (`If-Match`) with
 * `products:update`. The creation and the duplication are idempotent (`Idempotency-Key`). Not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createProductsRoutes(controller: ProductsController, idempotency: IdempotencyStore): RouteDefinition[] {
  const all = `/groups/:groupId/${PRODUCTS_SEGMENT}`;
  const one = `${all}/:productId`;
  const auth = (permission: 'products:read' | 'products:update') => ({ kind: 'user' as const, permission, group: true });
  return [
    defineRoute({ method: 'GET', path: all, auth: auth('products:read'), middleware: [validateQuery(productsQuery)], handler: controller.list }),
    defineRoute({ method: 'POST', path: all, auth: auth('products:update'), bodyLimit: PRODUCT_BODY_LIMIT, middleware: [validateBody(createProductBody)], handler: idempotent(idempotency, controller.create) }),
    defineRoute({ method: 'POST', path: `${all}/trash`, auth: auth('products:update'), bodyLimit: TRASH_BODY_LIMIT, middleware: [validateBody(idsBody)], handler: controller.trashMany }),
    defineRoute({ method: 'GET', path: one, auth: auth('products:read'), middleware: [validateParams(productParams)], handler: controller.get }),
    defineRoute({ method: 'PATCH', path: one, auth: auth('products:update'), bodyLimit: PRODUCT_BODY_LIMIT, middleware: [validateParams(productParams), requireIfMatch, validateBody(patchProductBody)], handler: controller.update }),
    defineRoute({ method: 'DELETE', path: one, auth: auth('products:update'), middleware: [validateParams(productParams), requireIfMatch], handler: controller.remove }),
    defineRoute({ method: 'POST', path: `${one}/duplicate`, auth: auth('products:update'), middleware: [validateParams(productParams)], handler: idempotent(idempotency, controller.duplicate) }),
    defineRoute({ method: 'POST', path: `${one}/trash`, auth: auth('products:update'), middleware: [validateParams(productParams), requireIfMatch], handler: controller.trash }),
    defineRoute({ method: 'POST', path: `${one}/restore`, auth: auth('products:update'), middleware: [validateParams(productParams), requireIfMatch], handler: controller.restore }),
  ];
}
