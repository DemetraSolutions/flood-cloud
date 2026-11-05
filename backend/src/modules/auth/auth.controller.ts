import type { RequestHandler } from 'express';
import { sendData } from '../../shared/http/envelope.ts';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { LoginBody, RefreshBody } from './auth.schemas.ts';
import type { AuthService, IssuedSession } from './auth.service.ts';

/** The representation of a new token pair: ISO 8601 dates, the only response that carries tokens. */
function tokenResponse(session: IssuedSession) {
  return {
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
    refreshToken: session.refreshToken,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
    sessionId: session.sessionId,
  };
}

/** HTTP handlers of the authentication routes. */
export interface AuthController {
  login: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
  logoutAll: RequestHandler;
}

/**
 * Translates HTTP into {@link AuthService} calls.
 *
 * @param service The authentication service.
 */
export function createAuthController(service: AuthService): AuthController {
  return {
    login: async (req, res) => {
      const result = await service.login(inputOf<LoginBody>(res, 'body'), clientContextOf(req, res));
      sendData(res, { ...tokenResponse(result), passwordChangeRequired: result.passwordChangeRequired });
    },
    refresh: async (req, res) => {
      sendData(res, tokenResponse(await service.refresh(inputOf<RefreshBody>(res, 'body').refreshToken, clientContextOf(req, res))));
    },
    logout: async (req, res) => {
      const principal = res.locals.auth!;
      await service.logout(principal.userId, res.locals.sessionId!, actorOf(principal), principal.groupId, clientContextOf(req, res));
      res.status(204).end();
    },
    logoutAll: async (req, res) => {
      const principal = res.locals.auth!;
      await service.logoutAll(principal.userId, actorOf(principal), principal.groupId, clientContextOf(req, res));
      res.status(204).end();
    },
  };
}
