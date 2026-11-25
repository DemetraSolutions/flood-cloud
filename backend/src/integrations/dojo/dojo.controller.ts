import type { RequestHandler } from 'express';
import { sendData } from '../../shared/http/envelope.ts';
import { callRequestOf } from '../place-call.ts';
import type { DojoService } from './dojo.service.ts';

/** HTTP handlers of the Dojo route. */
export interface DojoController {
  terminals: RequestHandler;
}

/**
 * Translates HTTP into {@link DojoService} calls.
 *
 * @param service The service.
 */
export function createDojoController(service: DojoService): DojoController {
  return {
    terminals: async (req, res) => {
      sendData(res, await service.listTerminals(callRequestOf(req, res)));
    },
  };
}
