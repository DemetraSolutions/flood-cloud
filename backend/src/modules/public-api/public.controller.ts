import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { PublicListQuery } from './public.schemas.ts';
import type { PublicService } from './public.service.ts';

/** HTTP handlers of the public routes. */
export interface PublicController {
  me: RequestHandler;
  places: RequestHandler;
  place: RequestHandler;
  companies: RequestHandler;
  company: RequestHandler;
  priceLists: RequestHandler;
  taxes: RequestHandler;
  currencies: RequestHandler;
  measureUnits: RequestHandler;
}

/**
 * Translates HTTP into {@link PublicService} calls. The principal is the one the API key authentication set; the group is always the one of the key.
 *
 * @param service The service.
 */
export function createPublicController(service: PublicService): PublicController {
  const placeIdOf = (res: Response): ObjectId => inputOf<{ placeId: ObjectId }>(res, 'params').placeId;
  const companyIdOf = (res: Response): ObjectId => inputOf<{ companyId: ObjectId }>(res, 'params').companyId;
  return {
    me: async (_req, res) => sendData(res, await service.me(res.locals.apiKey!)),
    places: async (_req, res) => {
      const { items, page } = await service.places(res.locals.apiKey!, inputOf<PublicListQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    place: async (_req, res) => sendData(res, await service.place(res.locals.apiKey!, placeIdOf(res))),
    companies: async (_req, res) => {
      const { items, page } = await service.companies(res.locals.apiKey!, inputOf<PublicListQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    company: async (_req, res) => sendData(res, await service.company(res.locals.apiKey!, companyIdOf(res))),
    priceLists: async (_req, res) => sendData(res, await service.priceLists(res.locals.apiKey!)),
    taxes: async (_req, res) => sendData(res, await service.taxes(res.locals.apiKey!)),
    currencies: async (_req, res) => sendData(res, await service.currencies(res.locals.apiKey!)),
    measureUnits: async (_req, res) => sendData(res, await service.measureUnits(res.locals.apiKey!)),
  };
}
