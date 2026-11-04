import type { RequestHandler } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { ObjectId } from 'mongodb';
import type { ChangePasswordBody, PatchMeBody } from './me.schemas.ts';
import type { MeService } from './me.service.ts';

/** HTTP handlers of the `/v1/me` routes. */
export interface MeController {
  get: RequestHandler;
  patch: RequestHandler;
  changePassword: RequestHandler;
  listSessions: RequestHandler;
  revokeSession: RequestHandler;
}

/**
 * Translates HTTP into {@link MeService} calls.
 *
 * @param service The service.
 */
export function createMeController(service: MeService): MeController {
  return {
    get: async (_req, res) => {
      sendData(res, await service.getProfile(res.locals.auth!));
    },
    patch: async (req, res) => {
      sendData(res, await service.updateProfile(res.locals.auth!, inputOf<PatchMeBody>(res, 'body'), clientContextOf(req, res)));
    },
    changePassword: async (req, res) => {
      await service.changePassword(res.locals.auth!, res.locals.sessionId!, inputOf<ChangePasswordBody>(res, 'body'), clientContextOf(req, res));
      res.status(204).end();
    },
    listSessions: async (_req, res) => {
      sendData(res, await service.listSessions(res.locals.auth!, res.locals.sessionId!));
    },
    revokeSession: async (req, res) => {
      await service.revokeSession(res.locals.auth!, inputOf<{ sessionId: ObjectId }>(res, 'params').sessionId, clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
