import type { RequestHandler } from 'express';
import { sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ServicesQuery } from './services.schemas.ts';
import type { GroupServicesService } from './services.service.ts';

/** HTTP handlers of the services list. */
export interface GroupServicesController {
  list: RequestHandler;
}

/**
 * Translates HTTP into {@link GroupServicesService} calls.
 *
 * @param service The service.
 */
export function createGroupServicesController(service: GroupServicesService): GroupServicesController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, res.locals.groupAccess!, inputOf<ServicesQuery>(res, 'query'));
      sendPage(res, items, page);
    },
  };
}
