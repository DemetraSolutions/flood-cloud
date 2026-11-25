import type { RequestHandler } from 'express';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { CONTACT_BODY_LIMIT, POINTS_BODY_LIMIT, cardCode, cardParams, contactParams, createContactBody, patchContactBody, pointsAdjustmentBody } from '../contacts/contacts.schemas.ts';
import { CARD_BODY_LIMIT, adjustmentBody, cardIdParams, createCardBody, movementsQuery, patchCardBody } from '../fidelity-cards/fidelity-cards.schemas.ts';
import type { StoreContactsController } from './store-contacts.controller.ts';
import { storeCardsQuery, storeContactGroupsQuery, storeContactsQuery } from './store-contacts.schemas.ts';

/** The path of the contacts of a store, under `/v1`. */
export const STORE_CONTACTS_PATH = '/store-context/contacts';

/** The path of the groups of contacts of a store, under `/v1`. */
export const STORE_CONTACT_GROUPS_PATH = '/store-context/contact-groups';

/** The path of the advanced loyalty cards of a store, under `/v1`. */
export const STORE_CARDS_PATH = '/store-context/fidelity-cards';

/**
 * The routes of the contacts, of their groups and of the advanced loyalty cards for the server of a point of sale (`doc/Store-API.md`, step K5), all on `/v1` and only for a store key (`403 FORBIDDEN` to a user), on routes of
 * their own: none of the routes of the backoffice is opened to a store key. The contacts and the cards are the group's: the group is the one of the key and nothing narrows them by place. The reads need nothing else; the writes
 * declare the `operator` check (the permission `contacts` of the point of sale), which the builder runs before the body is read. There is no deletion of a contact or of a card, no restore and no bulk operation, and no route is on
 * `/public/v1`.
 *
 * Contacts: a page (`updatedSince`, search), one, create (idempotent), modify (`If-Match`, the codes of the loyalty cards too), trash (`If-Match`) and the adjustment of the points of a simple card (idempotent).
 * Groups of contacts: read only. Advanced cards: a page (by code, `updatedSince`), one, its movements, create and adjust (both with an `Idempotency-Key` held for 24 hours when the request never finished, as they move money) and modify (`If-Match`).
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param operator The check of the operator of a write.
 * @param writeLimit The rate limit of the writes per store key.
 * @returns The route definitions to mount on `/v1`.
 */
export function createStoreContactsRoutes(controller: StoreContactsController, idempotency: IdempotencyStore, operator: RequestHandler, writeLimit: RateLimitRule): RouteDefinition[] {
  const read = { kind: 'store' as const, group: true as const };
  const write = { ...read, operator };
  const contactOne = (auth: typeof read | typeof write) => ({ ...auth, params: ['contactId'] as const });
  const cardOne = (auth: typeof read | typeof write) => ({ ...auth, params: ['cardId'] as const });
  const contact = `${STORE_CONTACTS_PATH}/:contactId`;
  const cards = STORE_CARDS_PATH;
  const card = `${cards}/:cardId`;
  const money = { inProgressNeverExpires: true as const };
  return [
    defineRoute({ method: 'GET', path: STORE_CONTACTS_PATH, auth: read, middleware: [validateQuery(storeContactsQuery)], handler: controller.listContacts }),
    defineRoute({ method: 'POST', path: STORE_CONTACTS_PATH, auth: write, rateLimit: [writeLimit], bodyLimit: CONTACT_BODY_LIMIT, middleware: [validateBody(createContactBody)], handler: idempotent(idempotency, controller.createContact) }),
    defineRoute({ method: 'GET', path: contact, auth: contactOne(read), middleware: [validateParams(contactParams)], handler: controller.getContact }),
    defineRoute({ method: 'PATCH', path: contact, auth: contactOne(write), rateLimit: [writeLimit], bodyLimit: CONTACT_BODY_LIMIT, middleware: [validateParams(contactParams), requireIfMatch, validateBody(patchContactBody)], handler: controller.updateContact }),
    defineRoute({ method: 'POST', path: `${contact}/trash`, auth: contactOne(write), rateLimit: [writeLimit], middleware: [validateParams(contactParams), requireIfMatch], handler: controller.trashContact }),
    defineRoute({
      method: 'POST',
      path: `${contact}/fidelity-cards/:code/points-adjustments`,
      auth: { ...contactOne(write), text: { code: cardCode(false) } },
      rateLimit: [writeLimit],
      bodyLimit: POINTS_BODY_LIMIT,
      middleware: [validateParams(cardParams), validateBody(pointsAdjustmentBody)],
      handler: idempotent(idempotency, controller.adjustContactPoints),
    }),
    defineRoute({ method: 'GET', path: STORE_CONTACT_GROUPS_PATH, auth: read, middleware: [validateQuery(storeContactGroupsQuery)], handler: controller.listContactGroups }),
    defineRoute({ method: 'GET', path: cards, auth: read, middleware: [validateQuery(storeCardsQuery)], handler: controller.listCards }),
    defineRoute({ method: 'POST', path: cards, auth: write, rateLimit: [writeLimit], bodyLimit: CARD_BODY_LIMIT, middleware: [validateBody(createCardBody)], handler: idempotent(idempotency, controller.createCard, money) }),
    defineRoute({ method: 'GET', path: card, auth: cardOne(read), middleware: [validateParams(cardIdParams)], handler: controller.getCard }),
    defineRoute({ method: 'PATCH', path: card, auth: cardOne(write), rateLimit: [writeLimit], bodyLimit: CARD_BODY_LIMIT, middleware: [validateParams(cardIdParams), requireIfMatch, validateBody(patchCardBody)], handler: controller.updateCard }),
    defineRoute({ method: 'POST', path: `${card}/adjustments`, auth: cardOne(write), rateLimit: [writeLimit], bodyLimit: CARD_BODY_LIMIT, middleware: [validateParams(cardIdParams), validateBody(adjustmentBody)], handler: idempotent(idempotency, controller.adjustCard, money) }),
    defineRoute({ method: 'GET', path: `${card}/movements`, auth: cardOne(read), middleware: [validateParams(cardIdParams), validateQuery(movementsQuery)], handler: controller.listMovements }),
  ];
}
