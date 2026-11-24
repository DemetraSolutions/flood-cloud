import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { object } from '../../shared/validation/schema.ts';
import { CATEGORY_BODY_LIMIT } from '../product-categories/categories.schemas.ts';
import { PRODUCT_BODY_LIMIT } from '../products/products.schemas.ts';
import type { PublicCatalogController } from './public-catalog.controller.ts';
import {
  publicAttributeGroupParams,
  publicBrandParams,
  publicCategoryParams,
  publicChangesQuery,
  publicCreateCategoryBody,
  publicCreateProductBody,
  publicDepartmentParams,
  publicPatchCategoryBody,
  publicPatchProductBody,
  publicProductParams,
  publicProductsQuery,
  publicStockQuery,
} from './public-catalog.schemas.ts';

/**
 * The catalog routes of the public API (`/public/v1`, `doc/Public-API.md`), all for an integration with a public API key and on the group of the key (the builder issues the verified access). The reads need `catalog:read`:
 * products (a page with `updatedSince`, one, and their stock), categories (a page, the tree, one), brands, groups of attributes and departments (a page with `updatedSince`, one). The writes need `catalog:write`:
 * create, modify, trash and restore a product; create, modify and delete a category. The creations are idempotent (`Idempotency-Key`, bound to the key) and every write declares the limit of the writes per key, which runs
 * before the body is read. The deletion for good of a product, the emptying of the trash, the duplication and any write of the brands, the groups of attributes, the departments and the stock are not here.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param writeLimit The rate limit of the writes per key.
 * @returns The route definitions to mount on `/public/v1`.
 */
export function createPublicCatalogRoutes(controller: PublicCatalogController, idempotency: IdempotencyStore, writeLimit: RateLimitRule): RouteDefinition[] {
  const read = { kind: 'apiKey' as const, permission: 'catalog:read' as const, group: true as const };
  const write = { kind: 'apiKey' as const, permission: 'catalog:write' as const, group: true as const };
  const limited = [writeLimit];
  return [
    defineRoute({ method: 'GET', path: '/products', auth: read, middleware: [validateQuery(publicProductsQuery)], handler: controller.listProducts }),
    defineRoute({ method: 'GET', path: '/stock', auth: read, middleware: [validateQuery(publicStockQuery)], handler: controller.listStock }),
    defineRoute({ method: 'GET', path: '/products/:productId', auth: read, middleware: [validateParams(publicProductParams), validateQuery(object({}))], handler: controller.getProduct }),
    defineRoute({ method: 'GET', path: '/products/:productId/stock', auth: read, middleware: [validateParams(publicProductParams), validateQuery(object({}))], handler: controller.getProductStock }),
    defineRoute({ method: 'POST', path: '/products', auth: write, rateLimit: limited, bodyLimit: PRODUCT_BODY_LIMIT, middleware: [validateBody(publicCreateProductBody)], handler: idempotent(idempotency, controller.createProduct) }),
    defineRoute({ method: 'PATCH', path: '/products/:productId', auth: write, rateLimit: limited, bodyLimit: PRODUCT_BODY_LIMIT, middleware: [validateParams(publicProductParams), requireIfMatch, validateBody(publicPatchProductBody)], handler: controller.updateProduct }),
    defineRoute({ method: 'POST', path: '/products/:productId/trash', auth: write, rateLimit: limited, middleware: [validateParams(publicProductParams), requireIfMatch], handler: controller.trashProduct }),
    defineRoute({ method: 'POST', path: '/products/:productId/restore', auth: write, rateLimit: limited, middleware: [validateParams(publicProductParams), requireIfMatch], handler: controller.restoreProduct }),
    defineRoute({ method: 'GET', path: '/categories', auth: read, middleware: [validateQuery(publicChangesQuery)], handler: controller.listCategories }),
    // The tree comes before the detail: `/tree` would otherwise be read as the id of a category.
    defineRoute({ method: 'GET', path: '/categories/tree', auth: read, middleware: [validateQuery(object({}))], handler: controller.categoryTree }),
    defineRoute({ method: 'GET', path: '/categories/:categoryId', auth: read, middleware: [validateParams(publicCategoryParams), validateQuery(object({}))], handler: controller.getCategory }),
    defineRoute({ method: 'POST', path: '/categories', auth: write, rateLimit: limited, bodyLimit: CATEGORY_BODY_LIMIT, middleware: [validateBody(publicCreateCategoryBody)], handler: idempotent(idempotency, controller.createCategory) }),
    defineRoute({ method: 'PATCH', path: '/categories/:categoryId', auth: write, rateLimit: limited, bodyLimit: CATEGORY_BODY_LIMIT, middleware: [validateParams(publicCategoryParams), requireIfMatch, validateBody(publicPatchCategoryBody)], handler: controller.updateCategory }),
    defineRoute({ method: 'DELETE', path: '/categories/:categoryId', auth: write, rateLimit: limited, middleware: [validateParams(publicCategoryParams)], handler: controller.deleteCategory }),
    defineRoute({ method: 'GET', path: '/brands', auth: read, middleware: [validateQuery(publicChangesQuery)], handler: controller.listBrands }),
    defineRoute({ method: 'GET', path: '/brands/:brandId', auth: read, middleware: [validateParams(publicBrandParams), validateQuery(object({}))], handler: controller.getBrand }),
    defineRoute({ method: 'GET', path: '/attribute-groups', auth: read, middleware: [validateQuery(publicChangesQuery)], handler: controller.listAttributeGroups }),
    defineRoute({ method: 'GET', path: '/attribute-groups/:attributeGroupId', auth: read, middleware: [validateParams(publicAttributeGroupParams), validateQuery(object({}))], handler: controller.getAttributeGroup }),
    defineRoute({ method: 'GET', path: '/departments', auth: read, middleware: [validateQuery(publicChangesQuery)], handler: controller.listDepartments }),
    defineRoute({ method: 'GET', path: '/departments/:departmentId', auth: read, middleware: [validateParams(publicDepartmentParams), validateQuery(object({}))], handler: controller.getDepartment }),
  ];
}
