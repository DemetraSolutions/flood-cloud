import type { Request, RequestHandler, Response } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { storeCallerOf } from '../store-catalog/store-catalog.service.ts';
import type { SalesWriteContext, SalesWriteService } from '../sales/sales.write.service.ts';
import type { CancelSaleBody, CreateSaleBody, PatchSaleBody, RefundSaleBody, SaleIdParams, StoreSalesQuery } from '../sales/sales.write.schemas.ts';

/** HTTP handlers of the sales routes of the server of a point of sale. */
export interface StoreSalesController {
  create: RequestHandler;
  search: RequestHandler;
  get: RequestHandler;
  amend: RequestHandler;
  remove: RequestHandler;
  refund: RequestHandler;
  cancel: RequestHandler;
}

/** The context of an operation: the caller, the group access, the company and the point of sale come from the store principal the route builder verified, never from the request. */
function contextOf(req: Request, res: Response): SalesWriteContext {
  const store = res.locals.store!;
  return { caller: storeCallerOf(store, null), access: res.locals.groupAccess!, companyId: store.companyId, placeId: store.placeId, request: clientContextOf(req, res), store };
}

const saleIdOf = (res: Response) => inputOf<SaleIdParams>(res, 'params').saleId;
/** The version of `If-Match`, `null` when the till sent none. */
const expectedOf = (res: Response): string | null => (res.locals.ifMatch as string | undefined) ?? null;
const locationOf = (req: Request, suffix: string): string => `${req.baseUrl}${req.path.replace(/\/$/, '')}${suffix}`;

/**
 * Translates HTTP into {@link SalesWriteService} calls. A creation, a refund and a cancellation answer `201` with a `Location` the first time and `200` when they were already done; every response that carries a sale has the `ETag` of its version.
 *
 * @param service The service of the sales.
 */
export function createStoreSalesController(service: SalesWriteService): StoreSalesController {
  return {
    create: async (req, res) => {
      const { created, result } = await service.create(contextOf(req, res), inputOf<CreateSaleBody>(res, 'body'));
      if ('status' in result) {
        // The key of a sale that was deleted: nothing is made, the till learns it (never an error: its queue must go on).
        sendData(res, result);
        return;
      }
      res.setHeader('Location', locationOf(req, `/${result.id}`));
      res.setHeader('ETag', entityTag(result.version));
      sendData(res, result, created ? 201 : 200);
    },
    search: async (req, res) => {
      const query = inputOf<StoreSalesQuery>(res, 'query');
      sendPage(res, await service.search(contextOf(req, res), query), { limit: query.limit ?? 10, next: null });
    },
    get: async (req, res) => {
      const sale = await service.get(contextOf(req, res), saleIdOf(res));
      res.setHeader('ETag', entityTag(sale.version));
      sendData(res, sale);
    },
    amend: async (req, res) => {
      const sale = await service.amend(contextOf(req, res), saleIdOf(res), inputOf<PatchSaleBody>(res, 'body'), expectedOf(res));
      res.setHeader('ETag', entityTag(sale.version));
      sendData(res, sale);
    },
    remove: async (req, res) => {
      await service.remove(contextOf(req, res), saleIdOf(res), expectedOf(res));
      res.status(204).end();
    },
    refund: async (req, res) => {
      const body = inputOf<RefundSaleBody>(res, 'body');
      const { created, sale, refund } = await service.refund(contextOf(req, res), saleIdOf(res), body, expectedOf(res));
      res.setHeader('Location', locationOf(req, `/${encodeURIComponent(body.timestampId)}`));
      res.setHeader('ETag', entityTag(sale.version));
      sendData(res, { sale, refund }, created ? 201 : 200);
    },
    cancel: async (req, res) => {
      const { created, sale } = await service.cancel(contextOf(req, res), saleIdOf(res), inputOf<CancelSaleBody>(res, 'body'), expectedOf(res));
      res.setHeader('Location', locationOf(req, ''));
      res.setHeader('ETag', entityTag(sale.version));
      sendData(res, sale, created ? 201 : 200);
    },
  };
}
