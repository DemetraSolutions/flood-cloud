import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { ContactGroupsController } from './contact-groups.controller.ts';
import { CONTACT_GROUP_BODY_LIMIT, contactGroupParams, contactGroupsQuery, createContactGroupBody, patchContactGroupBody } from './contact-groups.schemas.ts';

/** The URL segment of the groups of contacts under `/groups/{groupId}`. */
export const CONTACT_GROUPS_SEGMENT = 'contact-groups';

/**
 * The routes of the groups of contacts (`doc/Tasks.md` step K1): `GET` list and detail need `contacts:read`; the creation (idempotent: `Idempotency-Key`), the modification and the deletion (both `If-Match`) need
 * `contacts:write`. A group of contacts has no trash: its deletion is for good, and refused while something uses it. Not open to a store key (the default) and not part of the public surface.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createContactGroupsRoutes(controller: ContactGroupsController, idempotency: IdempotencyStore): RouteDefinition[] {
  const all = `/groups/:groupId/${CONTACT_GROUPS_SEGMENT}`;
  const one = `${all}/:contactGroupId`;
  const auth = (permission: 'contacts:read' | 'contacts:write') => ({ kind: 'user' as const, permission, group: true });
  return [
    defineRoute({ method: 'GET', path: all, auth: auth('contacts:read'), middleware: [validateQuery(contactGroupsQuery)], handler: controller.list }),
    defineRoute({ method: 'POST', path: all, auth: auth('contacts:write'), bodyLimit: CONTACT_GROUP_BODY_LIMIT, middleware: [validateBody(createContactGroupBody)], handler: idempotent(idempotency, controller.create) }),
    defineRoute({ method: 'GET', path: one, auth: auth('contacts:read'), middleware: [validateParams(contactGroupParams)], handler: controller.get }),
    defineRoute({ method: 'PATCH', path: one, auth: auth('contacts:write'), bodyLimit: CONTACT_GROUP_BODY_LIMIT, middleware: [validateParams(contactGroupParams), requireIfMatch, validateBody(patchContactGroupBody)], handler: controller.update }),
    defineRoute({ method: 'DELETE', path: one, auth: auth('contacts:write'), middleware: [validateParams(contactGroupParams), requireIfMatch], handler: controller.remove }),
  ];
}
