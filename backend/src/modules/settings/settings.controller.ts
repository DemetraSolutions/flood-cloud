import type { RequestHandler, Response } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { PriceListBody, SecurityPolicyBody } from './settings.schemas.ts';
import type { PriceListResult, SecurityPolicyResult, SettingsService } from './settings.service.ts';

/** HTTP handlers of the settings routes. */
export interface SettingsController {
  getPriceList: RequestHandler;
  putPriceList: RequestHandler;
  getSecurityPolicy: RequestHandler;
  putSecurityPolicy: RequestHandler;
}

/** The price list in the `{ data }` envelope with the `ETag` of its version. */
function sendPriceList(res: Response, result: PriceListResult): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.list);
}

/** The security policy in the `{ data }` envelope with the `ETag` of its version. */
function sendSecurityPolicy(res: Response, result: SecurityPolicyResult): void {
  res.setHeader('ETag', entityTag(result.version));
  const { policy, limits } = result;
  sendData(res, { nonBrowserRequests: policy.nonBrowserRequests, sustainedLimits: policy.sustainedLimits, sources: policy.sources, limits });
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
    getSecurityPolicy: async (_req, res) => {
      sendSecurityPolicy(res, await service.getSecurityPolicy());
    },
    putSecurityPolicy: async (req, res) => {
      sendSecurityPolicy(res, await service.replaceSecurityPolicy(res.locals.auth!, res.locals.ifMatch!, inputOf<SecurityPolicyBody>(res, 'body'), clientContextOf(req, res), res.locals.nonBrowserReason));
    },
    putPriceList: async (req, res) => {
      sendPriceList(res, await service.replacePriceList(res.locals.auth!, res.locals.ifMatch!, inputOf<PriceListBody>(res, 'body'), clientContextOf(req, res)));
    },
  };
}
