import type { Request, RequestHandler, Response } from 'express';
import { sendData } from '../../shared/http/envelope.ts';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import type { LoginBody, RefreshBody } from './auth.schemas.ts';
import type { NonBrowserGuard } from '../../shared/security/non-browser-signal.ts';
import type { AuthService, IssuedSession, SessionGate } from './auth.service.ts';

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
 * @param nonBrowser The guard of the requests that do not look like a browser's, or `undefined` when the signal is off. The service calls it once the user is certain (credentials verified, account in good
 * state) and before it writes anything: it reports the request and, under the policy `block`, refuses it (`BROWSER_REQUIRED`) with no session created and no refresh token rotated. A failed login or refresh
 * never reaches it, and its response is never changed.
 */
export function createAuthController(service: AuthService, nonBrowser?: NonBrowserGuard): AuthController {
  const gateOf = (req: Request, res: Response, source: 'login' | 'refresh'): SessionGate | undefined => (nonBrowser === undefined ? undefined : (subject) => nonBrowser(req, res, subject, source));
  return {
    login: async (req, res) => {
      const result = await service.login(inputOf<LoginBody>(res, 'body'), clientContextOf(req, res), gateOf(req, res, 'login'));
      sendData(res, { ...tokenResponse(result), passwordChangeRequired: result.passwordChangeRequired });
    },
    refresh: async (req, res) => {
      sendData(res, tokenResponse(await service.refresh(inputOf<RefreshBody>(res, 'body').refreshToken, clientContextOf(req, res), gateOf(req, res, 'refresh'))));
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
