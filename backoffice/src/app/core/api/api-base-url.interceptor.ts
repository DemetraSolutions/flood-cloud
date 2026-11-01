import { HttpContextToken, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AppConfig } from '../config/app-config';

/** Marks requests directed to the backend API; set by {@link apiBaseUrlInterceptor}. */
export const IS_API_REQUEST = new HttpContextToken<boolean>(() => false);

const API_PATH_PREFIX = '/v1/';

/**
 * Prefixes relative `/v1/` requests with the configured API base URL and marks them as API
 * requests. Any other request (config, dictionaries) is left untouched, so it stays same-origin.
 */
export const apiBaseUrlInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(API_PATH_PREFIX)) {
    return next(req);
  }
  const baseUrl = inject(AppConfig).apiBaseUrl();
  if (baseUrl === null) {
    throw new Error('The public configuration is not loaded: cannot resolve the API base URL.');
  }
  return next(
    req.clone({ url: `${baseUrl}${req.url}`, context: req.context.set(IS_API_REQUEST, true) }),
  );
};
