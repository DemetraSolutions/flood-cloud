import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import type { EntityController } from '../product-catalog/entity.controller.ts';
import { createEntityRoutes } from '../product-catalog/entity.routes.ts';
import { attributeGroupsQuery, createAttributeGroupBody, patchAttributeGroupBody } from './product-attribute-groups.schemas.ts';

/**
 * The routes of the groups of attributes (`doc/Tasks.md` step C1): `GET` list and detail with `products:read`; `POST`, `PATCH` (`If-Match`) and `DELETE` with `products:update`. The creation is
 * idempotent (`Idempotency-Key`). They have no feature and no perimeter: whoever updates the products of the group changes them. Not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createProductAttributeGroupsRoutes(controller: EntityController, idempotency: IdempotencyStore): RouteDefinition[] {
  return createEntityRoutes(controller, idempotency, { segment: 'product-attribute-groups', query: attributeGroupsQuery, create: createAttributeGroupBody, patch: patchAttributeGroupBody });
}
