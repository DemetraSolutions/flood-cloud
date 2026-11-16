import type { RequestHandler } from 'express';
import { sendRevalidated, sendRevalidatedPage } from '../../shared/http/etag.ts';
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
  emailTemplates: RequestHandler;
  languages: RequestHandler;
}

/**
 * Translates HTTP into {@link LookupService} calls.
 *
 * @param service The service.
 */
export function createLookupController(service: LookupService): LookupController {
  return {
    products: async (req, res) => {
      const { items, page } = await service.products(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupProductsQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    categories: async (req, res) => {
      const { items, page } = await service.categories(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    customers: async (req, res) => {
      const { items, page } = await service.customers(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    contactGroups: async (req, res) => {
      const { items, page } = await service.contactGroups(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    emailTemplates: async (req, res) => {
      const { items, page } = await service.emailTemplates(res.locals.auth!, res.locals.groupAccess!, inputOf<LookupQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    languages: async (req, res) => {
      sendRevalidated(req, res, await service.languages(res.locals.groupAccess!));
    },
    priceLists: async (req, res) => {
      sendRevalidated(req, res, await service.priceLists(res.locals.groupAccess!));
    },
  };
}
