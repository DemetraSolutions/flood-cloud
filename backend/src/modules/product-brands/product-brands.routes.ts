import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { EntityController } from '../product-catalog/entity.controller.ts';
import { createEntityRoutes } from '../product-catalog/entity.routes.ts';
import { brandsQuery, createBrandBody, patchBrandBody } from './product-brands.schemas.ts';

/**
 * The brand routes (`doc/Tasks.md` step C1): `GET` list and detail with `products:read`; `POST`, `PATCH` (`If-Match`) and `DELETE` with `products:update`. The creation is idempotent
 * (`Idempotency-Key`). Not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createProductBrandsRoutes(controller: EntityController, idempotency: IdempotencyStore): RouteDefinition[] {
  return createEntityRoutes(controller, idempotency, { segment: 'product-brands', query: brandsQuery, create: createBrandBody, patch: patchBrandBody });
}
