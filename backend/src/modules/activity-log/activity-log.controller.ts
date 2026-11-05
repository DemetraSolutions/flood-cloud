import type { RequestHandler } from 'express';
import { sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ActivityLogQuery } from './activity-log.schemas.ts';
import type { ActivityLogService } from './activity-log.service.ts';

/** HTTP handlers of the activity log monitor. */
export interface ActivityLogController {
  list: RequestHandler;
}

/**
 * Translates HTTP into {@link ActivityLogService} calls.
 *
 * @param service The service.
 */
export function createActivityLogController(service: ActivityLogService): ActivityLogController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, inputOf<ActivityLogQuery>(res, 'query'));
      sendPage(res, items, page);
    },
  };
}
