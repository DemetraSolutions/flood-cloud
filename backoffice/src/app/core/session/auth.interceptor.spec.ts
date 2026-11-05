import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { throwError } from 'rxjs';
import {
  API,
  backend,
  errorBody,
  failRequest,
  provideApiTesting,
  refreshTokenOf,
  settle,
  signInViaApi,
  tokenBody,
} from '../../../testing/api';
import { ApiError } from '../api/api-error';
import { apiBaseUrlInterceptor } from '../api/api-base-url.interceptor';
import { AppConfig } from '../config/app-config';
import { I18nService } from '../i18n/i18n.service';
import { authInterceptor } from './auth.interceptor';
import { SessionService } from './session.service';

async function setup() {
  sessionStorage.clear();
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
  const session = await signInViaApi();
  return { session, navigate, navigateByUrl, http: TestBed.inject(HttpClient) };
}

/** Starts a GET and records how it ends. */
function get(http: HttpClient, url: string) {
  const outcome: { value?: unknown; error?: unknown } = {};
  http.get(url).subscribe({
    next: (value) => (outcome.value = value),
    error: (error: unknown) => (outcome.error = error),
  });
  return outcome;
}

describe('authInterceptor', () => {
  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
  });

  it('sends the bearer token to the API', async () => {
    const { http } = await setup();
    const outcome = get(http, '/v1/things');
    const request = backend().expectOne(`${API}/v1/things`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer fc_at_1');
    request.flush({ data: 1 });
    expect(outcome.value).toEqual({ data: 1 });
  });

  it('never sends the token to the configuration, the dictionaries or other hosts', async () => {
    const { http } = await setup();
    for (const url of ['/config.json', '/i18n/it.json', 'https://other.test/v1/things']) {
      get(http, url);
      const request = backend().expectOne(url);
      expect(request.request.headers.has('Authorization')).toBe(false);
      request.flush({});
    }
  });

  it('sends no token with the credential calls', async () => {
    const { http, session } = await setup();
    http.post('/v1/auth/login', {}).subscribe();
    const login = backend().expectOne(`${API}/v1/auth/login`);
    expect(login.request.headers.has('Authorization')).toBe(false);
    login.flush(tokenBody(1));
    http.post('/v1/auth/refresh', {}).subscribe();
    const refresh = backend().expectOne(`${API}/v1/auth/refresh`);
    expect(refresh.request.headers.has('Authorization')).toBe(false);
    refresh.flush(tokenBody(1));
    expect(session.bearerToken()).toBe('fc_at_1');
  });

  it('refreshes once on TOKEN_EXPIRED and repeats the request with the new token', async () => {
    const { http, session } = await setup();
    const outcome = get(http, '/v1/things');
    failRequest(backend(), '/v1/things', 'TOKEN_EXPIRED');
    await settle();
    const refresh = backend().expectOne(`${API}/v1/auth/refresh`);
    expect(refresh.request.body).toEqual({ refreshToken: refreshTokenOf(1) });
    refresh.flush(tokenBody(2));
    await settle();
    const retry = backend().expectOne(`${API}/v1/things`);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer fc_at_2');
    retry.flush({ data: 'ok' });
    expect(outcome.value).toEqual({ data: 'ok' });
    expect(outcome.error).toBeUndefined();
    expect(session.bearerToken()).toBe('fc_at_2');
  });

  it('shares a single refresh among concurrent requests and repeats each once', async () => {
    const { http } = await setup();
    const outcomes = ['/v1/a', '/v1/b', '/v1/c'].map((url) => get(http, url));
    for (const url of ['/v1/a', '/v1/b', '/v1/c']) {
      failRequest(backend(), url, 'TOKEN_EXPIRED');
    }
    await settle();
    backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
    await settle();
    for (const url of ['/v1/a', '/v1/b', '/v1/c']) {
      const retry = backend().expectOne(`${API}${url}`);
      expect(retry.request.headers.get('Authorization')).toBe('Bearer fc_at_2');
      retry.flush({ url });
    }
    expect(outcomes.map((o) => o.value)).toEqual([
      { url: '/v1/a' },
      { url: '/v1/b' },
      { url: '/v1/c' },
    ]);
  });

  it('does not refresh again for a late failure that used the replaced token', async () => {
    const { http } = await setup();
    const first = get(http, '/v1/a');
    const second = get(http, '/v1/b');
    failRequest(backend(), '/v1/a', 'TOKEN_EXPIRED');
    await settle();
    backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
    await settle();
    backend().expectOne(`${API}/v1/a`).flush({ ok: 'a' });
    failRequest(backend(), '/v1/b', 'TOKEN_EXPIRED');
    await settle();
    backend().expectNone(`${API}/v1/auth/refresh`);
    const retry = backend().expectOne(`${API}/v1/b`);
    expect(retry.request.headers.get('Authorization')).toBe('Bearer fc_at_2');
    retry.flush({ ok: 'b' });
    expect([first.value, second.value]).toEqual([{ ok: 'a' }, { ok: 'b' }]);
  });

  it('repeats a request only once: a second TOKEN_EXPIRED reaches the caller', async () => {
    const { http, session } = await setup();
    const outcome = get(http, '/v1/things');
    failRequest(backend(), '/v1/things', 'TOKEN_EXPIRED');
    await settle();
    backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
    await settle();
    failRequest(backend(), '/v1/things', 'TOKEN_EXPIRED');
    await settle();
    backend().expectNone(`${API}/v1/auth/refresh`);
    expect((outcome.error as ApiError).code).toBe('TOKEN_EXPIRED');
    expect(session.status()).toBe('authenticated');
  });

  it('ends the session when the refresh fails and the caller gets the error', async () => {
    const { http, session, navigate } = await setup();
    const outcome = get(http, '/v1/things');
    failRequest(backend(), '/v1/things', 'TOKEN_EXPIRED');
    await settle();
    failRequest(backend(), '/v1/auth/refresh', 'UNAUTHENTICATED');
    await settle();
    expect((outcome.error as ApiError).code).toBe('UNAUTHENTICATED');
    expect(session.status()).toBe('anonymous');
    expect(sessionStorage.getItem('fc.session')).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('ends the session on UNAUTHENTICATED without trying to refresh', async () => {
    const { http, session, navigate } = await setup();
    const outcome = get(http, '/v1/things');
    failRequest(backend(), '/v1/things', 'UNAUTHENTICATED');
    await settle();
    backend().expectNone(`${API}/v1/auth/refresh`);
    expect((outcome.error as ApiError).code).toBe('UNAUTHENTICATED');
    expect(session.status()).toBe('anonymous');
    expect(sessionStorage.getItem('fc.session')).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('moves to the change-password page on PASSWORD_CHANGE_REQUIRED', async () => {
    const { http, session, navigateByUrl } = await setup();
    const outcome = get(http, '/v1/things');
    failRequest(backend(), '/v1/things', 'PASSWORD_CHANGE_REQUIRED');
    expect((outcome.error as ApiError).code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(session.status()).toBe('passwordChangeRequired');
    expect(navigateByUrl).toHaveBeenCalledWith('/change-password');
  });

  it.each(['FORBIDDEN', 'NOT_FOUND', 'INTERNAL_ERROR'])(
    'leaves the session alone on %s',
    async (code) => {
      const { http, session, navigate, navigateByUrl } = await setup();
      const outcome = get(http, '/v1/things');
      failRequest(backend(), '/v1/things', code);
      expect((outcome.error as ApiError).code).toBe(code);
      expect(session.status()).toBe('authenticated');
      expect(navigate).not.toHaveBeenCalled();
      expect(navigateByUrl).not.toHaveBeenCalled();
    },
  );

  it('passes network failures through', async () => {
    const { http, session } = await setup();
    const outcome = get(http, '/v1/things');
    backend().expectOne(`${API}/v1/things`).error(new ProgressEvent('error'));
    expect((outcome.error as ApiError).code).toBe('NETWORK_ERROR');
    expect(session.status()).toBe('authenticated');
  });

  it('does not touch the login failures', async () => {
    const { http, session, navigate } = await setup();
    let error: unknown;
    http.post('/v1/auth/login', {}).subscribe({ error: (e: unknown) => (error = e) });
    backend()
      .expectOne(`${API}/v1/auth/login`)
      .flush(errorBody('INVALID_CREDENTIALS'), { status: 401, statusText: 'x' });
    expect((error as ApiError).code).toBe('INVALID_CREDENTIALS');
    expect(session.status()).toBe('authenticated');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rethrows errors that are not API errors as they are', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([
            apiBaseUrlInterceptor,
            authInterceptor,
            () => throwError(() => new Error('boom')),
          ]),
        ),
        provideHttpClientTesting(),
        { provide: AppConfig, useValue: { apiBaseUrl: signal(API) } },
      ],
    });
    TestBed.inject(HttpTestingController);
    const outcome = get(TestBed.inject(HttpClient), '/v1/things');
    expect(outcome.error).toEqual(new Error('boom'));
    expect(TestBed.inject(SessionService).status()).toBe('unknown');
  });
});

describe('interceptor order', () => {
  it('is registered between the base-URL and the error interceptors (order is relied upon)', () => {
    const source = readFileSync(`${process.cwd()}/src/app/app.config.ts`, 'utf8');
    expect(source).toMatch(
      /withInterceptors\(\[\s*apiBaseUrlInterceptor,\s*authInterceptor,\s*apiErrorInterceptor,?\s*\]\)/,
    );
  });
});
