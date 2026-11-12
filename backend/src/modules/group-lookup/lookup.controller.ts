import type { RequestHandler } from 'express';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { LookupProductsQuery, LookupQuery } from './lookup.schemas.ts';
import type { LookupService } from './lookup.service.ts';

/** HTTP handlers of the compact reads. */
export interface LookupController {
  products: RequestHandler;
  categories: RequestHandler;
  customers: RequestHandler;
  contactGroups: RequestHandler;
  priceLists: RequestHandler;
}

/**
 * Translates HTTP into {@link LookupService} calls.
 *
 * @param service The service.
 */
export function createLookupController(service: LookupService): LookupController {
  return {
    products: async (_req, res) => {
      const { items, page } = await service.products(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupProductsQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    categories: async (_req, res) => {
      const { items, page } = await service.categories(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    customers: async (_req, res) => {
      const { items, page } = await service.customers(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    contactGroups: async (_req, res) => {
      const { items, page } = await service.contactGroups(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    priceLists: async (_req, res) => {
      sendData(res, await service.priceLists(res.locals.groupAccess!));
    },
  };
}
