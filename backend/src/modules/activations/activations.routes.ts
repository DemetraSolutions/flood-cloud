import { AppError } from '../../shared/http/errors.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRules } from '../../shared/security/rate-limit/rules.ts';
import { validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import type { RequestHandler } from 'express';
import type { ActivationsController } from './activations.controller.ts';
import { detailCsvQuery, detailQuery, monthParams, statementCsvQuery, statementParams, statementQuery, summaryQuery, yearParams } from './activations.schemas.ts';

/** Body limit of the writes of the billing: they take no body. */
const NO_BODY_LIMIT = '1kb';

/** Refuses a body: the writes of the billing are state changes named by the path, and anything sent with them is a mistake or an attack. */
const refuseBody: RequestHandler = (req, _res, next) => {
  const body: unknown = req.body;
  if (body !== undefined && !(typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0)) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: '(body)', issue: 'unknown' }] });
  }
  next();
};

/**
 * The routes of the activations and of the billing of the dealers, on `/v1`. Reading is the PSA's and the dealers' (`activations:read`; a dealer is forced to his own data by the service); freezing a renewal base and closing a
 * month are the PSA's alone (`activations:manage`, only in his ceiling), rate limited per user, and take no body. The CSV has its own rate limit per user and is declared before the statement, so the path ending in `.csv` is
 * never read as a dealer. None is open to a store key (the default) or on `/public/v1`.
 *
 * @param controller Handlers.
 * @param rules Rate limit rules.
 * @returns The route definitions to mount on `/v1`.
 */
export function createActivationsRoutes(controller: ActivationsController, rules: Pick<RateLimitRules, 'activationsAdminPerUser' | 'activationsExportPerUser'>): RouteDefinition[] {
  const read = { kind: 'user' as const, permission: 'activations:read' as const };
  const manage = { auth: { kind: 'user' as const, permission: 'activations:manage' as const }, bodyLimit: NO_BODY_LIMIT, rateLimit: [rules.activationsAdminPerUser] };
  return [
    defineRoute({ method: 'GET', path: '/activations', auth: read, middleware: [validateQuery(summaryQuery)], handler: controller.summary }),
    defineRoute({ method: 'GET', path: '/activations/lines.csv', auth: read, rateLimit: [rules.activationsExportPerUser], middleware: [validateQuery(detailCsvQuery)], handler: controller.detailCsv }),
    defineRoute({ method: 'GET', path: '/activations/lines', auth: read, middleware: [validateQuery(detailQuery)], handler: controller.detail }),
    defineRoute({ method: 'GET', path: '/activations/statements/:dealerId.csv', auth: read, rateLimit: [rules.activationsExportPerUser], middleware: [validateParams(statementParams), validateQuery(statementCsvQuery)], handler: controller.statementCsv }),
    defineRoute({ method: 'GET', path: '/activations/statements/:dealerId', auth: read, middleware: [validateParams(statementParams), validateQuery(statementQuery)], handler: controller.statement }),
    defineRoute({ method: 'PUT', path: '/activations/renewal-bases/:year', ...manage, middleware: [validateParams(yearParams), refuseBody], handler: controller.freezeBase }),
    defineRoute({ method: 'DELETE', path: '/activations/renewal-bases/:year', ...manage, middleware: [validateParams(yearParams), refuseBody], handler: controller.unfreezeBase }),
    defineRoute({ method: 'PUT', path: '/activations/closures/:month', ...manage, middleware: [validateParams(monthParams), refuseBody], handler: controller.closeMonth }),
    defineRoute({ method: 'DELETE', path: '/activations/closures/:month', ...manage, middleware: [validateParams(monthParams), refuseBody], handler: controller.reopenMonth }),
  ];
}
