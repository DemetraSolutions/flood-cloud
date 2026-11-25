import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { object } from '../../shared/validation/schema.ts';
import { CARD_BODY_LIMIT, adjustmentBody, createCardBody, movementsQuery, patchCardBody } from '../fidelity-cards/fidelity-cards.schemas.ts';
import type { PublicFidelityCardsController } from './public-fidelity-cards.controller.ts';
import { publicCardParams, publicCardsQuery } from './public-fidelity-cards.schemas.ts';

/**
 * The advanced loyalty card routes of the public API (`/public/v1`, `doc/Public-API.md`), all for an integration with a public API key and on the group of the key (the builder issues the verified access). The reads need
 * `fidelityCards:read`: the cards (a page, one) and the movements of a card. The writes need `fidelityCards:write`: create a card, change its type and state (`If-Match`) and adjust its credit and points. The creation and the
 * adjustment move prepaid credit: their `Idempotency-Key` (bound to the key) is held for 24 hours when the request never finished (`inProgressNeverExpires`). Every write declares the limit of the writes per key, which runs before
 * the body is read. The deletion of a card is not here.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param writeLimit The rate limit of the writes per key.
 * @returns The route definitions to mount on `/public/v1`.
 */
export function createPublicFidelityCardsRoutes(controller: PublicFidelityCardsController, idempotency: IdempotencyStore, writeLimit: RateLimitRule): RouteDefinition[] {
  const read = { kind: 'apiKey' as const, permission: 'fidelityCards:read' as const, group: true as const };
  const write = { kind: 'apiKey' as const, permission: 'fidelityCards:write' as const, group: true as const };
  const limited = [writeLimit];
  return [
    defineRoute({ method: 'GET', path: '/fidelity-cards', auth: read, middleware: [validateQuery(publicCardsQuery)], handler: controller.listCards }),
    defineRoute({ method: 'POST', path: '/fidelity-cards', auth: write, rateLimit: limited, bodyLimit: CARD_BODY_LIMIT, middleware: [validateBody(createCardBody)], handler: idempotent(idempotency, controller.createCard, { inProgressNeverExpires: true }) }),
    defineRoute({ method: 'GET', path: '/fidelity-cards/:cardId', auth: read, middleware: [validateParams(publicCardParams), validateQuery(object({}))], handler: controller.getCard }),
    defineRoute({ method: 'PATCH', path: '/fidelity-cards/:cardId', auth: write, rateLimit: limited, bodyLimit: CARD_BODY_LIMIT, middleware: [validateParams(publicCardParams), requireIfMatch, validateBody(patchCardBody)], handler: controller.updateCard }),
    defineRoute({ method: 'POST', path: '/fidelity-cards/:cardId/adjustments', auth: write, rateLimit: limited, bodyLimit: CARD_BODY_LIMIT, middleware: [validateParams(publicCardParams), validateBody(adjustmentBody)], handler: idempotent(idempotency, controller.adjustCard, { inProgressNeverExpires: true }) }),
    defineRoute({ method: 'GET', path: '/fidelity-cards/:cardId/movements', auth: read, middleware: [validateParams(publicCardParams), validateQuery(movementsQuery)], handler: controller.listMovements }),
  ];
}
