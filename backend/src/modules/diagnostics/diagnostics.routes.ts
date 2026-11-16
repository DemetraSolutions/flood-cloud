import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { DiagnosticsController } from './diagnostics.controller.ts';
import { devicesCsvQuery, devicesQuery } from './diagnostics.schemas.ts';

/**
 * The diagnostics routes (`doc/Tasks.md` 9-bis, step T1), on `/v1`, both read-only and for the roles that read places (`places:read`); the server applies the perimeter of the role. The
 * routes are not open to a store key (the default), and the CSV has its own rate limit per user.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createDiagnosticsRoutes(controller: DiagnosticsController, rules: RateLimitRules): RouteDefinition[] {
  const auth = { kind: 'user' as const, permission: 'places:read' as const };
  return [
    defineRoute({ method: 'GET', path: '/diagnostics/devices', auth, middleware: [validateQuery(devicesQuery)], handler: controller.devices }),
    defineRoute({ method: 'GET', path: '/diagnostics/devices.csv', auth, rateLimit: [rules.diagnosticsExportPerUser], middleware: [validateQuery(devicesCsvQuery)], handler: controller.devicesCsv }),
  ];
}
