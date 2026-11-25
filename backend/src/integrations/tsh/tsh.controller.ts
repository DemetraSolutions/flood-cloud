import type { RequestHandler } from 'express';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { callRequestOf } from '../place-call.ts';
import type { TshService } from './tsh.service.ts';

/** HTTP handlers of the TS Hospitality route. */
export interface TshController {
  sync: RequestHandler;
}

/**
 * Translates HTTP into {@link TshService} calls. The answer is the list of categories now stored, and its `ETag` is the new version of the place.
 *
 * @param service The service.
 */
export function createTshController(service: TshService): TshController {
  return {
    sync: async (req, res) => {
      const { categories, version } = await service.sync(callRequestOf(req, res), res.locals.ifMatch!);
      res.setHeader('ETag', entityTag(version));
      sendData(res, categories);
    },
  };
}
