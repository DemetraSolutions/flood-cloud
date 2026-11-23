import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import { object } from '../../shared/validation/schema.ts';
import { createEntityRoutes } from '../product-catalog/entity.routes.ts';
import type { CategoriesController } from './categories.controller.ts';
import { CATEGORY_BODY_LIMIT, categoriesQuery, createCategoryBody, patchCategoryBody } from './categories.schemas.ts';

/** The URL segment of the categories under `/groups/{groupId}`. */
export const CATEGORIES_SEGMENT = 'product-categories';

/**
 * The category routes (`doc/Tasks.md` step C2), on every group (no feature of the group is needed for the categories themselves): `GET` list, tree and detail with `products:read`; `POST`, `PATCH`
 * (`If-Match`) and `DELETE` with `products:update`. The creation is idempotent (`Idempotency-Key`). Not open to a store key (the default). The tree comes first: `/tree` would otherwise be read as the id of a category.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createProductCategoriesRoutes(controller: CategoriesController, idempotency: IdempotencyStore): RouteDefinition[] {
  return [
    defineRoute({
      method: 'GET',
      path: `/groups/:groupId/${CATEGORIES_SEGMENT}/tree`,
      auth: { kind: 'user', permission: 'products:read', group: true },
      middleware: [validateQuery(object({}))],
      handler: controller.tree,
    }),
    ...createEntityRoutes(controller, idempotency, { segment: CATEGORIES_SEGMENT, query: categoriesQuery, create: createCategoryBody, patch: patchCategoryBody, bodyLimit: CATEGORY_BODY_LIMIT }),
  ];
}
