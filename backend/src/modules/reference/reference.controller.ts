import type { RequestHandler } from 'express';
import { sendRevalidatedPage } from '../../shared/http/etag.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { GroupsQuery } from './reference.schemas.ts';
import type { ReferenceService } from './reference.service.ts';

/** HTTP handlers of the reference lists. */
export interface ReferenceController {
  listGroups: RequestHandler;
  listCountries: RequestHandler;
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
    listCountries: async (req, res) => {
      const { items, page } = await service.listCountries();
      sendRevalidatedPage(req, res, items, page);
    },
  };
}
