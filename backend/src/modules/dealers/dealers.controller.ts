import type { RequestHandler } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData, sendPage } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { CreateDealerBody, DealersQuery, PatchDealerBody } from './dealers.schemas.ts';
import type { PriceOverridesBody } from '../settings/settings.schemas.ts';
import type { DealerPricesResult, DealersService } from './dealers.service.ts';

/** HTTP handlers of the dealer routes. */
export interface DealersController {
  list: RequestHandler;
  get: RequestHandler;
  create: RequestHandler;
  update: RequestHandler;
  getPriceOverrides: RequestHandler;
  putPriceOverrides: RequestHandler;
}

const dealerIdOf = (res: Parameters<RequestHandler>[1]): ObjectId => inputOf<{ dealerId: ObjectId }>(res, 'params').dealerId;

/** The overrides and the prices that result, in the `{ data }` envelope, with the `ETag` of the version of the overrides. */
function sendPrices(res: Parameters<RequestHandler>[1], result: DealerPricesResult): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, { overrides: result.overrides, effective: result.effective });
}

/**
 * Translates HTTP into {@link DealersService} calls.
 *
 * @param service The service.
 */
export function createDealersController(service: DealersService): DealersController {
  return {
    list: async (_req, res) => {
      const { items, page } = await service.list(inputOf<DealersQuery>(res, 'query'));
      sendPage(res, items, page);
    },
    get: async (_req, res) => {
      sendData(res, await service.get(dealerIdOf(res)));
    },
    create: async (req, res) => {
      const created = await service.create(res.locals.auth!, inputOf<CreateDealerBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/$/, '')}/${created.id}`);
      sendData(res, created, 201);
    },
    update: async (req, res) => {
      sendData(res, await service.update(res.locals.auth!, dealerIdOf(res), inputOf<PatchDealerBody>(res, 'body'), clientContextOf(req, res)));
    },
    getPriceOverrides: async (_req, res) => {
      sendPrices(res, await service.getPriceOverrides(dealerIdOf(res)));
    },
    putPriceOverrides: async (req, res) => {
      sendPrices(res, await service.replacePriceOverrides(res.locals.auth!, dealerIdOf(res), res.locals.ifMatch!, inputOf<PriceOverridesBody>(res, 'body'), clientContextOf(req, res)));
    },
  };
}
