import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { throwError } from 'rxjs';
import {
  API,
  backend,
  failRequest,
  provideApiTesting,
  refreshTokenOf,
  settle,
  tokenBody,
} from '../../../testing/api';
import { fakeProfile } from '../../../testing/session';
import { ApiError } from '../api/api-error';
import { I18nService } from '../i18n/i18n.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { installFakeLocks, FakeLocks } from '../../../testing/locks';
import { DPOP_KEY_RECORDS } from './dpop-key-store';
import { MemoryKeyRecords, sharedKeyPair } from '../../../testing/dpop';
import { SessionService } from './session.service';

const keyRecords = () => TestBed.inject(DPOP_KEY_RECORDS) as MemoryKeyRecords;

const SESSION_ID = '665f1c2e9b1d4a0012ab34cd';

function setup() {
  TestBed.configureTestingModule({ providers: provideApiTesting() });
  if (sessionStorage.getItem('fc.session') !== null) {
    keyRecords().map.set(SESSION_ID, {
      sessionId: SESSION_ID,
      keyPair: sharedKeyPair,
      createdAt: Date.now(),
    });
  }
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
  const navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  vi.spyOn(TestBed.inject(I18nService), 't').mockImplementation((key) => `[${key}]`);
  return { session: TestBed.inject(SessionService), router, navigate, navigateByUrl };
}

/** Logs in through the real flow and returns the service. */
async function signedIn(profile = fakeProfile()) {
  const ctx = setup();
  const done = ctx.session.login('mario.rossi', 'Secret-1234');
  await settle();
  backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
  await settle();
  backend().expectOne(`${API}/v1/me`).flush({ data: profile });
  await done;
  return ctx;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  backend().verify();
  vi.restoreAllMocks();
});

describe('SessionService language', () => {
  const profileIn = (language: string) => ({ ...fakeProfile(), language });

  it('switches the dictionary and saves the preference when the profile language differs', () => {
    const { session } = setup();
    const i18n = TestBed.inject(I18nService);
    vi.spyOn(i18n, 'language').mockReturnValue('it');
    const select = vi.spyOn(i18n, 'select').mockResolvedValue();
    session.setProfile(profileIn('it'));
    expect(select).not.toHaveBeenCalled();
    session.setProfile(profileIn('xx'));
    expect(select).not.toHaveBeenCalled();
    vi.spyOn(i18n, 'language').mockReturnValue('en' as never);
    session.setProfile(profileIn('it'));
    expect(select).toHaveBeenCalledWith('it');
  });

  it('does nothing while no dictionary is loaded', () => {
    const { session } = setup();
    const select = vi.spyOn(TestBed.inject(I18nService), 'select').mockResolvedValue();
    session.setProfile(profileIn('it'));
    expect(select).not.toHaveBeenCalled();
  });

  it('logs and notifies the user when the dictionary cannot be loaded', async () => {
    const { session } = setup();
    const i18n = TestBed.inject(I18nService);
    vi.spyOn(i18n, 'language').mockReturnValue('en' as never);
    const failure = new Error('network');
    vi.spyOn(i18n, 'select').mockRejectedValue(failure);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    session.setProfile(profileIn('it'));
    await settle();
    expect(log).toHaveBeenCalledWith(failure);
    expect(TestBed.inject(ToastService).toasts().length).toBe(1);
  });
});

