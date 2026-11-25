import type { Request, RequestHandler, Response } from 'express';
import { sendData } from '../../shared/http/envelope.ts';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import { expectedHtu, invalidDpopProof, verifyDpopProof } from '../../shared/security/dpop.ts';
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

/** What the controller needs to verify the DPoP proofs of the login and the refresh. */
export interface AuthDpopOptions {
  /** `API_PUBLIC_BASE_URL`: the proof must name the public URL of the request (`htu`). */
  readonly apiPublicBaseUrl: string;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Translates HTTP into {@link AuthService} calls.
 *
 * The login verifies the DPoP proof (D-33) itself, before the service is called, so an invalid proof never reaches the user lookup or scrypt: no `ath`, no `rth` (the link is the password), `htm` `POST`, `htu` of
 * the request; the thumbprint of its key goes to the service, which binds the new session to it. A missing or invalid proof is `401 INVALID_DPOP_PROOF` and no event is recorded (the user is not known). The refresh
 * verifies the proof bound to the refresh token of the body (`rth`) and hands the result to the service, which decides the order of the rest.
 *
 * @param service The authentication service.
 * @param dpop Public base URL and clock for the proofs.
 * @param nonBrowser The guard of the requests that do not look like a browser's, or `undefined` when the signal is off. The service calls it once the user is certain (credentials verified, account in good
 * state) and before it writes anything: it reports the request and, under the policy `block`, refuses it (`BROWSER_REQUIRED`) with no session created and no refresh token rotated. A failed login or refresh
 * never reaches it, and its response is never changed.
 */
export function createAuthController(service: AuthService, dpop: AuthDpopOptions, nonBrowser?: NonBrowserGuard): AuthController {
  const verify = (req: Request, refreshToken?: string) =>
    verifyDpopProof(req.get('dpop'), { method: req.method, htu: expectedHtu(dpop.apiPublicBaseUrl, req.originalUrl), nowSeconds: Math.floor(dpop.now() / 1000), ...(refreshToken === undefined ? {} : { refreshToken }) });
  const gateOf = (req: Request, res: Response, source: 'login' | 'refresh'): SessionGate | undefined => (nonBrowser === undefined ? undefined : (subject) => nonBrowser(req, res, subject, source));
  return {
    login: async (req, res) => {
      const proof = verify(req);
      if (!proof.ok) {
        throw invalidDpopProof();
      }
      const result = await service.login({ ...inputOf<LoginBody>(res, 'body'), jkt: proof.proof.jkt }, clientContextOf(req, res), gateOf(req, res, 'login'));
      sendData(res, { ...tokenResponse(result), passwordChangeRequired: result.passwordChangeRequired });
    },
    refresh: async (req, res) => {
      const { refreshToken } = inputOf<RefreshBody>(res, 'body');
      sendData(res, tokenResponse(await service.refresh(refreshToken, verify(req, refreshToken), clientContextOf(req, res), gateOf(req, res, 'refresh'))));
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
