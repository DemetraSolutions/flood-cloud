import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { sendRevalidated } from '../../shared/http/etag.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { StoreOperator } from '../product-catalog/caller.ts';
import type { CreateCategoryBody, PatchCategoryBody } from '../product-categories/categories.schemas.ts';
import type { CreateProductBody, PatchProductBody } from '../products/products.schemas.ts';
import type { StoreProductResult } from './store-catalog.mapper.ts';
import type { StoreCatalogService } from './store-catalog.service.ts';
import type { StoreCategoriesQuery, StoreDepartmentsQuery, StoreProductsQuery } from './store-catalog.schemas.ts';

/** HTTP handlers of the catalog routes of the server of a point of sale. */
export interface StoreCatalogController {
  listProducts: RequestHandler;
  getProduct: RequestHandler;
  createProduct: RequestHandler;
  updateProduct: RequestHandler;
  duplicateProduct: RequestHandler;
  trashProduct: RequestHandler;
  restoreProduct: RequestHandler;
  listCategories: RequestHandler;
  categoryTree: RequestHandler;
  getCategory: RequestHandler;
  createCategory: RequestHandler;
  updateCategory: RequestHandler;
  deleteCategory: RequestHandler;
  listDepartments: RequestHandler;
}

const productIdOf = (res: Response): ObjectId => inputOf<{ productId: ObjectId }>(res, 'params').productId;
const categoryIdOf = (res: Response): ObjectId => inputOf<{ categoryId: ObjectId }>(res, 'params').categoryId;
/** The operator the `operator` check of a write route verified (the builder guarantees it ran). */
const operatorOf = (res: Response): StoreOperator => res.locals.storeOperator!;

/** The entry in the `{ data }` envelope with the `ETag` of its version. */
function sendEntry(res: Response, result: StoreProductResult | { readonly entity: object; readonly version: string }, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link StoreCatalogService} calls. Every response that carries a product or a category has its `ETag`, which is the `If-Match` of the next write; the principal of the store, the group
 * access and the operator come from the locals set by the route builder, never from the request.
 *
 * @param service The catalog service of the store.
 */
export function createStoreCatalogController(service: StoreCatalogService): StoreCatalogController {
  return {
    listProducts: async (_req, res) => {
      const { items, page } = await service.listProducts(res.locals.store!, res.locals.groupAccess!, inputOf<StoreProductsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getProduct: async (_req, res) => {
      sendEntry(res, await service.getProduct(res.locals.store!, res.locals.groupAccess!, productIdOf(res)));
    },
    createProduct: async (req, res) => {
      const created = await service.createProduct(res.locals.store!, operatorOf(res), res.locals.groupAccess!, inputOf<CreateProductBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendEntry(res, created, 201);
    },
    updateProduct: async (req, res) => {
      sendEntry(res, await service.updateProduct(res.locals.store!, operatorOf(res), res.locals.groupAccess!, productIdOf(res), res.locals.ifMatch!, inputOf<PatchProductBody>(res, 'body'), clientContextOf(req, res)));
    },
    duplicateProduct: async (req, res) => {
      const copy = await service.duplicateProduct(res.locals.store!, operatorOf(res), res.locals.groupAccess!, productIdOf(res), clientContextOf(req, res));
      // The copy is a new product of the collection: its link is the collection's, not the `…/duplicate` of the request.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/[^/]+\/duplicate\/?$/, '')}/${copy.entity.id}`);
      sendEntry(res, copy, 201);
    },
    trashProduct: async (req, res) => {
      sendEntry(res, await service.trashProduct(res.locals.store!, operatorOf(res), res.locals.groupAccess!, productIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    restoreProduct: async (req, res) => {
      sendEntry(res, await service.restoreProduct(res.locals.store!, operatorOf(res), res.locals.groupAccess!, productIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    listCategories: async (_req, res) => {
      const { items, page } = await service.listCategories(res.locals.store!, res.locals.groupAccess!, inputOf<StoreCategoriesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    categoryTree: async (req, res) => {
      sendRevalidated(req, res, await service.categoryTree(res.locals.store!, res.locals.groupAccess!));
    },
    getCategory: async (_req, res) => {
      sendEntry(res, await service.getCategory(res.locals.store!, res.locals.groupAccess!, categoryIdOf(res)));
    },
    createCategory: async (req, res) => {
      const created = await service.createCategory(res.locals.store!, operatorOf(res), res.locals.groupAccess!, inputOf<CreateCategoryBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendEntry(res, created, 201);
    },
    updateCategory: async (req, res) => {
      sendEntry(res, await service.updateCategory(res.locals.store!, operatorOf(res), res.locals.groupAccess!, categoryIdOf(res), res.locals.ifMatch!, inputOf<PatchCategoryBody>(res, 'body'), clientContextOf(req, res)));
    },
    deleteCategory: async (req, res) => {
      await service.deleteCategory(res.locals.store!, operatorOf(res), res.locals.groupAccess!, categoryIdOf(res), clientContextOf(req, res));
      res.status(204).end();
    },
    listDepartments: async (_req, res) => {
      const { items, page } = await service.listDepartments(res.locals.store!, res.locals.groupAccess!, inputOf<StoreDepartmentsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
  };
}
