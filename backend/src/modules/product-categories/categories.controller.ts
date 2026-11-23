import type { RequestHandler } from 'express';
import { sendRevalidated } from '../../shared/http/etag.ts';
import { createEntityController } from '../product-catalog/entity.controller.ts';
import type { EntityController } from '../product-catalog/entity.controller.ts';
import type { CategoriesService } from './categories.service.ts';

/** HTTP handlers of the category routes: the generic ones of a catalog collection and the compact tree. */
export interface CategoriesController extends EntityController {
  /** `GET /product-categories/tree`: the tree with an `ETag` (and `304` on a matching `If-None-Match`). */
  tree: RequestHandler;
}

/**
 * Translates HTTP into {@link CategoriesService} calls. Every response that carries a category has its `ETag`, the `If-Match` of the next write; the tree has the tag of its content.
 *
 * @param service The service of the categories.
 */
export function createCategoriesController(service: CategoriesService): CategoriesController {
  return {
    ...createEntityController(service),
    tree: async (req, res) => {
      sendRevalidated(req, res, await service.tree(res.locals.auth!, res.locals.groupAccess!));
    },
  };
}
