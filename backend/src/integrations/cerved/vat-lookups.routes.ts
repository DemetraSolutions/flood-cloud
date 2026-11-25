import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateParams } from '../../shared/validation/middleware.ts';
import type { VatLookupsController } from './vat-lookups.controller.ts';
import { vatLookupParams } from './vat-lookups.schemas.ts';

/**
 * The company lookup by VAT number on Cerved (`doc/Tasks.md` 8.1.5), on `/v1`, read-only, for who creates customers (`groups:create`: PSA and dealer). It is not a group route and
 * is not open to a store key (the default), and every lookup is two paid calls to the provider, so it has its own rate limits per user, per minute and per day.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createVatLookupsRoutes(controller: VatLookupsController, rules: Pick<RateLimitRules, 'cervedLookupPerUser' | 'cervedLookupPerUserDaily'>): RouteDefinition[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/vat-lookups/:vatNumber',
      auth: { kind: 'user', permission: 'groups:create' },
      rateLimit: [rules.cervedLookupPerUser, rules.cervedLookupPerUserDaily],
      middleware: [validateParams(vatLookupParams)],
      handler: controller.lookup,
    }),
  ];
}
