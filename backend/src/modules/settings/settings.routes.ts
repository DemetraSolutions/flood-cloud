import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody } from '../../shared/validation/middleware.ts';
import type { SettingsController } from './settings.controller.ts';
import { PRICES_BODY_LIMIT, SECURITY_POLICY_BODY_LIMIT, priceListBody, securityPolicyBody } from './settings.schemas.ts';

/**
 * The routes of the settings of the platform, on `/v1`: the price list of the activations (`activations:manage`) and the security policy (`securityPolicy:manage`), which only the PSA reads and writes (only in his ceiling). The write needs `If-Match` with the version the
 * client read and is rate limited per user. They are not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createSettingsRoutes(controller: SettingsController, rules: Pick<RateLimitRules, 'activationsAdminPerUser'>): RouteDefinition[] {
  const auth = { kind: 'user' as const, permission: 'activations:manage' as const };
  const policyAuth = { kind: 'user' as const, permission: 'securityPolicy:manage' as const };
  return [
    defineRoute({ method: 'GET', path: '/settings/price-list', auth, handler: controller.getPriceList }),
    defineRoute({ method: 'PUT', path: '/settings/price-list', auth, bodyLimit: PRICES_BODY_LIMIT, rateLimit: [rules.activationsAdminPerUser], middleware: [requireIfMatch, validateBody(priceListBody)], handler: controller.putPriceList }),
    // The security policy: only the PSA (`securityPolicy:manage`, only in his ceiling). Not open to a store key (the default) nor to the public API.
    defineRoute({ method: 'GET', path: '/settings/security-policy', auth: policyAuth, handler: controller.getSecurityPolicy }),
    defineRoute({ method: 'PUT', path: '/settings/security-policy', auth: policyAuth, bodyLimit: SECURITY_POLICY_BODY_LIMIT, rateLimit: [rules.activationsAdminPerUser], middleware: [requireIfMatch, validateBody(securityPolicyBody)], handler: controller.putSecurityPolicy }),
  ];
}
