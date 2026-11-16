import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendRevalidated, sendRevalidatedPage } from '../../shared/http/etag.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { SETTING_BLOCKS } from '../../shared/legacy-write/place-settings.ts';
import { LIST_SEGMENTS } from './place-lists.schemas.ts';
import type { PlaceCreation, PlacePatch } from './place.types.ts';
import type { PlacesQuery } from './places.schemas.ts';
import type { PlaceResult, PlacesService } from './places.service.ts';

/** HTTP handlers of the place routes. */
export interface PlacesController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  /** `PUT …/license`, `…/opening-hours`, `…/settings/*`, `…/media`, `…/integrations` and the lists (`…/devices`, `…/print-stations`, `…/rooms`, `…/storages`): each replaces its block (by its domain name) through the same write as the modification. */
  replace: Readonly<Record<string, RequestHandler>>;
  trash: RequestHandler;
  restore: RequestHandler;
  remove: RequestHandler;
  duplicate: RequestHandler;
  invoiceSeries: RequestHandler;
}

const placeIdOf = (res: Response): ObjectId => inputOf<{ placeId: ObjectId }>(res, 'params').placeId;

/** The place in the `{ data }` envelope with the `ETag` of its version. */
function sendPlace(res: Response, result: PlaceResult, status = 200): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.place, status);
}

/**
 * Translates HTTP into {@link PlacesService} calls. Every response that carries a place has its `ETag`, which is the `If-Match` of the next write.
 *
 * @param service The service.
 */
export function createPlacesController(service: PlacesService): PlacesController {
  const block =
    (name: string): RequestHandler =>
    async (req, res) => {
      const body = inputOf<unknown>(res, 'body');
      sendPlace(res, await service.update(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), res.locals.ifMatch!, { [name]: body } as PlacePatch, clientContextOf(req, res)));
    };
  /** `201` with the `Location` of the new place: the base path is the one the request came in on, so the link is always the right surface. */
  const sendCreated = (req: Parameters<RequestHandler>[0], res: Response, created: PlaceResult, collectionPath: string): void => {
    res.setHeader('Location', `${req.baseUrl}${collectionPath}/${created.place.id}`);
    sendPlace(res, created, 201);
  };
  return {
    list: async (req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<PlacesQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    get: async (_req, res) => {
      // A store key reads its own place through the same route as a user: the caller is whichever principal the request carries.
      sendPlace(res, await service.get((res.locals.store ?? res.locals.auth)!, res.locals.groupAccess!, placeIdOf(res)));
    },
    invoiceSeries: async (req, res) => {
      sendRevalidated(req, res, await service.invoiceSeries(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, res.locals.groupAccess!, inputOf<PlaceCreation>(res, 'body'), clientContextOf(req, res));
      sendCreated(req, res, created, req.path.replace(/\/$/, ''));
    },
    update: async (req, res) => {
      sendPlace(res, await service.update(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), res.locals.ifMatch!, inputOf<PlacePatch>(res, 'body'), clientContextOf(req, res)));
    },
    replace: Object.fromEntries(['license', 'openingHours', ...Object.keys(SETTING_BLOCKS), ...Object.keys(LIST_SEGMENTS)].map((name) => [name, block(name)])),
    trash: async (req, res) => {
      sendPlace(res, await service.trash(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    restore: async (req, res) => {
      sendPlace(res, await service.restore(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), res.locals.ifMatch!, clientContextOf(req, res)));
    },
    remove: async (req, res) => {
      await service.remove(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
    duplicate: async (req, res) => {
      const created = await service.duplicate(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), clientContextOf(req, res));
      // The copy is a new place of the collection: its link is the collection's, not the `…/duplicate` of the request.
      sendCreated(req, res, created, req.path.replace(/\/[^/]+\/duplicate\/?$/, ''));
    },
  };
}
