import { HttpEvent, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, Observable, switchMap, throwError } from 'rxjs';
import { IS_API_REQUEST } from '../api/api-base-url.interceptor';
import { ApiError } from '../api/api-error';
import { DpopProofs } from './dpop-proof';
import { SessionService } from './session.service';

const LOGIN_PATH = '/v1/auth/login';
const REFRESH_PATH = '/v1/auth/refresh';

/** The refresh token in the body of `POST /v1/auth/refresh`, `null` when the body has none. */
function refreshTokenOf(body: unknown): string | null {
  const value = (body as { refreshToken?: unknown } | null)?.refreshToken;
  return typeof value === 'string' ? value : null;
}

/**
 * Session handling for backend API calls (and only for them: `config.json`, dictionaries and
 * other hosts never receive a token or a proof).
 *
 * - Every API request carries a `DPoP` proof signed with the browser key of the session (D-33),
 *   built again on each attempt (new `jti` and `iat`, `ath` of the token in use). Login and
 *   refresh carry the proof but no `Authorization` header (the refresh proof binds the refresh
 *   token in the body with `rth`); every other call sends `Authorization: DPoP <token>`.
 * - `TOKEN_EXPIRED`: waits for the single shared refresh, then repeats the request once.
 * - `INVALID_DPOP_PROOF`: repeats the request once with a new proof (the clock has meanwhile
 *   been re-aligned from the error response); a second one ends the session. On login and
 *   refresh the error is left to the caller.
 * - `UNAUTHENTICATED`: ends the session without trying to refresh.
 * - `PASSWORD_CHANGE_REQUIRED`: moves the user to the change-password page.
 * - An authenticated call without a browser key ends the session.
 *
 * It must sit between `apiBaseUrlInterceptor` (which marks API requests) and
 * `apiErrorInterceptor` (which produces the `ApiError` it inspects).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.context.get(IS_API_REQUEST)) {
    return next(req);
  }
  const session = inject(SessionService);
  const proofs = inject(DpopProofs);
  const isRefresh = req.url.endsWith(REFRESH_PATH);
  const isCredentialCall = isRefresh || req.url.endsWith(LOGIN_PATH);
  const refreshToken = isRefresh ? refreshTokenOf(req.body) : null;

  const send = (tokenRetried: boolean, proofRetried: boolean): Observable<HttpEvent<unknown>> => {
    const token = isCredentialCall ? null : session.bearerToken();
    const key = session.signingKey();
    if (key === null) {
      if (token === null) {
        // Anonymous call without a key (not a credential call): nothing to sign with.
        return next(req);
      }
      session.expire();
      return throwError(
        () =>
          new ApiError({
            status: 401,
            code: 'UNAUTHENTICATED',
            message: 'No browser key for the session',
          }),
      );
    }
    const authorized =
      token === null ? req : req.clone({ setHeaders: { Authorization: `DPoP ${token}` } });
    return proofs
      .proof(key, { method: req.method, url: req.url, accessToken: token, refreshToken })
      .pipe(
        switchMap((proof) => next(authorized.clone({ setHeaders: { DPoP: proof } }))),
        catchError((error: unknown) => {
          if (!(error instanceof ApiError)) {
            return throwError(() => error);
          }
          if (error.code === 'INVALID_DPOP_PROOF') {
            if (!proofRetried) {
              return send(tokenRetried, true);
            }
            if (!isCredentialCall) {
              session.expire();
            }
          } else if (isCredentialCall) {
            return throwError(() => error);
          } else if (error.code === 'TOKEN_EXPIRED' && !tokenRetried) {
            return from(session.refreshOnce(token)).pipe(switchMap(() => send(true, proofRetried)));
          } else if (error.code === 'UNAUTHENTICATED') {
            session.expire();
          } else if (error.code === 'PASSWORD_CHANGE_REQUIRED') {
            session.requirePasswordChange();
          }
          return throwError(() => error);
        }),
      );
  };
  return send(false, false);
};
