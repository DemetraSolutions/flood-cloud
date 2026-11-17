import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { requireNoBodyContent } from '../store-keys/store-keys.schemas.ts';
import type { ApiKeysController } from './api-keys.controller.ts';
import { API_KEY_BODY_LIMIT, apiKeyParams, apiKeysQuery, createApiKeyBody, patchApiKeyBody, usageQuery } from './api-keys.schemas.ts';

/**
 * The routes of the public API keys of a group (`doc/Security-Model.md` section 6), all on `/v1` and for a user: the PSA and the dealers in their perimeter (`apiKeys:read`, `apiKeys:manage`, in their ceiling
 * alone). They are not open to a store key (the default). The creation returns the secret and is never compressed; it takes no `Idempotency-Key` (a replay would have to keep the secret). The writes are rate limited per user.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createApiKeysRoutes(controller: ApiKeysController, rules: RateLimitRules): RouteDefinition[] {
  const auth = (permission: 'apiKeys:read' | 'apiKeys:manage') => ({ kind: 'user' as const, permission, group: true });
  const collection = '/groups/:groupId/api-keys';
  const one = `${collection}/:keyId`;
  return [
    defineRoute({ method: 'GET', path: collection, auth: auth('apiKeys:read'), middleware: [validateQuery(apiKeysQuery)], handler: controller.list }),
    defineRoute({
      method: 'POST',
      path: collection,
      auth: auth('apiKeys:manage'),
      bodyLimit: API_KEY_BODY_LIMIT,
      rateLimit: [rules.apiKeyAdminPerUser],
      compress: false,
      middleware: [validateBody(createApiKeyBody)],
      handler: controller.create,
    }),
    defineRoute({ method: 'GET', path: one, auth: auth('apiKeys:read'), middleware: [validateParams(apiKeyParams)], handler: controller.get }),
    defineRoute({
      method: 'PATCH',
      path: one,
      auth: auth('apiKeys:manage'),
      bodyLimit: API_KEY_BODY_LIMIT,
      rateLimit: [rules.apiKeyAdminPerUser],
      middleware: [validateParams(apiKeyParams), validateBody(patchApiKeyBody)],
      handler: controller.update,
    }),
    defineRoute({
      method: 'POST',
      path: `${one}/revoke`,
      auth: auth('apiKeys:manage'),
      bodyLimit: '1kb',
      rateLimit: [rules.apiKeyAdminPerUser],
      middleware: [validateParams(apiKeyParams), requireNoBodyContent],
      handler: controller.revoke,
    }),
    defineRoute({ method: 'GET', path: `${one}/usage`, auth: auth('apiKeys:read'), middleware: [validateParams(apiKeyParams), validateQuery(usageQuery)], handler: controller.usage }),
  ];
}
