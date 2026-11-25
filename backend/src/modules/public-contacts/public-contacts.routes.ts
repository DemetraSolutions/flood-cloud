import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { object } from '../../shared/validation/schema.ts';
import { CONTACT_BODY_LIMIT } from '../contacts/contacts.schemas.ts';
import type { PublicContactsController } from './public-contacts.controller.ts';
import { publicContactGroupParams, publicContactGroupsQuery, publicContactParams, publicContactsQuery, publicCreateContactBody, publicPatchContactBody } from './public-contacts.schemas.ts';

/**
 * The contact routes of the public API (`/public/v1`, `doc/Public-API.md`), all for an integration with a public API key and on the group of the key (the builder issues the verified access). The reads need `contacts:read`: the
 * contacts (a page with `updatedSince`, one) and their groups (a page, one). The writes need `contacts:write`: create, modify, trash and restore a contact. The creation is idempotent (`Idempotency-Key`, bound to the key) and
 * every write declares the limit of the writes per key, which runs before the body is read. The deletion for good of a contact, the adjustment of the points of its cards, the workbooks and any write of the groups of contacts are not here.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @param writeLimit The rate limit of the writes per key.
 * @returns The route definitions to mount on `/public/v1`.
 */
export function createPublicContactsRoutes(controller: PublicContactsController, idempotency: IdempotencyStore, writeLimit: RateLimitRule): RouteDefinition[] {
  const read = { kind: 'apiKey' as const, permission: 'contacts:read' as const, group: true as const };
  const write = { kind: 'apiKey' as const, permission: 'contacts:write' as const, group: true as const };
  const limited = [writeLimit];
  return [
    defineRoute({ method: 'GET', path: '/contacts', auth: read, middleware: [validateQuery(publicContactsQuery)], handler: controller.listContacts }),
    defineRoute({ method: 'POST', path: '/contacts', auth: write, rateLimit: limited, bodyLimit: CONTACT_BODY_LIMIT, middleware: [validateBody(publicCreateContactBody)], handler: idempotent(idempotency, controller.createContact) }),
    defineRoute({ method: 'GET', path: '/contacts/:contactId', auth: read, middleware: [validateParams(publicContactParams), validateQuery(object({}))], handler: controller.getContact }),
    defineRoute({ method: 'PATCH', path: '/contacts/:contactId', auth: write, rateLimit: limited, bodyLimit: CONTACT_BODY_LIMIT, middleware: [validateParams(publicContactParams), requireIfMatch, validateBody(publicPatchContactBody)], handler: controller.updateContact }),
    defineRoute({ method: 'POST', path: '/contacts/:contactId/trash', auth: write, rateLimit: limited, middleware: [validateParams(publicContactParams), requireIfMatch], handler: controller.trashContact }),
    defineRoute({ method: 'POST', path: '/contacts/:contactId/restore', auth: write, rateLimit: limited, middleware: [validateParams(publicContactParams), requireIfMatch], handler: controller.restoreContact }),
    defineRoute({ method: 'GET', path: '/contact-groups', auth: read, middleware: [validateQuery(publicContactGroupsQuery)], handler: controller.listContactGroups }),
    defineRoute({ method: 'GET', path: '/contact-groups/:contactGroupId', auth: read, middleware: [validateParams(publicContactGroupParams), validateQuery(object({}))], handler: controller.getContactGroup }),
  ];
}
