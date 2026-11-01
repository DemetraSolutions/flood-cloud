import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { IS_API_REQUEST } from './api-base-url.interceptor';
import { toApiError } from './api-error';

/**
 * Turns the HTTP failures of backend API requests into {@link ApiError}. Requests not marked
 * as API requests, and errors that are not HTTP failures, pass through unchanged.
 */
export const apiErrorInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.context.get(IS_API_REQUEST)) {
    return next(req);
  }
  return next(req).pipe(
    catchError((error: unknown) =>
      throwError(() => (error instanceof HttpErrorResponse ? toApiError(error) : error)),
    ),
  );
};
