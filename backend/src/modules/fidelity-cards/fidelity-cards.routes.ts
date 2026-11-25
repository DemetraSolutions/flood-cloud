import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { CardsController } from './fidelity-cards.controller.ts';
import { CARD_BODY_LIMIT, adjustmentBody, cardIdParams, cardsQuery, createCardBody, movementsQuery, patchCardBody } from './fidelity-cards.schemas.ts';

/** The URL segment of the advanced cards under `/groups/{groupId}`. */
export const CARDS_SEGMENT = 'fidelity-cards';

/**
 * The routes of the advanced loyalty cards (`doc/Tasks.md` step F1): `GET` list, detail and movements need `fidelity:read`; the creation (idempotent), the modification (`If-Match`), the adjustment (`Idempotency-Key` required) and the
 * deletion (`If-Match`) need `fidelity:update`. The creation and the adjustment move money: their `Idempotency-Key` is held for 24 hours when the request never finished (`inProgressNeverExpires`). The cards are of the group, so every route is `user` with `group: true` and no feature; they are not open to a store key (the default) and not part of the public surface.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createCardsRoutes(controller: CardsController, idempotency: IdempotencyStore): RouteDefinition[] {
  const all = `/groups/:groupId/${CARDS_SEGMENT}`;
  const one = `${all}/:cardId`;
  const auth = (permission: 'fidelity:read' | 'fidelity:update') => ({ kind: 'user' as const, permission, group: true });
  return [
    defineRoute({ method: 'GET', path: all, auth: auth('fidelity:read'), middleware: [validateQuery(cardsQuery)], handler: controller.list }),
    defineRoute({ method: 'POST', path: all, auth: auth('fidelity:update'), bodyLimit: CARD_BODY_LIMIT, middleware: [validateBody(createCardBody)], handler: idempotent(idempotency, controller.create, { inProgressNeverExpires: true }) }),
    defineRoute({ method: 'GET', path: one, auth: auth('fidelity:read'), middleware: [validateParams(cardIdParams)], handler: controller.get }),
    defineRoute({ method: 'PATCH', path: one, auth: auth('fidelity:update'), bodyLimit: CARD_BODY_LIMIT, middleware: [validateParams(cardIdParams), requireIfMatch, validateBody(patchCardBody)], handler: controller.update }),
    defineRoute({ method: 'DELETE', path: one, auth: auth('fidelity:update'), middleware: [validateParams(cardIdParams), requireIfMatch], handler: controller.remove }),
    defineRoute({ method: 'POST', path: `${one}/adjustments`, auth: auth('fidelity:update'), bodyLimit: CARD_BODY_LIMIT, middleware: [validateParams(cardIdParams), validateBody(adjustmentBody)], handler: idempotent(idempotency, controller.adjust, { inProgressNeverExpires: true }) }),
    defineRoute({ method: 'GET', path: `${one}/movements`, auth: auth('fidelity:read'), middleware: [validateParams(cardIdParams), validateQuery(movementsQuery)], handler: controller.movements }),
  ];
}
