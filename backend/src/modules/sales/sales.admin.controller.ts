import type { Request, RequestHandler, Response } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { SaleParams, SaleQuery } from './sales.schemas.ts';
import type { SalesAdminService } from './sales.admin.service.ts';
import type { AdminCreateSaleBody, CancelSaleBody, PatchSaleBody, RefundSaleBody } from './sales.write.schemas.ts';

/** HTTP handlers of the writes of the sales from the backoffice. */
export interface SalesAdminController {
  create: RequestHandler;
  amend: RequestHandler;
  refund: RequestHandler;
  cancel: RequestHandler;
  remove: RequestHandler;
}

const principalOf = (res: Response) => res.locals.auth!;
const accessOf = (res: Response) => res.locals.groupAccess!;
const saleIdOf = (res: Response) => inputOf<SaleParams>(res, 'params').saleId;
const modeOf = (res: Response) => inputOf<SaleQuery>(res, 'query').nonFiscal ?? 'exclude';
/** The version of `If-Match` (the route requires it). */
const expectedOf = (res: Response): string => res.locals.ifMatch as string;
const locationOf = (req: Request, suffix: string): string => `${req.baseUrl}${req.path.replace(/\/$/, '')}${suffix}`;

/**
 * Translates HTTP into {@link SalesAdminService} calls. A creation, a refund and a cancellation answer `201` with a `Location` the first time and `200` when they were already done; every response that carries a sale has the strong `ETag` of
 * its version (the `If-Match` of the next write). The user and the group access come from the locals set by the authentication, never from the request.
 *
 * @param service The service of the writes of the sales from the backoffice.
 */
export function createSalesAdminController(service: SalesAdminService): SalesAdminController {
  return {
    create: async (req, res) => {
      const { created, result } = await service.create(principalOf(res), accessOf(res), inputOf<AdminCreateSaleBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', locationOf(req, `/${result.id}`));
      res.setHeader('ETag', entityTag(result.version));
      sendData(res, result, created ? 201 : 200);
    },
    amend: async (req, res) => {
      const sale = await service.amend(principalOf(res), accessOf(res), saleIdOf(res), inputOf<PatchSaleBody>(res, 'body'), expectedOf(res), modeOf(res), clientContextOf(req, res));
      res.setHeader('ETag', entityTag(sale.version));
      sendData(res, sale);
    },
    refund: async (req, res) => {
      const body = inputOf<RefundSaleBody>(res, 'body');
      const { created, sale, refund } = await service.refund(principalOf(res), accessOf(res), saleIdOf(res), body, expectedOf(res), modeOf(res), clientContextOf(req, res));
      res.setHeader('Location', locationOf(req, `/${encodeURIComponent(body.timestampId)}`));
      res.setHeader('ETag', entityTag(sale.version));
      sendData(res, { sale, refund }, created ? 201 : 200);
    },
    cancel: async (req, res) => {
      const { created, sale } = await service.cancel(principalOf(res), accessOf(res), saleIdOf(res), inputOf<CancelSaleBody>(res, 'body'), expectedOf(res), modeOf(res), clientContextOf(req, res));
      res.setHeader('Location', locationOf(req, ''));
      res.setHeader('ETag', entityTag(sale.version));
      sendData(res, sale, created ? 201 : 200);
    },
    remove: async (req, res) => {
      await service.remove(principalOf(res), accessOf(res), saleIdOf(res), expectedOf(res), modeOf(res), clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
