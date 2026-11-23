import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { IdsBody } from '../trash/trash.schemas.ts';
import type { ProductResult, ProductsService } from './products.service.ts';
import type { CreateProductBody, PatchProductBody, ProductsQuery } from './products.schemas.ts';

/** HTTP handlers of the product routes. */
export interface ProductsController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  duplicate: RequestHandler;
  trash: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
  trashMany: RequestHandler;
}

const productIdOf = (res: Response): ObjectId => inputOf<{ productId: ObjectId }>(res, 'params').productId;

/** The product in the `{ data }` envelope with the `ETag` of its version. */
function sendProduct(res: Response, result: ProductResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link ProductsService} calls. Every response that carries a product has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service of the products.
 */
export function createProductsController(service: ProductsService): ProductsController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<ProductsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendProduct(res, await service.get(res.locals.auth!, res.locals.groupAccess!, productIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<CreateProductBody>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendProduct(res, created, 201);
    },
    update: async (req, res) => {
      sendProduct(res, await service.update(res.locals.auth!, res.locals.groupAccess!, productIdOf(res), res.locals.ifMatch!, inputOf<PatchProductBody>(res, 'body'), clientContextOf(req, res)));
    },
    duplicate: async (req, res) => {
      const copy = await service.duplicate(res.locals.auth!, res.locals.groupAccess!, productIdOf(res), clientContextOf(req, res));
      // The copy is a new product of the collection: its link is the collection's, not the `…/duplicate` of the request.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/[^/]+\/duplicate\/?$/, '')}/${copy.entity.id}`);
      sendProduct(res, copy, 201);
    },
    trash: async (req, res) => {
      sendProduct(res, await service.trash(res.locals.auth!, res.locals.groupAccess!, productIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    restore: async (req, res) => {
      sendProduct(res, await service.restore(res.locals.auth!, res.locals.groupAccess!, productIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, productIdOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
    trashMany: async (req, res) => {
      sendData(res, await service.trashMany(res.locals.auth!, res.locals.groupAccess!, inputOf<IdsBody>(res, 'body').ids, clientContextOf(req, res)));
    },
  };
}
