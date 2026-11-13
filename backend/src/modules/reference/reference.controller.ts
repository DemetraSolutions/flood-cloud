import type { RequestHandler } from 'express';
import { sendRevalidatedPage } from '../../shared/http/etag.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { CompaniesQuery, GroupsQuery, PlacesQuery } from './reference.schemas.ts';
import type { ReferenceService } from './reference.service.ts';

/** HTTP handlers of the reference lists. */
export interface ReferenceController {
  listGroups: RequestHandler;
  listCompanies: RequestHandler;
  listPlaces: RequestHandler;
}

/**
 * Translates HTTP into {@link ReferenceService} calls.
 *
 * @param service The service.
 */
export function createReferenceController(service: ReferenceService): ReferenceController {
  return {
    listGroups: async (req, res) => {
      const { items, page } = await service.listGroups(res.locals.auth!, inputOf<GroupsQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    listCompanies: async (req, res) => {
      const { items, page } = await service.listCompanies(res.locals.auth!, res.locals.groupAccess!, inputOf<CompaniesQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    listPlaces: async (req, res) => {
      const { items, page } = await service.listPlaces(res.locals.auth!, res.locals.groupAccess!, inputOf<PlacesQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
  };
}
