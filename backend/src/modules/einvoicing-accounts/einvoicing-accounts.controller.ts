import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { entityTag } from '../../shared/http/if-match.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { AccountTarget } from './aruba-account.ts';
import type { ArubaAccountBody } from './einvoicing-accounts.schemas.ts';
import type { AccountResult, EInvoicingAccountsService } from './einvoicing-accounts.service.ts';

/** The three handlers of one kind of account. */
export interface AccountHandlers {
  get: RequestHandler;
  put: RequestHandler;
  delete: RequestHandler;
}

/** HTTP handlers of the Aruba account routes: a dealer's (the dealer in the path) and the platform's. */
export interface EInvoicingAccountsController {
  dealer: AccountHandlers;
  platform: AccountHandlers;
}

/** The account in the `{ data }` envelope with the `ETag` of its version. */
function sendAccount(res: Response, result: AccountResult): void {
  res.setHeader('ETag', entityTag(result.version));
  sendData(res, result.view);
}

/**
 * Translates HTTP into {@link EInvoicingAccountsService} calls.
 *
 * @param service The service.
 */
export function createEInvoicingAccountsController(service: EInvoicingAccountsService): EInvoicingAccountsController {
  const handlersFor = (targetOf: (res: Response) => AccountTarget): AccountHandlers => ({
    get: async (_req, res) => {
      sendAccount(res, await service.get(targetOf(res)));
    },
    put: async (req, res) => {
      sendAccount(res, await service.save(res.locals.auth!, targetOf(res), res.locals.ifMatch!, inputOf<ArubaAccountBody>(res, 'body'), clientContextOf(req, res)));
    },
    delete: async (req, res) => {
      await service.remove(res.locals.auth!, targetOf(res), res.locals.ifMatch!, clientContextOf(req, res));
      res.status(204).end();
    },
  });
  return {
    dealer: handlersFor((res) => ({ kind: 'dealer', dealerId: inputOf<{ dealerId: ObjectId }>(res, 'params').dealerId })),
    platform: handlersFor(() => ({ kind: 'platform' })),
  };
}
