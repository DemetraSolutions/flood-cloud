import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody } from '../../shared/validation/middleware.ts';
import type { ClientErrorsController } from './client-errors.controller.ts';
import { clientErrorBody } from './client-errors.schemas.ts';

/** Body limit of the browser error reports. */
const CLIENT_ERRORS_BODY_LIMIT = '8kb';

/**
 * The route where the backoffice reports its JavaScript errors. Every authenticated user holds the
 * permission, also while he still has to replace a provisional password (the error may happen on that page).
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createClientErrorsRoutes(controller: ClientErrorsController, rules: RateLimitRules): RouteDefinition[] {
  return [
    defineRoute({
      method: 'POST',
      path: '/client-errors',
      auth: { kind: 'user', permission: 'clientErrors:create', allowWithPendingPasswordChange: true },
      bodyLimit: CLIENT_ERRORS_BODY_LIMIT,
      rateLimit: [rules.clientErrorsPerUser],
      middleware: [validateBody(clientErrorBody)],
      handler: controller.report,
    }),
  ];
}
