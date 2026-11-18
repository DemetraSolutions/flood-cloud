import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody } from '../../shared/validation/middleware.ts';
import type { SettingsController } from './settings.controller.ts';
import { PRICES_BODY_LIMIT, priceListBody } from './settings.schemas.ts';

/**
 * The routes of the settings of the platform, on `/v1`: the price list of the activations, which only the PSA reads and writes (`activations:manage`, only in his ceiling). The write needs `If-Match` with the version the
 * client read and is rate limited per user. They are not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createSettingsRoutes(controller: SettingsController, rules: Pick<RateLimitRules, 'activationsAdminPerUser'>): RouteDefinition[] {
  const auth = { kind: 'user' as const, permission: 'activations:manage' as const };
  return [
    defineRoute({ method: 'GET', path: '/settings/price-list', auth, handler: controller.getPriceList }),
    defineRoute({ method: 'PUT', path: '/settings/price-list', auth, bodyLimit: PRICES_BODY_LIMIT, rateLimit: [rules.activationsAdminPerUser], middleware: [requireIfMatch, validateBody(priceListBody)], handler: controller.putPriceList }),
  ];
}
