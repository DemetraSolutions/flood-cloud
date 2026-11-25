import type { RequestHandler } from 'express';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { sendRevalidated } from '../../shared/http/etag.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { SaleParams, SaleQuery, SalesQuery, SalesSummaryQuery } from './sales.schemas.ts';
import type { SalesService } from './sales.service.ts';

/** HTTP handlers of the sales routes. */
export interface SalesController {
  list: RequestHandler;
  summary: RequestHandler;
  get: RequestHandler;
}

/**
 * Translates HTTP into {@link SalesService} calls. The detail of a sale has a weak `ETag` (the content tag) so the backoffice can revalidate what it shows.
 *
 * @param service The service of the sales.
 */
export function createSalesController(service: SalesService): SalesController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<SalesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    summary: async (_req, res) => {
      sendData(res, await service.summary(res.locals.auth!, res.locals.groupAccess!, inputOf<SalesSummaryQuery>(res, 'query')));
    },
    get: async (req, res) => {
      sendRevalidated(req, res, await service.get(res.locals.auth!, res.locals.groupAccess!, inputOf<SaleParams>(res, 'params').saleId, inputOf<SaleQuery>(res, 'query').nonFiscal ?? 'exclude'));
    },
  };
}
