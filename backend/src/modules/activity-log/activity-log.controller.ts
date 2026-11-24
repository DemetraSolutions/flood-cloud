import type { RequestHandler } from 'express';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ActivityAlertsCountQuery, ActivityLogQuery } from './activity-log.schemas.ts';
import type { ActivityLogService } from './activity-log.service.ts';

/** HTTP handlers of the activity log monitor. */
export interface ActivityLogController {
  list: RequestHandler;
  alertsCount: RequestHandler;
}

/**
 * Translates HTTP into {@link ActivityLogService} calls.
 *
 * @param service The service.
 */
export function createActivityLogController(service: ActivityLogService): ActivityLogController {
  return {
    alertsCount: async (_req, res) => {
      sendData(res, await service.alertsCount(res.locals.auth!, inputOf<ActivityAlertsCountQuery>(res, 'query')));
    },
    list: async (_req, res) => {
      const { items, page } = await service.list(res.locals.auth!, inputOf<ActivityLogQuery>(res, 'query'));
      sendPage(res, items, page);
    },
  };
}
