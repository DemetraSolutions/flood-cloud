import type { RequestHandler, Response } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { PriceListBody } from './settings.schemas.ts';
import type { PriceListResult, SettingsService } from './settings.service.ts';

/** HTTP handlers of the settings routes. */
export interface SettingsController {
  getPriceList: RequestHandler;
  putPriceList: RequestHandler;
}

/** The price list in the `{ data }` envelope with the `ETag` of its version. */
function sendPriceList(res: Response, result: PriceListResult): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.list);
}

/**
 * Translates HTTP into {@link SettingsService} calls. Every response carries the `ETag` that is the `If-Match` of the next write.
 *
 * @param service The service.
 */
export function createSettingsController(service: SettingsService): SettingsController {
  return {
    getPriceList: async (_req, res) => {
      sendPriceList(res, await service.getPriceList());
    },
    putPriceList: async (req, res) => {
      sendPriceList(res, await service.replacePriceList(res.locals.auth!, res.locals.ifMatch!, inputOf<PriceListBody>(res, 'body'), clientContextOf(req, res)));
    },
  };
}
