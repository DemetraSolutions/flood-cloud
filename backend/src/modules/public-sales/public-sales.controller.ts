import type { RequestHandler } from 'express';
import type { ObjectId } from 'mongodb';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { PublicSalesQuery } from './public-sales.schemas.ts';
import type { PublicSalesService } from './public-sales.service.ts';

/** HTTP handlers of the sales routes of the public API. */
export interface PublicSalesController {
  list: RequestHandler;
  get: RequestHandler;
}

/**
 * Translates HTTP into {@link PublicSalesService} calls; the key and the group access come from the locals set by the authentication and the route builder, never from the request.
 *
 * @param service The sales service of the public API.
 */
export function createPublicSalesController(service: PublicSalesService): PublicSalesController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.apiKey!, res.locals.groupAccess!, inputOf<PublicSalesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => sendData(res, await service.get(res.locals.apiKey!, res.locals.groupAccess!, inputOf<{ saleId: ObjectId }>(res, 'params').saleId)),
  };
}