describe('SessionService', () => {
  it('applies the theme of the profile, and keeps the current one when it is not valid', async () => {
    const { session } = await signedIn(fakeProfile({ theme: 'dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    session.setProfile({ ...fakeProfile(), theme: 'neon' as never });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    session.setProfile(fakeProfile({ theme: 'system' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('starts unknown, without user, permissions or token', () => {
    const { session } = setup();
    expect(session.status()).toBe('unknown');
    expect(session.me()).toBeNull();
    expect(session.isAuthenticated()).toBe(false);
    expect(session.can('profile:read')).toBe(false);
    expect(session.bearerToken()).toBeNull();
  });

  describe('login', () => {
    it('signs in, then loads the profile with the new token', async () => {
      const { session } = setup();
      sessionStorage.setItem('fc.lastGroupId', '665f1c2e9b1d4a0012ab34a1');
      sessionStorage.setItem('fc.lastGroupName', 'Left by an earlier session');
      const done = session.login('mario.rossi', 'Secret-1234');
      await settle();
      const login = backend().expectOne(`${API}/v1/auth/login`);
      expect(sessionStorage.getItem('fc.lastGroupId')).not.toBeNull();
      expect(login.request.method).toBe('POST');
      expect(login.request.body).toEqual({ username: 'mario.rossi', password: 'Secret-1234' });
      expect(login.request.headers.has('Authorization')).toBe(false);
      login.flush(tokenBody(1, { passwordChangeRequired: false }));
      await settle();
      const me = backend().expectOne(`${API}/v1/me`);
      expect(me.request.headers.get('Authorization')).toBe('DPoP fc_at_1');
      me.flush({ data: fakeProfile() });
      await done;
      expect(session.status()).toBe('authenticated');
      expect(session.isAuthenticated()).toBe(true);
      expect(session.me()?.username).toBe('mario.rossi');
      expect(session.can('profile:read')).toBe(true);
      expect(session.can('users:read')).toBe(false);
      expect(session.bearerToken()).toBe('fc_at_1');
      expect(sessionStorage.getItem('fc.lastGroupId')).toBeNull();
      expect(sessionStorage.getItem('fc.lastGroupName')).toBeNull();
    });

    it('keeps only the refresh token in sessionStorage, never the access token', async () => {
      await signedIn();
      const stored = sessionStorage.getItem('fc.session') ?? '';
      expect(JSON.parse(stored)).toEqual({
        sessionId: '665f1c2e9b1d4a0012ab34cd',
        refreshToken: refreshTokenOf(1),
        refreshTokenExpiresAt: '2099-01-08T00:00:00.000Z',
      });
      expect(stored).not.toContain('fc_at_');
      expect(JSON.stringify(localStorage)).not.toContain('fc_');
    });

    it('reports a temporary password through the status', async () => {
      const { session } = await signedIn(fakeProfile({ passwordChangeRequired: true }));
      expect(session.status()).toBe('passwordChangeRequired');
      expect(session.isAuthenticated()).toBe(true);
    });

    it('rejects wrong credentials and leaves nothing behind', async () => {
      const { session } = setup();
      const done = session.login('mario.rossi', 'wrong');
      await settle();
      failRequest(backend(), '/v1/auth/login', 'INVALID_CREDENTIALS');
      await expect(done).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(session.bearerToken()).toBeNull();
      expect(sessionStorage.getItem('fc.session')).toBeNull();
    });

    it.each([
      ['no body', null],
      ['no data', {}],
      [
        'a missing session id',
        { data: { accessToken: 'a', refreshToken: 'b', refreshTokenExpiresAt: 'c' } },
      ],
      [
        'a missing access token',
        { data: { sessionId: 's', refreshToken: 'a', refreshTokenExpiresAt: 'b' } },
      ],
      [
        'a missing refresh token',
        { data: { sessionId: 's', accessToken: 'a', refreshTokenExpiresAt: 'b' } },
      ],
      ['a missing expiry', { data: { sessionId: 's', accessToken: 'a', refreshToken: 'b' } }],
    ])('rejects a response with %s', async (_label, body) => {
      const { session } = setup();
      const done = session.login('u', 'p');
      await settle();
      backend().expectOne(`${API}/v1/auth/login`).flush(body);
      await expect(done).rejects.toThrow('Unexpected authentication response');
      expect(session.bearerToken()).toBeNull();
      expect(sessionStorage.getItem('fc.session')).toBeNull();
    });

    it('ends the session when the profile cannot be loaded', async () => {
      const { session } = setup();
      const done = session.login('u', 'p');
      await settle();
      backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
      await settle();
      failRequest(backend(), '/v1/me', 'INTERNAL_ERROR');
      await settle();
      const logout = backend().expectOne(`${API}/v1/auth/logout`);
      expect(logout.request.headers.get('Authorization')).toBe('DPoP fc_at_1');
      logout.flush(null, { status: 204, statusText: 'No Content' });
      await expect(done).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(session.status()).toBe('anonymous');
      expect(session.bearerToken()).toBeNull();
      expect(sessionStorage.getItem('fc.session')).toBeNull();
    });
  });

  it('logs only "unexpected" when revoking a half-open login fails oddly', async () => {
    const { session } = setup();
    const done = session.login('u', 'p');
    await settle();
    backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
    await settle();
    vi.spyOn(TestBed.inject(HttpClient), 'post').mockReturnValue(throwError(() => new Error('x')));
    failRequest(backend(), '/v1/me', 'INTERNAL_ERROR');
    await expect(done).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(console.warn).toHaveBeenCalledWith('Revoking the session failed', 'unexpected');
  });

  describe('refreshOnce', () => {
    it('shares one request among concurrent callers and rotates the tokens', async () => {
      const { session } = await signedIn();
      const all = Promise.all([
        session.refreshOnce(),
        session.refreshOnce(),
        session.refreshOnce(),
      ]);
      const refresh = backend().expectOne(`${API}/v1/auth/refresh`);
      expect(refresh.request.body).toEqual({ refreshToken: refreshTokenOf(1) });
      expect(refresh.request.headers.has('Authorization')).toBe(false);
      refresh.flush(tokenBody(2));
      await all;
      expect(session.bearerToken()).toBe('fc_at_2');
      expect(JSON.parse(sessionStorage.getItem('fc.session') ?? '{}').refreshToken).toBe(
        refreshTokenOf(2),
      );
    });

    it('can refresh again after the previous refresh finished', async () => {
      const { session } = await signedIn();
      for (const n of [2, 3]) {
        const done = session.refreshOnce();
        backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(n));
        await done;
      }
      expect(session.bearerToken()).toBe('fc_at_3');
    });

    it('does not refresh when the failed request used an already replaced token', async () => {
      const { session } = await signedIn();
      await session.refreshOnce('fc_at_0');
      backend().expectNone(`${API}/v1/auth/refresh`);
    });

    it('refreshes when the failed request used the current token', async () => {
      const { session } = await signedIn();
      const done = session.refreshOnce('fc_at_1');
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
      await done;
      expect(session.bearerToken()).toBe('fc_at_2');
    });

    it('ends the session and rethrows when the refresh is refused', async () => {
      const { session, navigate } = await signedIn();
      vi.spyOn(TestBed.inject(Router), 'url', 'get').mockReturnValue('/profile?tab=1');
      sessionStorage.setItem('fc.lastGroupId', '665f1c2e9b1d4a0012ab34a1');
      const done = session.refreshOnce();
      failRequest(backend(), '/v1/auth/refresh', 'UNAUTHENTICATED');
      await expect(done).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(session.status()).toBe('anonymous');
      expect(sessionStorage.getItem('fc.lastGroupId')).toBeNull();
      expect(session.bearerToken()).toBeNull();
      expect(session.me()).toBeNull();
      expect(sessionStorage.getItem('fc.session')).toBeNull();
      expect(navigate).toHaveBeenCalledWith(['/login'], {
        queryParams: { returnUrl: '/profile?tab=1' },
      });
      expect(TestBed.inject(ToastService).toasts()[0].message).toBe('[AUTH.SESSION_EXPIRED]');
    });

    it('keeps the session on a malformed response', async () => {
      const { session } = await signedIn();
      const done = session.refreshOnce();
      backend().expectOne(`${API}/v1/auth/refresh`).flush({ data: {} });
      await expect(done).rejects.toThrow('Unexpected authentication response');
      expect(session.status()).toBe('authenticated');
    });

    it.each([
      ['a network error', null],
      ['429', 'RATE_LIMITED'],
      ['500', 'INTERNAL_ERROR'],
    ])('keeps the session and storage on %s, and retries on the next call', async (_l, code) => {
      const { session, navigate } = await signedIn();
      const done = session.refreshOnce();
      if (code === null) {
        backend().expectOne(`${API}/v1/auth/refresh`).error(new ProgressEvent('error'));
      } else {
        failRequest(backend(), '/v1/auth/refresh', code);
      }
      await expect(done).rejects.toBeInstanceOf(ApiError);
      expect(session.status()).toBe('authenticated');
      expect(session.bearerToken()).toBe('fc_at_1');
      expect(sessionStorage.getItem('fc.session')).not.toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      const again = session.refreshOnce();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
      await again;
      expect(session.bearerToken()).toBe('fc_at_2');
    });

    it('rejects when there is no refresh token', async () => {
      const { session } = setup();
      await expect(session.refreshOnce()).rejects.toThrow('No refresh token');
      expect(session.status()).toBe('anonymous');
    });
  });

  describe('expire', () => {
    it.each([
      ['/', {}],
      ['/login', {}],
      ['/login?returnUrl=%2Fx', {}],
      ['//evil.example', {}],
      ['/users', { returnUrl: '/users' }],
    ])('goes to the login from %s with the right return url', async (url, queryParams) => {
      const { session, navigate } = await signedIn();
      vi.spyOn(TestBed.inject(Router), 'url', 'get').mockReturnValue(url);
      session.expire();
      expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams });
    });

    it('is idempotent: a second call does nothing', async () => {
      const { session, navigate } = await signedIn();
      session.expire();
      session.expire();
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(TestBed.inject(ToastService).toasts().length).toBe(1);
    });

    it('does not navigate when nobody was signed in', () => {
      const { session, navigate } = setup();
      session.expire();
      expect(navigate).not.toHaveBeenCalled();
      expect(session.status()).toBe('anonymous');
    });
  });

  describe('requirePasswordChange', () => {
    it('marks the status and opens the change-password page', async () => {
      const { session, navigateByUrl } = await signedIn();
      session.requirePasswordChange();
      expect(session.status()).toBe('passwordChangeRequired');
      expect(navigateByUrl).toHaveBeenCalledWith('/change-password');
    });

    it('does not navigate again when already on that page', async () => {
      const { session, navigateByUrl } = await signedIn();
      vi.spyOn(TestBed.inject(Router), 'url', 'get').mockReturnValue('/change-password');
      session.requirePasswordChange();
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('leaves a status that is not authenticated alone', () => {
      const { session } = setup();
      session.requirePasswordChange();
      expect(session.status()).toBe('unknown');
    });
  });

  describe('logout', () => {
    it('revokes the session on the server, clears everything and opens the login', async () => {
      const { session, navigateByUrl } = await signedIn();
      const done = session.logout();
      const request = backend().expectOne(`${API}/v1/auth/logout`);
      expect(request.request.method).toBe('POST');
      expect(request.request.headers.get('Authorization')).toBe('DPoP fc_at_1');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await done;
      expect(session.status()).toBe('anonymous');
      expect(session.me()).toBeNull();
      expect(session.bearerToken()).toBeNull();
      expect(sessionStorage.getItem('fc.session')).toBeNull();
      expect(navigateByUrl).toHaveBeenCalledWith('/login');
    });

    it('clears the local state even when the server fails, logging only the code', async () => {
      const { session, navigateByUrl } = await signedIn();
      const done = session.logout();
      backend().expectOne(`${API}/v1/auth/logout`).error(new ProgressEvent('error'));
      await done;
      expect(session.status()).toBe('anonymous');
      expect(sessionStorage.getItem('fc.session')).toBeNull();
      expect(navigateByUrl).toHaveBeenCalledWith('/login');
      expect(console.warn).toHaveBeenCalledWith('Logout request failed', 'NETWORK_ERROR');
    });

    it('also clears when the failure is not an API error', async () => {
      const { session } = await signedIn();
      vi.spyOn(TestBed.inject(HttpClient), 'post').mockReturnValue(
        throwError(() => new Error('x')),
      );
      await session.logout();
      expect(session.status()).toBe('anonymous');
      expect(console.warn).toHaveBeenCalledWith('Logout request failed', 'unexpected');
    });
  });

  describe('logoutAll', () => {
    it('revokes every session, then clears the local state', async () => {
      const { session, navigateByUrl } = await signedIn();
      const done = session.logoutAll();
      backend()
        .expectOne(`${API}/v1/auth/logout-all`)
        .flush(null, { status: 204, statusText: 'No Content' });
      await done;
      expect(session.status()).toBe('anonymous');
      expect(sessionStorage.getItem('fc.session')).toBeNull();
      expect(navigateByUrl).toHaveBeenCalledWith('/login');
    });

    it('keeps the session and rethrows when the server fails', async () => {
      const { session } = await signedIn();
      const done = session.logoutAll();
      failRequest(backend(), '/v1/auth/logout-all', 'INTERNAL_ERROR');
      await expect(done).rejects.toBeInstanceOf(ApiError);
      expect(session.status()).toBe('authenticated');
      expect(sessionStorage.getItem('fc.session')).not.toBeNull();
    });
  });

  describe('restore', () => {
    function store(refreshToken = refreshTokenOf(99)) {
      sessionStorage.setItem(
        'fc.session',
        JSON.stringify({
          sessionId: SESSION_ID,
          refreshToken,
          refreshTokenExpiresAt: '2099-01-08T00:00:00.000Z',
        }),
      );
    }

    it('is anonymous without any HTTP call when nothing is stored', async () => {
      const { session, navigate } = setup();
      await session.restore();
      expect(session.status()).toBe('anonymous');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('is anonymous when the stored value is corrupted', async () => {
      sessionStorage.setItem('fc.session', 'not json');
      const { session } = setup();
      await session.restore();
      expect(session.status()).toBe('anonymous');
      expect(sessionStorage.getItem('fc.session')).toBeNull();
    });

    it('refreshes, loads the profile and signs the user in', async () => {
      store();
      const { session, navigate } = setup();
      const done = session.restore();
      await settle();
      const refresh = backend().expectOne(`${API}/v1/auth/refresh`);
      expect(refresh.request.body).toEqual({ refreshToken: refreshTokenOf(99) });
      refresh.flush(tokenBody(7));
      await settle();
      const me = backend().expectOne(`${API}/v1/me`);
      expect(me.request.headers.get('Authorization')).toBe('DPoP fc_at_7');
      me.flush({ data: fakeProfile() });
      await done;
      expect(session.status()).toBe('authenticated');
      expect(JSON.parse(sessionStorage.getItem('fc.session') ?? '{}').refreshToken).toBe(
        refreshTokenOf(7),
      );
      expect(navigate).not.toHaveBeenCalled();
    });

    it('becomes anonymous, without an error or navigation, when the refresh is refused', async () => {
      store();
      const { session, navigate, navigateByUrl } = setup();
      const done = session.restore();
      await settle();
      failRequest(backend(), '/v1/auth/refresh', 'UNAUTHENTICATED');
      await done;
      expect(session.status()).toBe('anonymous');
      expect(sessionStorage.getItem('fc.session')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(navigateByUrl).not.toHaveBeenCalled();
      expect(TestBed.inject(ToastService).toasts()).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith('Session restore refused', 'UNAUTHENTICATED');
    });

    it('becomes anonymous when the profile is refused', async () => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      failRequest(backend(), '/v1/me', 'NOT_FOUND');
      await settle();
      backend().expectOne(`${API}/v1/auth/logout`).error(new ProgressEvent('error'));
      await done;
      expect(console.warn).toHaveBeenCalledWith('Revoking the session failed', 'NETWORK_ERROR');
      expect(session.status()).toBe('anonymous');
      expect(session.bearerToken()).toBeNull();
      expect(sessionStorage.getItem('fc.session')).toBeNull();
    });

    it.each([
      ['a network error', null],
      ['429', 'RATE_LIMITED'],
      ['500', 'INTERNAL_ERROR'],
    ])('rethrows %s on the refresh and keeps the stored session', async (_l, code) => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      if (code === null) {
        backend().expectOne(`${API}/v1/auth/refresh`).error(new ProgressEvent('error'));
      } else {
        failRequest(backend(), '/v1/auth/refresh', code);
      }
      await expect(done).rejects.toBeInstanceOf(ApiError);
      expect(sessionStorage.getItem('fc.session')).not.toBeNull();
      expect(session.status()).toBe('unknown');
    });

    it('does not try to revoke when the profile answer was a 401 (the token is already gone)', async () => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      failRequest(backend(), '/v1/me', 'UNAUTHENTICATED');
      await done;
      expect(session.status()).toBe('anonymous');
    });

    it('rethrows a transient failure of the profile and keeps the storage', async () => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      failRequest(backend(), '/v1/me', 'INTERNAL_ERROR');
      await expect(done).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(sessionStorage.getItem('fc.session')).not.toBeNull();
    });

    it('rethrows an unexpected failure', async () => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush({});
      await expect(done).rejects.toThrow('Unexpected authentication response');
    });
  });

  it('replaces the profile and follows the temporary-password flag', async () => {
    const { session } = await signedIn();
    session.setProfile(fakeProfile({ permissions: ['users:read'], passwordChangeRequired: true }));
    expect(session.status()).toBe('passwordChangeRequired');
    expect(session.can('users:read')).toBe(true);
    expect(session.can('profile:read')).toBe(false);
    session.setProfile(fakeProfile());
    expect(session.status()).toBe('authenticated');
  });

  it('loads the profile again on demand', async () => {
    const { session } = await signedIn();
    const done = session.loadProfile();
    backend()
      .expectOne(`${API}/v1/me`)
      .flush({ data: fakeProfile({ firstName: 'Luigi' }) });
    await done;
    expect(session.me()?.firstName).toBe('Luigi');
  });

  describe('exclusive tab (Web Locks)', () => {
    const name = `fc.session:${SESSION_ID}`;
    let locks: FakeLocks;
    beforeEach(() => {
      locks = installFakeLocks();
    });
    afterEach(() => locks.uninstall());

    function store() {
      sessionStorage.setItem(
        'fc.session',
        JSON.stringify({
          sessionId: SESSION_ID,
          refreshToken: refreshTokenOf(99),
          refreshTokenExpiresAt: '2099-01-08T00:00:00.000Z',
        }),
      );
    }

    it('holds the lock after login and keeps it across refreshes', async () => {
      const { session } = await signedIn();
      expect(locks.held.has(name)).toBe(true);
      const done = session.refreshOnce();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
      await done;
      expect(locks.held.has(name)).toBe(true);
      expect(locks.held.size).toBe(1);
    });

    it('releases the lock at logout', async () => {
      const { session } = await signedIn();
      const done = session.logout();
      backend().expectOne(`${API}/v1/auth/logout`).flush(null, { status: 204, statusText: 'x' });
      await done;
      await settle();
      expect(locks.held.size).toBe(0);
    });

    it('releases the lock when the session expires', async () => {
      const { session } = await signedIn();
      session.expire();
      await settle();
      expect(locks.held.size).toBe(0);
    });

    it('swaps the lock when a new session starts', async () => {
      const { session } = await signedIn();
      const done = session.login('u', 'p');
      await settle();
      backend()
        .expectOne(`${API}/v1/auth/login`)
        .flush(tokenBody(2, { sessionId: 'other-session' }));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      await settle();
      expect([...locks.held]).toEqual(['fc.session:other-session']);
    });

    it('restores normally when no other tab holds the session, then holds it', async () => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      expect(session.status()).toBe('authenticated');
      expect(locks.held.has(name)).toBe(true);
    });

    it('starts anonymous, without refreshing, when another tab holds the session', async () => {
      store();
      locks.holdExternally(name);
      const { session } = setup();
      await session.restore();
      backend().expectNone(`${API}/v1/auth/refresh`);
      expect(session.status()).toBe('anonymous');
      expect(sessionStorage.getItem('fc.session')).toBeNull();
    });

    it('lets only one of two tabs restoring the same session at once own it', async () => {
      store();
      const winner = setup().session;
      const loser = TestBed.runInInjectionContext(() => new SessionService());
      const done = Promise.all([winner.restore(), loser.restore()]);
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      expect(winner.status()).toBe('authenticated');
      expect(loser.status()).toBe('anonymous');
      expect(keyRecords().map.has(SESSION_ID)).toBe(true);
      expect(locks.held.has(name)).toBe(true);
      // The loser ending its (empty) session must not delete the key the winner uses.
      loser.expire();
      await settle();
      expect(keyRecords().map.has(SESSION_ID)).toBe(true);
      expect(locks.held.has(name)).toBe(true);
    });

    it('releases the lock taken at restore when the session expires', async () => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      session.expire();
      await settle();
      expect(locks.held.size).toBe(0);
    });

    it('releases the lock taken at restore when the browser key is missing', async () => {
      store();
      const { session } = setup();
      keyRecords().map.clear();
      await session.restore();
      await settle();
      expect(session.status()).toBe('anonymous');
      expect(locks.held.size).toBe(0);
    });

    it('proceeds as the owner, warning, when the lock request fails at restore', async () => {
      locks.uninstall();
      locks = installFakeLocks({ failRequests: true });
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      expect(session.status()).toBe('authenticated');
      expect(console.warn).toHaveBeenCalledWith('Cannot hold the session lock');
    });

    it('warns when the lock cannot be requested, keeping the session', async () => {
      locks.uninstall();
      locks = installFakeLocks({ failRequests: true });
      await signedIn();
      await settle();
      expect(console.warn).toHaveBeenCalledWith('Cannot hold the session lock');
    });
  });

  describe('without the Web Locks API', () => {
    it('keeps working, warning', async () => {
      const { session } = await signedIn();
      expect(session.status()).toBe('authenticated');
      expect(console.warn).toHaveBeenCalledWith(
        'Web Locks are not available: the session is not exclusive to this tab',
      );
    });
  });
});

