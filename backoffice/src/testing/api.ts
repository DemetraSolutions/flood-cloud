import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { apiBaseUrlInterceptor } from '../app/core/api/api-base-url.interceptor';
import { apiErrorInterceptor } from '../app/core/api/api-error.interceptor';
import { AppConfig } from '../app/core/config/app-config';
import { authInterceptor } from '../app/core/session/auth.interceptor';
import { SessionService } from '../app/core/session/session.service';
import { Profile } from '../app/core/session/session.types';
import { fakeProfile } from './session';

/** Base URL of the API in tests. */
export const API = 'https://api.test';

/** The real interceptor chain, in production order, over the testing HTTP backend. */
export function provideApiTesting() {
  return [
    provideHttpClient(
      withInterceptors([apiBaseUrlInterceptor, authInterceptor, apiErrorInterceptor]),
    ),
    provideHttpClientTesting(),
    { provide: AppConfig, useValue: { apiBaseUrl: signal(API).asReadonly() } },
  ];
}

/** A refresh token in the format the server issues (`fc_rt_` + 43 characters). */
export function refreshTokenOf(n: number): string {
  return `fc_rt_${String(n).padStart(43, '0')}`;
}

/** Body of a successful login or refresh; `n` makes the tokens distinguishable. */
export function tokenBody(n: number, extra: object = {}) {
  return {
    data: {
      accessToken: `fc_at_${n}`,
      accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
      refreshToken: refreshTokenOf(n),
      refreshTokenExpiresAt: '2099-01-08T00:00:00.000Z',
      sessionId: '665f1c2e9b1d4a0012ab34cd',
      ...extra,
    },
  };
}

/** Error envelope of the backend. */
export function errorBody(code: string, details?: { field: string; issue: string }[]) {
  return { error: { code, message: code, ...(details === undefined ? {} : { details }) } };
}

/** HTTP status of each error code used by the tests. */
const STATUS: Record<string, number> = {
  INVALID_CREDENTIALS: 401,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  PASSWORD_CHANGE_REQUIRED: 403,
  FORBIDDEN: 403,
  FEATURE_DISABLED: 403,
  CONFLICT: 409,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** Fails an expected request with the standard error envelope. */
export function failRequest(
  backend: HttpTestingController,
  url: string,
  code: string,
  options: { details?: { field: string; issue: string }[]; headers?: Record<string, string> } = {},
) {
  backend.expectOne(`${API}${url}`).flush(errorBody(code, options.details), {
    status: STATUS[code],
    statusText: code,
    headers: options.headers,
  });
}

/** Lets pending promise continuations run (HTTP calls issued after an `await`). */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The testing HTTP backend of the current TestBed. */
export function backend(): HttpTestingController {
  return TestBed.inject(HttpTestingController);
}

/** Signs a user in through the real login flow (login, then `GET /v1/me`), with token pair 1. */
export async function signInViaApi(profile: Profile = fakeProfile()): Promise<SessionService> {
  const session = TestBed.inject(SessionService);
  const done = session.login('mario.rossi', 'Secret-1234');
  backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
  await settle();
  backend().expectOne(`${API}/v1/me`).flush({ data: profile });
  await done;
  return session;
}
