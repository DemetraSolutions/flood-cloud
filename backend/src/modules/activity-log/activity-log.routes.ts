import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { ActivityLogController } from './activity-log.controller.ts';
import { activityAlertsCountQuery, activityLogQuery } from './activity-log.schemas.ts';

/**
 * The activity log monitor of the backoffice: the read-only list and the count of alerts for the badge, restricted by the caller's scope.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createActivityLogRoutes(controller: ActivityLogController): RouteDefinition[] {
  return [
    defineRoute({ method: 'GET', path: '/activity-log', auth: { kind: 'user', permission: 'activityLog:read' }, middleware: [validateQuery(activityLogQuery)], handler: controller.list }),
    defineRoute({ method: 'GET', path: '/activity-log/alerts/count', auth: { kind: 'user', permission: 'activityLog:read' }, middleware: [validateQuery(activityAlertsCountQuery)], handler: controller.alertsCount }),
  ];
}
