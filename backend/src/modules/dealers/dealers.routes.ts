import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { PRICES_BODY_LIMIT, priceOverridesBody } from '../settings/settings.schemas.ts';
import type { DealersController } from './dealers.controller.ts';
import { createDealerBody, dealerParams, dealersQuery, patchDealerBody } from './dealers.schemas.ts';

/** Body limit of the dealer writes: company data and a user, a few hundred bytes. */
const DEALERS_BODY_LIMIT = '16kb';

/**
 * The dealer registry routes (D-09). The `dealers:*` permissions are in the ceiling of the PSA only, so no
 * other role reaches them. The creation also makes the dealer's user, so it takes the rate limit of the
 * routes that hash a password.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createDealersRoutes(controller: DealersController, rules: RateLimitRules): RouteDefinition[] {
  return [
    defineRoute({ method: 'GET', path: '/dealers', auth: { kind: 'user', permission: 'dealers:read' }, middleware: [validateQuery(dealersQuery)], handler: controller.list }),
    defineRoute({ method: 'GET', path: '/dealers/:dealerId', auth: { kind: 'user', permission: 'dealers:read' }, middleware: [validateParams(dealerParams)], handler: controller.get }),
    defineRoute({
      method: 'POST',
      path: '/dealers',
      auth: { kind: 'user', permission: 'dealers:create' },
      bodyLimit: DEALERS_BODY_LIMIT,
      rateLimit: [rules.userCredentialsPerUser],
      middleware: [validateBody(createDealerBody)],
      handler: controller.create,
    }),
    defineRoute({
      method: 'PATCH',
      path: '/dealers/:dealerId',
      auth: { kind: 'user', permission: 'dealers:update' },
      bodyLimit: DEALERS_BODY_LIMIT,
      middleware: [validateParams(dealerParams), validateBody(patchDealerBody)],
      handler: controller.update,
    }),
    // The prices a dealer pays instead of the ones of the price list: the PSA's alone (`activations:manage`), the write with the version the client read.
    defineRoute({ method: 'GET', path: '/dealers/:dealerId/price-overrides', auth: { kind: 'user', permission: 'activations:manage' }, middleware: [validateParams(dealerParams)], handler: controller.getPriceOverrides }),
    defineRoute({
      method: 'PUT',
      path: '/dealers/:dealerId/price-overrides',
      auth: { kind: 'user', permission: 'activations:manage' },
      bodyLimit: PRICES_BODY_LIMIT,
      rateLimit: [rules.activationsAdminPerUser],
      middleware: [validateParams(dealerParams), requireIfMatch, validateBody(priceOverridesBody)],
      handler: controller.putPriceOverrides,
    }),
  ];
}
