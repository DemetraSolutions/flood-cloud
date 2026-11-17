import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody, validateParams } from '../../shared/validation/middleware.ts';
import type { CountriesController } from './countries.controller.ts';
import { COUNTRIES_BODY_LIMIT, areaParams, countryParams, createCodedBody, renameBody } from './countries.schemas.ts';

/**
 * The routes of the countries and their areas (provinces), on `/v1` (`doc/Tasks.md` 9-ter). The list stays in the `reference` module (`GET /v1/countries`); here are the reading of one country with its version
 * (`profile:read`, every authenticated user, like the list) and the writes, which are the PSA's alone (`countries:manage`, only in his ceiling). Every change or deletion needs `If-Match` with the version
 * the client read. The writes are rate limited per user, and are not open to a store key (the default).
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createCountriesRoutes(controller: CountriesController, rules: Pick<RateLimitRules, 'countriesAdminPerUser'>): RouteDefinition[] {
  const write = { auth: { kind: 'user' as const, permission: 'countries:manage' as const }, bodyLimit: COUNTRIES_BODY_LIMIT, rateLimit: [rules.countriesAdminPerUser] };
  const one = '/countries/:countryCode';
  const area = `${one}/areas/:areaCode`;
  return [
    defineRoute({ method: 'GET', path: one, auth: { kind: 'user', permission: 'profile:read' }, middleware: [validateParams(countryParams)], handler: controller.get }),
    defineRoute({ method: 'POST', path: '/countries', ...write, middleware: [validateBody(createCodedBody)], handler: controller.create }),
    defineRoute({ method: 'PATCH', path: one, ...write, middleware: [validateParams(countryParams), requireIfMatch, validateBody(renameBody)], handler: controller.rename }),
    defineRoute({ method: 'DELETE', path: one, ...write, middleware: [validateParams(countryParams), requireIfMatch], handler: controller.remove }),
    defineRoute({ method: 'POST', path: `${one}/areas`, ...write, middleware: [validateParams(countryParams), requireIfMatch, validateBody(createCodedBody)], handler: controller.addArea }),
    defineRoute({ method: 'PATCH', path: area, ...write, middleware: [validateParams(areaParams), requireIfMatch, validateBody(renameBody)], handler: controller.renameArea }),
    defineRoute({ method: 'DELETE', path: area, ...write, middleware: [validateParams(areaParams), requireIfMatch], handler: controller.removeArea }),
  ];
}
