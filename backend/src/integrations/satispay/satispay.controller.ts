import type { RequestHandler } from 'express';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { callRequestOf } from '../place-call.ts';
import type { ActivationBody } from './satispay.schemas.ts';
import type { SatispayService } from './satispay.service.ts';

/** HTTP handlers of the Satispay route. */
export interface SatispayController {
  activate: RequestHandler;
}

/**
 * Translates HTTP into {@link SatispayService} calls. The answer says only that the key was set (`keyIdSet`): the key id is never sent back, and so never kept by the idempotency record. The `ETag` is the new
 * version of the place, only when the place had not changed meanwhile.
 *
 * @param service The service.
 */
export function createSatispayController(service: SatispayService): SatispayController {
  return {
    activate: async (req, res) => {
      const version = await service.activate(callRequestOf(req, res), res.locals.ifMatch!, inputOf<ActivationBody>(res, 'body').activationCode);
      if (version !== null) {
        res.setHeader('ETag', entityTag(version));
      }
      sendData(res, { keyIdSet: true });
    },
  };
}
