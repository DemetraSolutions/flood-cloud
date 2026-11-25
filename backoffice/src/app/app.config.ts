import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, TitleStrategy, withComponentInputBinding } from '@angular/router';
import { apiBaseUrlInterceptor } from './core/api/api-base-url.interceptor';
import { apiErrorInterceptor } from './core/api/api-error.interceptor';
import { authInterceptor } from './core/session/auth.interceptor';
import { serverClockInterceptor } from './core/session/server-clock.interceptor';
import { GlobalErrorHandler } from './core/errors/global-error-handler';
import { PageTitleStrategy } from './core/layout/page-title.strategy';
import { initializeApp } from './core/startup/app-initializer';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Order matters: base URL marks API calls, then auth (DPoP proof, refresh) sees the ApiError
    // that the error interceptor produces; the clock interceptor, closest to the network, still
    // sees the raw response headers (`Date`).
    provideHttpClient(
      withInterceptors([
        apiBaseUrlInterceptor,
        authInterceptor,
        apiErrorInterceptor,
        serverClockInterceptor,
      ]),
    ),
    provideRouter(routes, withComponentInputBinding()),
    { provide: TitleStrategy, useClass: PageTitleStrategy },
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideAppInitializer(initializeApp),
  ],
};
