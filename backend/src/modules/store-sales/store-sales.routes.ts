import type { RequestHandler } from 'express';
import { requireIfMatch } from '../../shared/http/if-match.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';
import type { RateLimitRule } from '../../shared/security/rate-limit/rate-limit.ts';
import { validateBody, validateParams, validateQuery } from '../../shared/validation/middleware.ts';
import { SALE_BODY_LIMIT, cancelSaleBody, createSaleBody, patchSaleBody, refundSaleBody, saleIdParams, storeSalesQuery } from '../sales/sales.write.schemas.ts';
import type { StoreSalesController } from './store-sales.controller.ts';

/** The path of the sales of a store, under `/v1`. */
export const STORE_SALES_PATH = '/store-context/sales';

/**
 * The `If-Match` of a write of a store is optional: a till that was offline has no fresh tag. When it sends one it is checked (`422` when it is not a tag of ours, `412` when it is not the version of the sale); without it the last write wins.
 *
 * @param req The request.
 * @param res The response.
 * @param next Continues.
 */
const optionalIfMatch: RequestHandler = (req, res, next) => (req.get('if-match') === undefined ? next() : requireIfMatch(req, res, next));

/**
 * The check the route builder demands of every write of a store (`operator`): the sales do not use it. The operator of a sale is **declared in the body** (`operatorId`) and judged by the service, which never refuses a sale for it (an
 * unknown or inactive operator is an anomaly of the sale): the till has no `X-Operator-Id` to send for a sale that happened days ago.
 *
 * @param _req The request.
 * @param _res The response.
 * @param next Continues.
 */
const operatorInBody: RequestHandler = (_req, _res, next) => next();

/**
 * The routes of the sales for the server of a point of sale (`doc/Store-API.md`, step VS4a), all on `/v1` and only for a store key (`403 FORBIDDEN` to a user): creation (idempotent on the `timestampId`), search and detail, amendment, refunds, cancellation
 * and the deletion of a sale that is not fiscal. The point of sale of the key is the perimeter: a sale of another point of sale or group is `404`. The writes share a budget of their own (`rateLimit`), apart from the catalog and the contacts. A sale is never
 * refused for a business rule, so none of them has an `Idempotency-Key` (a till may be offline for days: the natural keys are the `timestampId` of the sale and of the refund, and the state of a cancellation).
 *
 * @param controller Handlers.
 * @param writeLimit The rate limit of the sales writes per store key.
 * @returns The route definitions to mount on `/v1`.
 */
export function createStoreSalesRoutes(controller: StoreSalesController, writeLimit: RateLimitRule): RouteDefinition[] {
  const read = { kind: 'store' as const, group: true as const };
  const write = { ...read, operator: operatorInBody };
  const one = { params: ['saleId'] as const };
  const sale = `${STORE_SALES_PATH}/:saleId`;
  return [
    defineRoute({ method: 'POST', path: STORE_SALES_PATH, auth: write, rateLimit: [writeLimit], bodyLimit: SALE_BODY_LIMIT, middleware: [validateBody(createSaleBody)], handler: controller.create }),
    defineRoute({ method: 'GET', path: STORE_SALES_PATH, auth: read, middleware: [validateQuery(storeSalesQuery)], handler: controller.search }),
    defineRoute({ method: 'GET', path: sale, auth: { ...read, ...one }, middleware: [validateParams(saleIdParams)], handler: controller.get }),
    defineRoute({ method: 'PATCH', path: sale, auth: { ...write, ...one }, rateLimit: [writeLimit], bodyLimit: SALE_BODY_LIMIT, middleware: [validateParams(saleIdParams), optionalIfMatch, validateBody(patchSaleBody)], handler: controller.amend }),
    defineRoute({ method: 'DELETE', path: sale, auth: { ...write, ...one }, rateLimit: [writeLimit], middleware: [validateParams(saleIdParams), optionalIfMatch], handler: controller.remove }),
    defineRoute({ method: 'POST', path: `${sale}/refunds`, auth: { ...write, ...one }, rateLimit: [writeLimit], bodyLimit: SALE_BODY_LIMIT, middleware: [validateParams(saleIdParams), optionalIfMatch, validateBody(refundSaleBody)], handler: controller.refund }),
    defineRoute({ method: 'POST', path: `${sale}/cancellation`, auth: { ...write, ...one }, rateLimit: [writeLimit], bodyLimit: SALE_BODY_LIMIT, middleware: [validateParams(saleIdParams), optionalIfMatch, validateBody(cancelSaleBody)], handler: controller.cancel }),
  ];
}
