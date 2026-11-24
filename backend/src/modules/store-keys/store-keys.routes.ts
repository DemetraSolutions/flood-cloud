import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateBody, validateParams } from '../../shared/validation/middleware.ts';
import { ACTIVATION_BODY_LIMIT, activationBody, placeKeyParams, validateActivationCodeBody } from './store-keys.schemas.ts';
import type { StoreKeysController } from './store-keys.controller.ts';

/**
 * The routes of the key of the server of a point of sale (`doc/Security-Model.md` section 5, D-24), all on `/v1`:
 * the management (status, creation and cancellation of the activation code, revocation), which only the PSA and the dealers reach (`storeKeys:read`, `storeKeys:manage`, in their ceiling alone), and the two
 * routes of the store: the exchange of the activation code for the key (anonymous by nature: the code is the credential, rate limited per IP before the body is read) and its context
 * (only a store key may call it). The responses that carry the code or the key are never compressed.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createStoreKeysRoutes(controller: StoreKeysController, rules: RateLimitRules): RouteDefinition[] {
  const key = '/groups/:groupId/places/:placeId/store-key';
  const group = (permission: 'storeKeys:read' | 'storeKeys:manage') => ({ kind: 'user' as const, permission, group: true });
  return [
    defineRoute({ method: 'GET', path: key, auth: group('storeKeys:read'), middleware: [validateParams(placeKeyParams)], handler: controller.status }),
    defineRoute({
      method: 'POST',
      path: `${key}/activation-codes`,
      auth: group('storeKeys:manage'),
      bodyLimit: '1kb',
      rateLimit: [rules.storeKeyAdminPerUser],
      compress: false,
      middleware: [validateParams(placeKeyParams), validateActivationCodeBody],
      handler: controller.createCode,
    }),
    defineRoute({ method: 'DELETE', path: `${key}/activation-code`, auth: group('storeKeys:manage'), rateLimit: [rules.storeKeyAdminPerUser], middleware: [validateParams(placeKeyParams)], handler: controller.cancelCode }),
    defineRoute({ method: 'DELETE', path: key, auth: group('storeKeys:manage'), rateLimit: [rules.storeKeyAdminPerUser], middleware: [validateParams(placeKeyParams)], handler: controller.revoke }),
    defineRoute({
      method: 'POST',
      path: '/store-activations',
      auth: { kind: 'anonymous', reason: 'the server of a store has no credential yet: the activation code is the credential' },
      bodyLimit: ACTIVATION_BODY_LIMIT,
      rateLimit: [rules.storeActivationPerIp],
      compress: false,
      middleware: [validateBody(activationBody)],
      handler: controller.exchange,
    }),
    defineRoute({ method: 'GET', path: '/store-context', auth: { kind: 'store' }, handler: controller.context }),
  ];
}
