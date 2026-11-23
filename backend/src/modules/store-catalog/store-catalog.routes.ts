import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { object } from '../../shared/validation/schema.ts';
import { CATEGORY_BODY_LIMIT, storeCreateCategoryBody, storePatchCategoryBody } from '../product-categories/categories.schemas.ts';
import { PRODUCT_BODY_LIMIT, storeCreateProductBody, storePatchProductBody } from '../products/products.schemas.ts';
import type { StoreCatalogController } from './store-catalog.controller.ts';
import type { RequestHandler } from 'express';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { storeCategoriesQuery, storeCategoryParams, storeDepartmentsQuery, storeProductParams, storeProductsQuery } from './store-catalog.schemas.ts';

/** The path of the catalog of a store, under `/v1`. */
export const STORE_CATALOG_PATH = '/store-context/catalog';

/**
 * The catalog routes of the server of a point of sale (`doc/Store-API.md`), all on `/v1` and only for a store key (`403 FORBIDDEN` to a user), on routes of their own: none of the routes of the backoffice
 * catalog is opened to a store key. The group, the company and the place are the ones of the key (the builder issues the verified access to the group of the store). The reads need nothing else; the
 * writes declare the `operator` check, which the builder runs before the body is read. The deletion for good of a product, the emptying of the trash, the bulk operations and the brands and the
 * groups of attributes are not here, and no route of the catalog is on `/public/v1`.
 *
 * Reads: the products (a page, whole, `updatedSince`) and one product; the categories (a page, `updatedSince`), their tree and one category; the departments.
 * Writes: create, modify (the prices included), duplicate, trash and restore a product; create, modify and delete a category. Creations and the duplication are idempotent (`Idempotency-Key`, bound to the store key).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param operator The check of the operator of a write.
 * @param writeLimit The rate limit of the writes per store key.
 * @returns The route definitions to mount on `/v1`.
 */
export function createStoreCatalogRoutes(controller: StoreCatalogController, idempotency: IdempotencyStore, operator: RequestHandler, writeLimit: RateLimitRule): RouteDefinition[] {
  const products = `${STORE_CATALOG_PATH}/products`;
  const categories = `${STORE_CATALOG_PATH}/categories`;
  const read = { kind: 'store' as const, group: true as const };
  const readOne = (param: 'productId' | 'categoryId') => ({ ...read, params: [param] as const });
  const write = { ...read, operator };
  const writeOne = (param: 'productId' | 'categoryId') => ({ ...write, params: [param] as const });
  return [
    defineRoute({ method: 'GET', path: products, auth: read, middleware: [validateQuery(storeProductsQuery)], handler: controller.listProducts }),
    defineRoute({ method: 'GET', path: `${products}/:productId`, auth: readOne('productId'), middleware: [validateParams(storeProductParams)], handler: controller.getProduct }),
    defineRoute({ method: 'POST', path: products, auth: write, rateLimit: [writeLimit], bodyLimit: PRODUCT_BODY_LIMIT, middleware: [validateBody(storeCreateProductBody)], handler: idempotent(idempotency, controller.createProduct) }),
    defineRoute({ method: 'PATCH', path: `${products}/:productId`, auth: writeOne('productId'), rateLimit: [writeLimit], bodyLimit: PRODUCT_BODY_LIMIT, middleware: [validateParams(storeProductParams), requireIfMatch, validateBody(storePatchProductBody)], handler: controller.updateProduct }),
    defineRoute({ method: 'POST', path: `${products}/:productId/duplicate`, auth: writeOne('productId'), rateLimit: [writeLimit], middleware: [validateParams(storeProductParams)], handler: idempotent(idempotency, controller.duplicateProduct) }),
    defineRoute({ method: 'POST', path: `${products}/:productId/trash`, auth: writeOne('productId'), rateLimit: [writeLimit], middleware: [validateParams(storeProductParams), requireIfMatch], handler: controller.trashProduct }),
    defineRoute({ method: 'POST', path: `${products}/:productId/restore`, auth: writeOne('productId'), rateLimit: [writeLimit], middleware: [validateParams(storeProductParams), requireIfMatch], handler: controller.restoreProduct }),
    defineRoute({ method: 'GET', path: categories, auth: read, middleware: [validateQuery(storeCategoriesQuery)], handler: controller.listCategories }),
    // The tree comes before the detail: `/tree` would otherwise be read as the id of a category.
    defineRoute({ method: 'GET', path: `${categories}/tree`, auth: read, middleware: [validateQuery(object({}))], handler: controller.categoryTree }),
    defineRoute({ method: 'GET', path: `${categories}/:categoryId`, auth: readOne('categoryId'), middleware: [validateParams(storeCategoryParams)], handler: controller.getCategory }),
    defineRoute({ method: 'POST', path: categories, auth: write, rateLimit: [writeLimit], bodyLimit: CATEGORY_BODY_LIMIT, middleware: [validateBody(storeCreateCategoryBody)], handler: idempotent(idempotency, controller.createCategory) }),
    defineRoute({ method: 'PATCH', path: `${categories}/:categoryId`, auth: writeOne('categoryId'), rateLimit: [writeLimit], bodyLimit: CATEGORY_BODY_LIMIT, middleware: [validateParams(storeCategoryParams), requireIfMatch, validateBody(storePatchCategoryBody)], handler: controller.updateCategory }),
    defineRoute({ method: 'DELETE', path: `${categories}/:categoryId`, auth: writeOne('categoryId'), rateLimit: [writeLimit], middleware: [validateParams(storeCategoryParams)], handler: controller.deleteCategory }),
    defineRoute({ method: 'GET', path: `${STORE_CATALOG_PATH}/departments`, auth: read, middleware: [validateQuery(storeDepartmentsQuery)], handler: controller.listDepartments }),
  ];
}
