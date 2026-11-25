import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { TRASH_BODY_LIMIT, idsBody } from '../trash/trash.schemas.ts';
import type { ContactsController } from './contacts.controller.ts';
import { CONTACT_BODY_LIMIT, POINTS_BODY_LIMIT, cardParams, contactParams, contactsQuery, createContactBody, patchContactBody, pointsAdjustmentBody } from './contacts.schemas.ts';

/** The URL segment of the contacts under `/groups/{groupId}`. */
export const CONTACTS_SEGMENT = 'contacts';

/**
 * The contact routes (`doc/Tasks.md` step K1): the contacts are of the group, shared by its places, so every route is `user` with `group: true` and no feature. `GET` list and detail need `contacts:read`; the creation, the
 * modification (`If-Match`), the trash and the restore (`If-Match`), the bulk trash, the deletion of a contact in the trash (`If-Match`) and the adjustment of the points of a card need `contacts:write`. The creation and the
 * adjustment are idempotent (`Idempotency-Key`). Not open to a store key (the default) and not part of the public surface.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createContactsRoutes(controller: ContactsController, idempotency: IdempotencyStore): RouteDefinition[] {
  const all = `/groups/:groupId/${CONTACTS_SEGMENT}`;
  const one = `${all}/:contactId`;
  const auth = (permission: 'contacts:read' | 'contacts:write') => ({ kind: 'user' as const, permission, group: true });
  return [
    defineRoute({ method: 'GET', path: all, auth: auth('contacts:read'), middleware: [validateQuery(contactsQuery)], handler: controller.list }),
    defineRoute({ method: 'POST', path: all, auth: auth('contacts:write'), bodyLimit: CONTACT_BODY_LIMIT, middleware: [validateBody(createContactBody)], handler: idempotent(idempotency, controller.create) }),
    defineRoute({ method: 'POST', path: `${all}/trash`, auth: auth('contacts:write'), bodyLimit: TRASH_BODY_LIMIT, middleware: [validateBody(idsBody)], handler: controller.trashMany }),
    defineRoute({ method: 'GET', path: one, auth: auth('contacts:read'), middleware: [validateParams(contactParams)], handler: controller.get }),
    defineRoute({ method: 'PATCH', path: one, auth: auth('contacts:write'), bodyLimit: CONTACT_BODY_LIMIT, middleware: [validateParams(contactParams), requireIfMatch, validateBody(patchContactBody)], handler: controller.update }),
    defineRoute({ method: 'DELETE', path: one, auth: auth('contacts:write'), middleware: [validateParams(contactParams), requireIfMatch], handler: controller.remove }),
    defineRoute({ method: 'POST', path: `${one}/trash`, auth: auth('contacts:write'), middleware: [validateParams(contactParams), requireIfMatch], handler: controller.trash }),
    defineRoute({ method: 'POST', path: `${one}/restore`, auth: auth('contacts:write'), middleware: [validateParams(contactParams), requireIfMatch], handler: controller.restore }),
    defineRoute({
      method: 'POST',
      path: `${one}/fidelity-cards/:code/points-adjustments`,
      auth: auth('contacts:write'),
      bodyLimit: POINTS_BODY_LIMIT,
      middleware: [validateParams(cardParams), validateBody(pointsAdjustmentBody)],
      handler: idempotent(idempotency, controller.adjustPoints),
    }),
  ];
}
