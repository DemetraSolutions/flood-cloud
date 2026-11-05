import { HttpEvent, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, Observable, switchMap, throwError } from 'rxjs';
import { IS_API_REQUEST } from '../api/api-base-url.interceptor';
import { ApiError } from '../api/api-error';
import { SessionService } from './session.service';

/** Credential-issuing calls: they carry no `Authorization` header and never trigger a refresh. */
const PUBLIC_AUTH_PATHS = ['/v1/auth/login', '/v1/auth/refresh'];

function withBearer<T>(req: HttpRequest<T>, token: string | null): HttpRequest<T> {
  return token === null ? req : req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

/**
 * Session handling for backend API calls (and only for them: `config.json`, dictionaries and
 * other hosts never receive the token).
 *
 * - Adds `Authorization: Bearer` except on login and refresh.
 * - `TOKEN_EXPIRED`: waits for the single shared refresh, then repeats the request once.
 * - `UNAUTHENTICATED`: ends the session without trying to refresh.
 * - `PASSWORD_CHANGE_REQUIRED`: moves the user to the change-password page.
 *
 * It must sit between `apiBaseUrlInterceptor` (which marks API requests) and
 * `apiErrorInterceptor` (which produces the `ApiError` it inspects).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (
    !req.context.get(IS_API_REQUEST) ||
    PUBLIC_AUTH_PATHS.some((path) => req.url.endsWith(path))
  ) {
    return next(req);
  }
  const session = inject(SessionService);

  const send = (retried: boolean): Observable<HttpEvent<unknown>> => {
    const token = session.bearerToken();
    return next(withBearer(req, token)).pipe(
      catchError((error: unknown) => {
        if (!(error instanceof ApiError)) {
          return throwError(() => error);
        }
        if (error.code === 'TOKEN_EXPIRED' && !retried) {
          return from(session.refreshOnce(token)).pipe(switchMap(() => send(true)));
        }
        if (error.code === 'UNAUTHENTICATED') {
          session.expire();
        } else if (error.code === 'PASSWORD_CHANGE_REQUIRED') {
          session.requirePasswordChange();
        }
        return throwError(() => error);
      }),
    );
  };
  return send(false);
};
