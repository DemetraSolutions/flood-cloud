import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateQuery } from '../../shared/validation/middleware.ts';
import type { ErrorDocumentsController } from './error-documents.controller.ts';
import { errorDocumentsCsvQuery, errorDocumentsQuery } from './error-documents.schemas.ts';

/**
 * The routes of the electronic documents in error (`doc/Tasks.md` 9-ter, step 3), on `/v1`, both read only and for the PSA and the dealers (`errorDocuments:read` is only in their ceiling); the server
 * applies the perimeter of the role. They are not open to a store key (the default), and the CSV has its own rate limit per user. They are not on `/public/v1`.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createErrorDocumentsRoutes(controller: ErrorDocumentsController, rules: RateLimitRules): RouteDefinition[] {
  const auth = { kind: 'user' as const, permission: 'errorDocuments:read' as const };
  return [
    defineRoute({ method: 'GET', path: '/error-documents', auth, middleware: [validateQuery(errorDocumentsQuery)], handler: controller.list }),
    defineRoute({ method: 'GET', path: '/error-documents.csv', auth, rateLimit: [rules.errorDocumentsExportPerUser], middleware: [validateQuery(errorDocumentsCsvQuery)], handler: controller.csv }),
  ];
}
