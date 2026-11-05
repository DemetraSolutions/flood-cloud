import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { ActivityLogController } from './activity-log.controller.ts';
import { activityLogQuery } from './activity-log.schemas.ts';

/**
 * The activity log monitor of the backoffice: one read-only list, restricted by the caller's scope.
 *
 * @param controller Handlers.
 * @returns The route definitions to mount on `/v1`.
 */
export function createActivityLogRoutes(controller: ActivityLogController): RouteDefinition[] {
  return [defineRoute({ method: 'GET', path: '/activity-log', auth: { kind: 'user', permission: 'activityLog:read' }, middleware: [validateQuery(activityLogQuery)], handler: controller.list })];
}
