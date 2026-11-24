import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ActivationBody, ActivationCodeBody } from './store-keys.schemas.ts';
import { toStoreKeyStatus } from './store-keys.mapper.ts';
import type { StoreKeysService } from './store-keys.service.ts';

/** HTTP handlers of the store key routes. */
export interface StoreKeysController {
  status: RequestHandler;
  createCode: RequestHandler;
  cancelCode: RequestHandler;
  revoke: RequestHandler;
  exchange: RequestHandler;
  context: RequestHandler;
}

const placeIdOf = (res: Response): ObjectId => inputOf<{ placeId: ObjectId }>(res, 'params').placeId;

/**
 * Translates HTTP into {@link StoreKeysService} calls. The responses that carry a secret (the code, the key) are marked by their routes `compress: false`.
 *
 * @param service The service.
 * @param now Clock in epoch milliseconds, for the validity of the pending code shown by the status.
 */
export function createStoreKeysController(service: StoreKeysService, now: () => number): StoreKeysController {
  return {
    status: async (_req, res) => {
      sendData(res, toStoreKeyStatus(await service.status(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), new Date(now()))));
    },
    createCode: async (req, res) => {
      const issued = await service.createActivationCode(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), clientContextOf(req, res), inputOf<ActivationCodeBody>(res, 'body').confirmReplaceActiveKey === true);
      res.setHeader('Location', `${req.baseUrl}${req.path.replace(/\/activation-codes\/?$/, '')}`);
      sendData(res, { code: issued.code, expiresAt: issued.expiresAt.toISOString() }, 201);
    },
    cancelCode: async (req, res) => {
      await service.cancelActivationCode(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), clientContextOf(req, res));
      res.status(204).end();
    },
    revoke: async (req, res) => {
      await service.revoke(res.locals.auth!, res.locals.groupAccess!, placeIdOf(res), clientContextOf(req, res));
      res.status(204).end();
    },
    exchange: async (req, res) => {
      const activated = await service.exchange(inputOf<ActivationBody>(res, 'body'), clientContextOf(req, res));
      res.setHeader('Location', `${req.baseUrl}/store-context`);
      sendData(
        res,
        { key: activated.key, keyId: activated.keyId.toHexString(), groupId: activated.groupId.toHexString(), companyId: activated.companyId.toHexString(), placeId: activated.placeId.toHexString() },
        201,
      );
    },
    context: (_req, res) => {
      const store = res.locals.store!;
      sendData(res, {
        groupId: store.groupId.toHexString(),
        companyId: store.companyId.toHexString(),
        placeId: store.placeId.toHexString(),
        keyId: store.keyId.toHexString(),
        activatedAt: store.activatedAt.toISOString(),
      });
    },
  };
}
