import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { IS_API_REQUEST } from '../api/api-base-url.interceptor';
import { ServerClock } from './server-clock';

/**
 * Feeds {@link ServerClock} with the `Date` header of every API response, successful or not.
 * It must be the innermost interceptor (after `apiErrorInterceptor`) so that it still sees the
 * raw `HttpResponse` and `HttpErrorResponse`.
 */
export const serverClockInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.context.get(IS_API_REQUEST)) {
    return next(req);
  }
  const clock = inject(ServerClock);
  return next(req).pipe(
    tap({
      next: (event) => {
        if (event instanceof HttpResponse) {
          clock.observe(event.headers.get('Date'));
        }
      },
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse) {
          clock.observe(error.headers.get('Date'));
        }
      },
    }),
  );
};
