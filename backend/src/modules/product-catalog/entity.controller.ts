import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { EntityQuery, EntityResult, EntityService } from './entity.service.ts';

/** HTTP handlers of the routes of a catalog collection (the departments or the brands). */
export interface EntityController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
}

/** Name of the path parameter that holds the id of an entry. */
export const ENTRY_PARAM = 'entryId';

const entryIdOf = (res: Response): ObjectId => inputOf<Record<typeof ENTRY_PARAM, ObjectId>>(res, 'params')[ENTRY_PARAM];

/** The entry in the `{ data }` envelope with the `ETag` of its version. */
function sendEntry(res: Response, result: EntityResult<object>, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.entity, status);
}

/**
 * Translates HTTP into {@link EntityService} calls. Every response that carries an entry has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service of the departments or of the brands.
 */
export function createEntityController<V extends { readonly id: string }, C extends object, P extends object>(service: EntityService<V, C, P>): EntityController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<EntityQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendEntry(res, await service.get(res.locals.auth!, res.locals.groupAccess!, entryIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<C>(res, 'body'), clientContextOf(req, res));
      // The base path is the one the request came in on, so the link is always the right surface.
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.entity.id}`);
      sendEntry(res, created, 201);
    },
    update: async (req, res) => {
      sendEntry(res, await service.update(res.locals.auth!, res.locals.groupAccess!, entryIdOf(res), res.locals.ifMatch!, inputOf<P>(res, 'body'), clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, entryIdOf(res), clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