describe('SessionService browser key (D-33)', () => {
  const OLD = 30 * 24 * 60 * 60 * 1000;
  let locks: FakeLocks | null = null;

  function store() {
    sessionStorage.setItem(
      'fc.session',
      JSON.stringify({
        sessionId: SESSION_ID,
        refreshToken: refreshTokenOf(99),
        refreshTokenExpiresAt: '2099-01-08T00:00:00.000Z',
      }),
    );
  }

  const record = (sessionId: string, ageMs: number) => ({
    sessionId,
    keyPair: sharedKeyPair,
    createdAt: Date.now() - ageMs,
  });

  async function restoreOk() {
    const ctx = setup();
    const done = ctx.session.restore();
    await settle();
    backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
    await settle();
    backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
    await done;
    return ctx;
  }

  afterEach(() => {
    locks?.uninstall();
    locks = null;
  });

  describe('login', () => {
    it('signs the login with a new key and stores it under the session id', async () => {
      const { session } = setup();
      expect(session.signingKey()).toBeNull();
      const done = session.login('u', 'p');
      await settle();
      expect(session.signingKey()).toBe(sharedKeyPair);
      expect(keyRecords().map.size).toBe(0);
      backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      expect(keyRecords().map.get(SESSION_ID)?.keyPair).toBe(sharedKeyPair);
      expect(session.signingKey()).toBe(sharedKeyPair);
    });

    it('drops the key when the login is refused or answered nonsense', async () => {
      const { session } = setup();
      let done = session.login('u', 'p');
      await settle();
      failRequest(backend(), '/v1/auth/login', 'INVALID_CREDENTIALS');
      await expect(done).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(session.signingKey()).toBeNull();
      done = session.login('u', 'p');
      await settle();
      backend().expectOne(`${API}/v1/auth/login`).flush({});
      await expect(done).rejects.toThrow('Unexpected authentication response');
      expect(session.signingKey()).toBeNull();
      expect(keyRecords().map.size).toBe(0);
    });

    it('keeps the session in memory, warning, when the key cannot be stored', async () => {
      const { session } = setup();
      keyRecords().failing.add('put');
      const done = session.login('u', 'p');
      await settle();
      backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      expect(session.status()).toBe('authenticated');
      expect(session.signingKey()).toBe(sharedKeyPair);
      expect(console.warn).toHaveBeenCalledWith(
        'Cannot persist the browser key: the session will not survive a reload',
      );
    });

    it('deletes the key when the profile cannot be loaded', async () => {
      const { session } = setup();
      const done = session.login('u', 'p');
      await settle();
      backend().expectOne(`${API}/v1/auth/login`).flush(tokenBody(1));
      await settle();
      failRequest(backend(), '/v1/me', 'INTERNAL_ERROR');
      await settle();
      backend()
        .expectOne(`${API}/v1/auth/logout`)
        .flush(null, { status: 204, statusText: 'No Content' });
      await expect(done).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      await settle();
      expect(keyRecords().map.size).toBe(0);
      expect(session.signingKey()).toBeNull();
    });
  });

  describe('end of the session', () => {
    it('is deleted at logout, even when the server fails', async () => {
      const { session } = await signedIn();
      expect(keyRecords().map.has(SESSION_ID)).toBe(true);
      const done = session.logout();
      failRequest(backend(), '/v1/auth/logout', 'INTERNAL_ERROR');
      await done;
      await settle();
      expect(keyRecords().map.size).toBe(0);
      expect(session.signingKey()).toBeNull();
    });

    it('is deleted at logout of every device', async () => {
      const { session } = await signedIn();
      const done = session.logoutAll();
      backend()
        .expectOne(`${API}/v1/auth/logout-all`)
        .flush(null, { status: 204, statusText: 'x' });
      await done;
      await settle();
      expect(keyRecords().map.size).toBe(0);
    });

    it('is deleted when the session expires', async () => {
      const { session } = await signedIn();
      session.expire();
      await settle();
      expect(keyRecords().map.size).toBe(0);
      expect(session.signingKey()).toBeNull();
    });

    it('is deleted when the refresh is refused during the restore', async () => {
      store();
      const { session } = setup();
      const done = session.restore();
      await settle();
      failRequest(backend(), '/v1/auth/refresh', 'UNAUTHENTICATED');
      await done;
      await settle();
      expect(session.status()).toBe('anonymous');
      expect(keyRecords().map.size).toBe(0);
    });

    it('stays in the storage when deleting it fails, with a warning', async () => {
      const { session } = await signedIn();
      keyRecords().failing.add('delete');
      session.expire();
      await settle();
      expect(keyRecords().map.has(SESSION_ID)).toBe(true);
      expect(console.warn).toHaveBeenCalledWith('Cannot delete the browser key');
    });
  });

  describe('restore', () => {
    it('signs with the stored key of the session', async () => {
      store();
      const { session } = await restoreOk();
      expect(session.status()).toBe('authenticated');
      expect(session.signingKey()).toBe(sharedKeyPair);
      expect(keyRecords().map.has(SESSION_ID)).toBe(true);
    });

    it.each([
      ['missing', false],
      ['unreadable', true],
    ])('goes anonymous without calling the server when the key is %s', async (_label, fails) => {
      store();
      const { session, navigate } = setup();
      if (fails) {
        keyRecords().failing.add('get');
      } else {
        keyRecords().map.clear();
      }
      await session.restore();
      backend().expectNone(`${API}/v1/auth/refresh`);
      expect(session.status()).toBe('anonymous');
      expect(session.signingKey()).toBeNull();
      expect(sessionStorage.getItem('fc.session')).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith('The browser key of the session is missing');
    });

    it('does not delete the key, nor anything else, of a session in use by another tab', async () => {
      locks = installFakeLocks();
      store();
      locks.holdExternally(`fc.session:${SESSION_ID}`);
      const { session } = setup();
      keyRecords().map.set('stale', record('stale', OLD));
      await session.restore();
      await settle();
      expect(session.status()).toBe('anonymous');
      expect(keyRecords().map.has(SESSION_ID)).toBe(true);
      expect(session.signingKey()).toBeNull();
    });
  });

  describe('key usage', () => {
    it('records the use of the key after a successful refresh', async () => {
      const { session } = await signedIn();
      keyRecords().map.set(SESSION_ID, { ...record(SESSION_ID, OLD), lastUsedAt: 1 });
      const done = session.refreshOnce();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
      await done;
      expect(Date.now() - (keyRecords().map.get(SESSION_ID)?.lastUsedAt ?? 0)).toBeLessThan(5000);
    });

    it('never breaks the refresh when the usage cannot be recorded', async () => {
      const { session } = await signedIn();
      keyRecords().failing.add('put');
      const done = session.refreshOnce();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(2));
      await done;
      expect(session.status()).toBe('authenticated');
      expect(console.warn).toHaveBeenCalledWith('Cannot update the browser key usage');
    });
  });

  describe('orphan cleanup', () => {
    it('deletes old keys of other sessions whose lock is free, and only those', async () => {
      locks = installFakeLocks();
      store();
      locks.holdExternally('fc.session:in-use');
      const { session } = setup();
      const records = keyRecords().map;
      records.set('orphan', record('orphan', OLD));
      records.set('young', record('young', 60_000));
      records.set('in-use', record('in-use', OLD));
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      await settle();
      expect([...records.keys()].sort()).toEqual([SESSION_ID, 'in-use', 'young']);
    });

    it('also runs when nobody is signed in', async () => {
      locks = installFakeLocks();
      const { session } = setup();
      keyRecords().map.set('orphan', record('orphan', OLD));
      await session.restore();
      await settle();
      expect(keyRecords().map.size).toBe(0);
    });

    it('is skipped without Web Locks: nobody could tell which keys are still in use', async () => {
      const { session } = setup();
      keyRecords().map.set('orphan', record('orphan', OLD));
      await session.restore();
      await settle();
      expect(keyRecords().map.size).toBe(1);
    });

    it('never blocks the restore when it fails', async () => {
      locks = installFakeLocks();
      store();
      const { session } = setup();
      keyRecords().failing.add('all');
      const done = session.restore();
      await settle();
      backend().expectOne(`${API}/v1/auth/refresh`).flush(tokenBody(7));
      await settle();
      backend().expectOne(`${API}/v1/me`).flush({ data: fakeProfile() });
      await done;
      expect(session.status()).toBe('authenticated');
      expect(console.warn).toHaveBeenCalledWith('Cannot clean up the stored browser keys');
    });
  });
});
