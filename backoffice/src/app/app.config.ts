import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, TitleStrategy } from '@angular/router';
import { apiBaseUrlInterceptor } from './core/api/api-base-url.interceptor';
import { apiErrorInterceptor } from './core/api/api-error.interceptor';
import { GlobalErrorHandler } from './core/errors/global-error-handler';
import { PageTitleStrategy } from './core/layout/page-title.strategy';
import { initializeApp } from './core/startup/app-initializer';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([apiBaseUrlInterceptor, apiErrorInterceptor])),
    provideRouter(routes),
    { provide: TitleStrategy, useClass: PageTitleStrategy },
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideAppInitializer(initializeApp),
  ],
};
