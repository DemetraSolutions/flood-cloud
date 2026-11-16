import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import { idempotent } from '../../shared/http/idempotency.ts';
import type { IdempotencyStore } from '../../shared/http/idempotency.ts';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { EmailTemplatesController } from './email-templates.controller.ts';
import { EMAIL_TEMPLATES_BODY_LIMIT, createTemplateBody, patchTemplateBody, templateParams, templatesQuery } from './email-templates.schemas.ts';

/**
 * The e-mail template routes (`doc/Tasks.md` 9-bis, step T2), on a group that has the `email` feature (otherwise `403 FEATURE_DISABLED`, whatever the role). Reading is for whoever reads
 * places (`places:read`); creating, changing and deleting for whoever updates them (`places:update`). A modification needs `If-Match`; the creation is idempotent (`Idempotency-Key`). The
 * routes are not open to a store key (the default). The HTML of a template is only ever a JSON string of the response: no route serves it as `text/html`.
 *
 * @param controller Handlers.
 * @param idempotency The record of the idempotency keys.
 * @returns The route definitions to mount on `/v1`.
 */
export function createEmailTemplatesRoutes(controller: EmailTemplatesController, idempotency: IdempotencyStore): RouteDefinition[] {
  const auth = (permission: 'places:read' | 'places:update') => ({ kind: 'user' as const, permission, group: true, feature: 'email' as const });
  const one = '/groups/:groupId/email-templates/:templateId';
  return [
    defineRoute({ method: 'GET', path: '/groups/:groupId/email-templates', auth: auth('places:read'), middleware: [validateQuery(templatesQuery)], handler: controller.list }),
    defineRoute({ method: 'POST', path: '/groups/:groupId/email-templates', auth: auth('places:update'), bodyLimit: EMAIL_TEMPLATES_BODY_LIMIT, middleware: [validateBody(createTemplateBody)], handler: idempotent(idempotency, controller.create) }),
    defineRoute({ method: 'GET', path: one, auth: auth('places:read'), middleware: [validateParams(templateParams)], handler: controller.get }),
    defineRoute({ method: 'PATCH', path: one, auth: auth('places:update'), bodyLimit: EMAIL_TEMPLATES_BODY_LIMIT, middleware: [validateParams(templateParams), requireIfMatch, validateBody(patchTemplateBody)], handler: controller.update }),
    defineRoute({ method: 'DELETE', path: one, auth: auth('places:update'), middleware: [validateParams(templateParams)], handler: controller.remove }),
  ];
}
