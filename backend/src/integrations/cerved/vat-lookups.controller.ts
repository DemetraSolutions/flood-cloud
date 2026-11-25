import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { VatLookupParams } from './vat-lookups.schemas.ts';
import type { VatLookupsService } from './vat-lookups.service.ts';

/** HTTP handlers of the VAT lookup. */
export interface VatLookupsController {
  lookup: RequestHandler;
}

/**
 * Translates HTTP into {@link VatLookupsService} calls.
 *
 * @param service The service.
 */
export function createVatLookupsController(service: VatLookupsService): VatLookupsController {
  return {
    lookup: async (req, res) => {
      sendData(res, await service.lookup(res.locals.auth!, inputOf<VatLookupParams>(res, 'params').vatNumber, clientContextOf(req, res)));
    },
  };
}
