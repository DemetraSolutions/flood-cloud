import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ClientErrorBody } from './client-errors.schemas.ts';
import type { ClientErrorsService } from './client-errors.service.ts';

/** HTTP handlers of the browser error reports. */
export interface ClientErrorsController {
  report: RequestHandler;
}

/**
 * Translates HTTP into {@link ClientErrorsService} calls.
 *
 * @param service The service.
 */
export function createClientErrorsController(service: ClientErrorsService): ClientErrorsController {
  return {
    report: async (req, res) => {
      await service.report(res.locals.auth!, inputOf<ClientErrorBody>(res, 'body'), clientContextOf(req, res));
      res.status(202).end();
    },
  };
}
