import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Service, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { Observable, of, throwError } from 'rxjs';
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
import {
  decodeProof,
  provideDpopTesting,
  sha256Base64url,
  sharedKeyPair,
  verifyProof,
} from '../../../testing/dpop';
import { authInterceptor } from './auth.interceptor';
import { DpopKeys } from './dpop-key-store';
import { DpopProofs } from './dpop-proof';
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
    expect(request.request.headers.get('Authorization')).toBe('DPoP fc_at_1');
    request.flush({ data: 1 });
    expect(outcome.value).toEqual({ data: 1 });
  });

  it('never sends the token to the configuration, the dictionaries or other hosts', async () => {
    const { http } = await setup();
    for (const url of ['/config.json', '/i18n/it.json', 'https://other.test/v1/things']) {
      get(http, url);
      const request = backend().expectOne(url);
      expect(request.request.headers.has('Authorization')).toBe(false);
      expect(request.request.headers.has('DPoP')).toBe(false);
      request.flush({});
    }
  });

  it('sends no token with the credential calls', async () => {
    const { http, session } = await setup();
    http.post('/v1/auth/login', {}).subscribe();
    const login = backend().expectOne(`${API}/v1/auth/login`);
    expect(login.request.headers.has('Authorization')).toBe(false);
    expect(login.request.headers.has('DPoP')).toBe(true);
    login.flush(tokenBody(1));
    http.post('/v1/auth/refresh', {}).subscribe();
    const refresh = backend().expectOne(`${API}/v1/auth/refresh`);
    expect(refresh.request.headers.has('Authorization')).toBe(false);
    expect(refresh.request.headers.has('DPoP')).toBe(true);
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
    expect(retry.request.headers.get('Authorization')).toBe('DPoP fc_at_2');
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
      expect(retry.request.headers.get('Authorization')).toBe('DPoP fc_at_2');
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
    expect(retry.request.headers.get('Authorization')).toBe('DPoP fc_at_2');
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

/** Real proofs from the moment {@link ToggleProofs.real} is set (signing in stays synchronous). */
@Service()
class ToggleProofs extends DpopProofs {
  real = false;
  override proof(...args: Parameters<DpopProofs['proof']>): Observable<string> {
    return this.real ? super.proof(...args) : of('fake.dpop.proof');
  }
}

describe('authInterceptor DPoP proofs', () => {
  async function setupSigned() {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [...provideApiTesting(), { provide: DpopProofs, useClass: ToggleProofs }],
    });
    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => key);
    const session = await signInViaApi();
    (TestBed.inject(DpopProofs) as ToggleProofs).real = true;
    return { session, http: TestBed.inject(HttpClient) };
  }

  /** The next request to a URL, once its (asynchronous) proof has been signed. */
  const request = (url: string) =>
    vi.waitFor(() => backend().expectOne(`${API}${url}`), { interval: 1 });

  const proofOf = (req: { request: { headers: { get(name: string): string | null } } }) =>
    req.request.headers.get('DPoP') ?? '';

  afterEach(() => {
    backend().verify();
    vi.restoreAllMocks();
  });

  it('signs every API call with a valid proof bound to the method, the URL and the token', async () => {
    const { http } = await setupSigned();
    get(http, '/v1/things?cursor=abc&limit=2');
    const req = await request('/v1/things?cursor=abc&limit=2');
    const proof = proofOf(req);
    expect(req.request.headers.get('Authorization')).toBe('DPoP fc_at_1');
    expect(await verifyProof(proof, sharedKeyPair.publicKey)).toBe(true);
    const { header, claims } = decodeProof(proof);
    expect(header['typ']).toBe('dpop+jwt');
    expect(header['alg']).toBe('ES256');
    expect(claims['htm']).toBe('GET');
    expect(claims['htu']).toBe(`${API}/v1/things`);
    expect(claims['ath']).toBe(await sha256Base64url('fc_at_1'));
    expect(claims).not.toHaveProperty('rth');
    expect(Object.keys(claims).sort()).toEqual(['ath', 'htm', 'htu', 'iat', 'jti']);
    req.flush({});
  });

  it('proves the login with neither ath nor rth and sends no Authorization', async () => {
    const { http } = await setupSigned();
    http.post('/v1/auth/login', { username: 'u', password: 'p' }).subscribe();
    const req = await request('/v1/auth/login');
    const { claims } = decodeProof(proofOf(req));
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(claims['htm']).toBe('POST');
    expect(Object.keys(claims).sort()).toEqual(['htm', 'htu', 'iat', 'jti']);
    req.flush(tokenBody(1));
  });

  it('proves the refresh with rth of the token in the body, without ath or Authorization', async () => {
    const { http } = await setupSigned();
    http.post('/v1/auth/refresh', { refreshToken: refreshTokenOf(1) }).subscribe();
    const req = await request('/v1/auth/refresh');
    const { claims } = decodeProof(proofOf(req));
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(claims['rth']).toBe(await sha256Base64url(refreshTokenOf(1)));
    expect(claims).not.toHaveProperty('ath');
    req.flush(tokenBody(2));
  });

  it.each([[null], [{}], [{ refreshToken: 5 }]])(
    'adds no rth when the refresh body has no token (%j)',
    async (body) => {
      const { http } = await setupSigned();
      http.post('/v1/auth/refresh', body).subscribe({ error: () => undefined });
      const req = await request('/v1/auth/refresh');
      expect(decodeProof(proofOf(req)).claims).not.toHaveProperty('rth');
      req.flush(errorBody('BAD_REQUEST'), { status: 400, statusText: 'x' });
    },
  );

  it('signs a new proof for the repeated request, with the new token', async () => {
    const { http } = await setupSigned();
    const outcome = get(http, '/v1/things');
    const first = await request('/v1/things');
    const firstClaims = decodeProof(proofOf(first)).claims;
    first.flush(errorBody('TOKEN_EXPIRED'), { status: 401, statusText: 'x' });
    const refresh = await request('/v1/auth/refresh');
    refresh.flush(tokenBody(2));
    const retry = await request('/v1/things');
    const retryClaims = decodeProof(proofOf(retry)).claims;
    expect(retry.request.headers.get('Authorization')).toBe('DPoP fc_at_2');
    expect(retryClaims['jti']).not.toBe(firstClaims['jti']);
    expect(retryClaims['ath']).toBe(await sha256Base64url('fc_at_2'));
    expect(retryClaims['ath']).not.toBe(firstClaims['ath']);
    retry.flush({ data: 1 });
    expect(outcome.value).toEqual({ data: 1 });
  });

  it('uses the server clock for iat, learning it from successes and from errors', async () => {
    const { http } = await setupSigned();
    const ahead = (seconds: number) => new Date(Date.now() + seconds * 1000).toUTCString();
    const iatOf = (req: Parameters<typeof proofOf>[0]) =>
      decodeProof(proofOf(req)).claims['iat'] as number;
    const local = () => Math.floor(Date.now() / 1000);

    get(http, '/v1/a');
    const a = await request('/v1/a');
    expect(Math.abs(iatOf(a) - local())).toBeLessThanOrEqual(1);
    a.flush({}, { headers: { Date: ahead(300) } });

    get(http, '/v1/b');
    const b = await request('/v1/b');
    expect(Math.abs(iatOf(b) - (local() + 300))).toBeLessThanOrEqual(2);
    b.flush(errorBody('FORBIDDEN'), {
      status: 403,
      statusText: 'x',
      headers: { Date: ahead(-120) },
    });

    get(http, '/v1/c');
    const c = await request('/v1/c');
    expect(Math.abs(iatOf(c) - (local() - 120))).toBeLessThanOrEqual(2);
    c.flush({});
  });

  it('repeats a request once with a new proof on INVALID_DPOP_PROOF, with the clock re-aligned', async () => {
    const { http, session } = await setupSigned();
    const outcome = get(http, '/v1/things');
    const first = await request('/v1/things');
    first.flush(errorBody('INVALID_DPOP_PROOF'), {
      status: 401,
      statusText: 'x',
      headers: { Date: new Date(Date.now() + 120_000).toUTCString() },
    });
    const retry = await request('/v1/things');
    const firstClaims = decodeProof(proofOf(first)).claims;
    const retryClaims = decodeProof(proofOf(retry)).claims;
    expect(retryClaims['jti']).not.toBe(firstClaims['jti']);
    expect((retryClaims['iat'] as number) - (firstClaims['iat'] as number)).toBeGreaterThanOrEqual(
      118,
    );
    retry.flush({ data: 'ok' });
    expect(outcome.value).toEqual({ data: 'ok' });
    expect(session.status()).toBe('authenticated');
  });

  it('ends the session when the second proof is refused too', async () => {
    const { http, session } = await setupSigned();
    const outcome = get(http, '/v1/things');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      (await request('/v1/things')).flush(errorBody('INVALID_DPOP_PROOF'), {
        status: 401,
        statusText: 'x',
      });
    }
    await settle();
    backend().expectNone(`${API}/v1/things`);
    expect((outcome.error as ApiError).code).toBe('INVALID_DPOP_PROOF');
    expect(session.status()).toBe('anonymous');
  });

  it('repeats the login once on INVALID_DPOP_PROOF and then reports the error without ending anything', async () => {
    const { http, session } = await setupSigned();
    const expire = vi.spyOn(session, 'expire');
    let error: unknown;
    http.post('/v1/auth/login', {}).subscribe({ error: (e: unknown) => (error = e) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      (await request('/v1/auth/login')).flush(errorBody('INVALID_DPOP_PROOF'), {
        status: 401,
        statusText: 'x',
      });
    }
    await settle();
    expect((error as ApiError).code).toBe('INVALID_DPOP_PROOF');
    expect(expire).not.toHaveBeenCalled();
    expect(session.status()).toBe('authenticated');
  });

  it('rethrows a failure of the signing itself as it is', async () => {
    const { http, session } = await setupSigned();
    const failure = new Error('sign failed');
    vi.spyOn(TestBed.inject(DpopProofs), 'proof').mockReturnValue(throwError(() => failure));
    const outcome = get(http, '/v1/things');
    expect(outcome.error).toBe(failure);
    expect(session.status()).toBe('authenticated');
  });

  it('ends the session, without sending anything, when an authenticated call has no key', async () => {
    const { http, session } = await setupSigned();
    TestBed.inject(DpopKeys).forget();
    vi.spyOn(session, 'expire');
    const outcome = get(http, '/v1/things');
    backend().expectNone(`${API}/v1/things`);
    expect((outcome.error as ApiError).code).toBe('UNAUTHENTICATED');
    expect(session.expire).toHaveBeenCalledTimes(1);
  });

  it('lets an anonymous call without a key through, unsigned', () => {
    TestBed.configureTestingModule({ providers: provideApiTesting() });
    const http = TestBed.inject(HttpClient);
    get(http, '/v1/open');
    const req = backend().expectOne(`${API}/v1/open`);
    expect(req.request.headers.has('DPoP')).toBe(false);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
  });
});

describe('interceptor order', () => {
  it('is registered base URL, auth, error, clock (order is relied upon)', () => {
    const source = readFileSync(`${process.cwd()}/src/app/app.config.ts`, 'utf8');
    expect(source).toMatch(
      /withInterceptors\(\[\s*apiBaseUrlInterceptor,\s*authInterceptor,\s*apiErrorInterceptor,\s*serverClockInterceptor,?\s*\]\)/,
    );
  });
});
