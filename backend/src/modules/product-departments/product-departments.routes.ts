import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { EntityController } from '../product-catalog/entity.controller.ts';
import { createEntityRoutes } from '../product-catalog/entity.routes.ts';
import { createDepartmentBody, departmentsQuery, patchDepartmentBody } from './product-departments.schemas.ts';

/**
 * The department routes (`doc/Tasks.md` step C1), on a group that has the `cash` feature (otherwise `403 FEATURE_DISABLED`, whatever the role): `GET` list and detail with `products:read`; `POST`, `PATCH`
 * (`If-Match`) and `DELETE` with `products:update`. The creation is idempotent (`Idempotency-Key`). Not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createProductDepartmentsRoutes(controller: EntityController, idempotency: IdempotencyStore): RouteDefinition[] {
  return createEntityRoutes(controller, idempotency, { segment: 'product-departments', feature: 'cash', query: departmentsQuery, create: createDepartmentBody, patch: patchDepartmentBody });
}
