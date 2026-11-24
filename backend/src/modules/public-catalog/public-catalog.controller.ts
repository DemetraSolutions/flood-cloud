import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { sendRevalidated } from '../../shared/http/etag.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { PublicEntry, PublicCatalogService } from './public-catalog.service.ts';
import type { PublicChangesQuery, PublicCreateCategoryBody, PublicCreateProductBody, PublicPatchCategoryBody, PublicPatchProductBody, PublicProductsQuery, PublicStockQuery } from './public-catalog.schemas.ts';

/** HTTP handlers of the catalog routes of the public API. */
export interface PublicCatalogController {
  listProducts: RequestHandler;
  getProduct: RequestHandler;
  getProductStock: RequestHandler;
  listStock: RequestHandler;
  createProduct: RequestHandler;
  updateProduct: RequestHandler;
  trashProduct: RequestHandler;
  restoreProduct: RequestHandler;
  listCategories: RequestHandler;
  categoryTree: RequestHandler;
  getCategory: RequestHandler;
  createCategory: RequestHandler;
  updateCategory: RequestHandler;
  deleteCategory: RequestHandler;
  listBrands: RequestHandler;
  getBrand: RequestHandler;
  listAttributeGroups: RequestHandler;
  getAttributeGroup: RequestHandler;
  listDepartments: RequestHandler;
  getDepartment: RequestHandler;
}

const paramOf = (res: Response, name: string): ObjectId => inputOf<Record<string, ObjectId>>(res, 'params')[name]!;

/** The entry in the `{ data }` envelope with the `ETag` of its version. */
function sendEntry(res: Response, result: PublicEntry<object>, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link PublicCatalogService} calls. Every response that carries a product, a category, a brand, a group of attributes or a department has its `ETag`, which is the `If-Match` of the next write; the
 * key and the group access come from the locals set by the authentication and the route builder, never from the request.
 *
 * @param service The catalog service of the public API.
 */
export function createPublicCatalogController(service: PublicCatalogService): PublicCatalogController {
  const key = (res: Response) => res.locals.apiKey!;
  const access = (res: Response) => res.locals.groupAccess!;
  return {
    listProducts: async (_req, res) => {
      const { items, page } = await service.listProducts(key(res), access(res), inputOf<PublicProductsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getProduct: async (_req, res) => sendEntry(res, await service.getProduct(key(res), access(res), paramOf(res, 'productId'))),
    getProductStock: async (_req, res) => sendData(res, await service.getProductStock(key(res), access(res), paramOf(res, 'productId'))),
    listStock: async (_req, res) => {
      const { items, page } = await service.listStock(key(res), access(res), inputOf<PublicStockQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    createProduct: async (req, res) => {
      const created = await service.createProduct(key(res), access(res), inputOf<PublicCreateProductBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${(created.entity as { id: string }).id}`);
      sendEntry(res, created, 201);
    },
    updateProduct: async (req, res) => sendEntry(res, await service.updateProduct(key(res), access(res), paramOf(res, 'productId'), res.locals.ifMatch!, inputOf<PublicPatchProductBody>(res, 'body'), clientContextOf(req, res))),
    trashProduct: async (req, res) => sendEntry(res, await service.trashProduct(key(res), access(res), paramOf(res, 'productId'), res.locals.ifMatch!, clientContextOf(req, res))),
    restoreProduct: async (req, res) => sendEntry(res, await service.restoreProduct(key(res), access(res), paramOf(res, 'productId'), res.locals.ifMatch!, clientContextOf(req, res))),
    listCategories: async (_req, res) => {
      const { items, page } = await service.listCategories(key(res), access(res), inputOf<PublicChangesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    categoryTree: async (req, res) => sendRevalidated(req, res, await service.categoryTree(key(res), access(res))),
    getCategory: async (_req, res) => sendEntry(res, await service.getCategory(key(res), access(res), paramOf(res, 'categoryId'))),
    createCategory: async (req, res) => {
      const created = await service.createCategory(key(res), access(res), inputOf<PublicCreateCategoryBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${(created.entity as { id: string }).id}`);
      sendEntry(res, created, 201);
    },
    updateCategory: async (req, res) => sendEntry(res, await service.updateCategory(key(res), access(res), paramOf(res, 'categoryId'), res.locals.ifMatch!, inputOf<PublicPatchCategoryBody>(res, 'body'), clientContextOf(req, res))),
    deleteCategory: async (req, res) => {
      await service.deleteCategory(key(res), access(res), paramOf(res, 'categoryId'), clientContextOf(req, res));
      res.status(204).end();
    },
    listBrands: async (_req, res) => {
      const { items, page } = await service.listBrands(key(res), access(res), inputOf<PublicChangesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getBrand: async (_req, res) => sendEntry(res, await service.getBrand(key(res), access(res), paramOf(res, 'brandId'))),
    listAttributeGroups: async (_req, res) => {
      const { items, page } = await service.listAttributeGroups(key(res), access(res), inputOf<PublicChangesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getAttributeGroup: async (_req, res) => sendEntry(res, await service.getAttributeGroup(key(res), access(res), paramOf(res, 'attributeGroupId'))),
    listDepartments: async (_req, res) => {
      const { items, page } = await service.listDepartments(key(res), access(res), inputOf<PublicChangesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    getDepartment: async (_req, res) => sendEntry(res, await service.getDepartment(key(res), access(res), paramOf(res, 'departmentId'))),
  };
}
