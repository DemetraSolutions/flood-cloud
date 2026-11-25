import { HttpClient } from '@angular/common/http';
import { computed, inject, Service, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiData } from '../api/api.types';
import { ApiError } from '../api/api-error';
import { safeReturnUrl } from '../auth/return-url';
import { I18nService } from '../i18n/i18n.service';
import { isSupportedLanguage, Language } from '../i18n/language';
import { isThemeChoice, ThemeService } from '../theme/theme.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DpopKeys } from './dpop-key-store';
import { Profile, SessionStatus, TokenPair } from './session.types';
import { forgetWorkingGroup } from '../groups/working-group-storage';
import { clearStoredSession, readStoredSession, writeStoredSession } from './session-storage';

/** Validates a login or refresh response and keeps only the fields the client uses. */
function parseTokenPair(body: unknown): TokenPair {
  const data = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
  const { sessionId, accessToken, refreshToken, refreshTokenExpiresAt } = data;
  if (
    typeof sessionId !== 'string' ||
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof refreshTokenExpiresAt !== 'string'
  ) {
    throw new Error('Unexpected authentication response');
  }
  return { sessionId, accessToken, refreshToken, refreshTokenExpiresAt };
}

const LOCK_PREFIX = 'fc.session:';

/** Web Locks, or `null` (with a console warning) where the API is missing. */
function webLocks(): LockManager | null {
  if (typeof navigator.locks === 'undefined') {
    console.warn('Web Locks are not available: the session is not exclusive to this tab');
    return null;
  }
  return navigator.locks;
}

/** The server refused the credential itself (4xx other than rate limiting), as opposed to a transient failure. */
function isTokenRejection(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429
  );
}

/**
 * Session of the signed-in user (decision D-12): the access token lives only in this service's
 * memory, the refresh token also in `sessionStorage`. Every session is bound to a browser key
 * (D-33, {@link DpopKeys}): generated at login, kept in memory and IndexedDB, deleted only by the
 * tab that owns the session. Tokens, keys, proofs and passwords are never logged.
 *
 * Refresh happens only when the interceptor reports `TOKEN_EXPIRED`, through one request shared
 * by every concurrent caller ({@link refreshOnce}).
 */
@Service()
export class SessionService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly theme = inject(ThemeService);
  private readonly keys = inject(DpopKeys);

  private readonly accessToken = signal<string | null>(null);
  private refreshToken: string | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private lockedSessionId: string | null = null;
  private releaseLock: (() => void) | null = null;
  /** Session whose browser key this tab may delete (`null` when it owns none). */
  private ownedSessionId: string | null = null;
  private readonly statusState = signal<SessionStatus>('unknown');
  private readonly meState = signal<Profile | null>(null);

  /** Lifecycle of the session. */
  readonly status = this.statusState.asReadonly();
  /** The signed-in user, `null` when anonymous. */
  readonly me = this.meState.asReadonly();
  /** `true` once logged in, including while a temporary password must still be changed. */
  readonly isAuthenticated = computed(
    () => this.statusState() === 'authenticated' || this.statusState() === 'passwordChangeRequired',
  );
  /** Effective permissions computed by the server (the client never derives them from the role). */
  readonly permissions = computed<ReadonlySet<string>>(
    () => new Set(this.meState()?.permissions ?? []),
  );

  /** Whether the signed-in user holds a permission (`resource:action`). UI hint only. */
  can(permission: string): boolean {
    return this.permissions().has(permission);
  }

  /** Access token for the `Authorization` header; `null` when anonymous. For the interceptor. */
  bearerToken(): string | null {
    return this.accessToken();
  }

  /** Key pair signing the API requests now; for the interceptor only. `null` when there is none. */
  signingKey(): CryptoKeyPair | null {
    return this.keys.current();
  }

  /**
   * Restores the session at startup from the refresh token kept in `sessionStorage`. If the
   * server refuses the token the session is anonymous and the storage is cleared. A transient
   * failure (network, 429, 5xx) is rethrown and the storage is kept, so the startup error page
   * can offer a retry instead of discarding a valid session. If another live tab holds the
   * session (Web Locks), this tab does not take it over: it starts anonymous and touches
   * neither the key nor anything else of the other tab. A stored session whose browser key is
   * missing cannot sign any request: it is dropped without calling the server (a new key is never
   * created for an existing session). Keys of vanished sessions are cleaned up in the background.
   *
   * @throws Error on a transient failure.
   */
  async restore(): Promise<void> {
    const stored = readStoredSession();
    void this.cleanupOrphanKeys(stored?.sessionId ?? null);
    if (stored === null) {
      this.clear();
      return;
    }
    if (!(await this.acquireLock(stored.sessionId))) {
      console.warn('The session is in use by another tab');
      this.clear();
      return;
    }
    if (!(await this.keys.load(stored.sessionId))) {
      console.warn('The browser key of the session is missing');
      this.clear();
      return;
    }
    this.ownedSessionId = stored.sessionId;
    this.refreshToken = stored.refreshToken;
    try {
      await this.refreshOnce();
      await this.loadProfile();
    } catch (error) {
      if (!isTokenRejection(error)) {
        throw error;
      }
      console.warn('Session restore refused', (error as ApiError).code);
      await this.revokeBestEffort();
      this.clear();
    }
  }

  /**
   * Signs in and loads the profile. On success {@link status} is `authenticated` or
   * `passwordChangeRequired`. The working group remembered by an earlier session is forgotten.
   *
   * @throws ApiError `INVALID_CREDENTIALS`, `RATE_LIMITED`, `NETWORK_ERROR`…
   */
  async login(username: string, password: string): Promise<void> {
    await this.keys.generate();
    let tokens: TokenPair;
    try {
      tokens = parseTokenPair(
        await firstValueFrom(
          this.http.post<ApiData<unknown>>('/v1/auth/login', { username, password }),
        ),
      );
    } catch (error) {
      this.keys.forget();
      throw error;
    }
    // A new session never inherits the working group of an earlier one: it could be a group of
    // another user or of another environment, which the lists would answer with a 404.
    forgetWorkingGroup();
    this.storeTokens(tokens);
    await this.keys.persist(tokens.sessionId);
    try {
      await this.loadProfile();
    } catch (error) {
      await this.revokeBestEffort();
      this.clear();
      throw error;
    }
  }

  /** Switches the dictionary (and the saved preference); a failure is logged and shown, never lost. */
  private async applyLanguage(language: Language): Promise<void> {
    try {
      await this.i18n.select(language);
    } catch (error) {
      console.error(error);
      this.toast.error(this.i18n.t('ERRORS.GENERIC.MESSAGE'));
    }
  }

  /** Loads (or reloads) `GET /v1/me`; the status follows `passwordChangeRequired`. */
  async loadProfile(): Promise<void> {
    const response = await firstValueFrom(this.http.get<ApiData<Profile>>('/v1/me'));
    this.setProfile(response.data);
  }

  /**
   * Replaces the current profile (e.g. with the response of `PATCH /v1/me`) and applies its
   * theme and language: the server values always win over the ones remembered in this browser.
   */
  setProfile(profile: Profile): void {
    // The dictionary is always loaded before a session exists (startup order), so `null` only
    // means "nothing to switch yet".
    const current = this.i18n.language();
    if (isSupportedLanguage(profile.language) && current !== null && profile.language !== current) {
      void this.applyLanguage(profile.language);
    }
    if (isThemeChoice(profile.theme)) {
      this.theme.select(profile.theme);
    }
    this.meState.set(profile);
    this.statusState.set(
      profile.passwordChangeRequired ? 'passwordChangeRequired' : 'authenticated',
    );
  }

  /**
   * Renews the token pair with a single request shared by all callers. When the server refuses
   * the refresh token the session ends (see {@link expire}); on a transient failure (network,
   * 429, 5xx) the session and its storage are kept. The error is rethrown either way.
   *
   * @param usedToken Access token of the request that failed: when it is no longer the current
   *   one another caller already renewed the pair, so no new refresh is needed.
   */
  refreshOnce(usedToken: string | null = null): Promise<void> {
    if (usedToken !== null && usedToken !== this.accessToken()) {
      return Promise.resolve();
    }
    this.refreshInFlight ??= this.refresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refresh(): Promise<void> {
    try {
      if (this.refreshToken === null) {
        throw new Error('No refresh token');
      }
      const body = await firstValueFrom(
        this.http.post<ApiData<unknown>>('/v1/auth/refresh', { refreshToken: this.refreshToken }),
      );
      const tokens = parseTokenPair(body);
      this.storeTokens(tokens);
      await this.keys.touch(tokens.sessionId);
    } catch (error) {
      if (this.refreshToken === null || isTokenRejection(error)) {
        this.expire();
      }
      throw error;
    }
  }

  /** Signs out of the current session. The local state is cleared even if the server fails. */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post<void>('/v1/auth/logout', null));
    } catch (error) {
      console.warn('Logout request failed', error instanceof ApiError ? error.code : 'unexpected');
    }
    await this.endSession();
  }

  /**
   * Signs out of every device. The local state is cleared only when the server confirmed.
   *
   * @throws ApiError when the request fails, so the caller can tell the user.
   */
  async logoutAll(): Promise<void> {
    await firstValueFrom(this.http.post<void>('/v1/auth/logout-all', null));
    await this.endSession();
  }

  /**
   * The server rejected the credentials (`UNAUTHENTICATED`) or the renewal failed: clears the
   * session and goes to the login page keeping the current location. Does nothing when the
   * user was not signed in.
   */
  expire(): void {
    const wasSignedIn = this.isAuthenticated();
    this.clear();
    if (wasSignedIn) {
      this.toast.info(this.i18n.t('AUTH.SESSION_EXPIRED'));
      void this.goToLogin(this.router.url);
    }
  }

  /** The server demands a password change (`PASSWORD_CHANGE_REQUIRED`): moves to that page. */
  requirePasswordChange(): void {
    if (this.statusState() === 'authenticated') {
      this.statusState.set('passwordChangeRequired');
    }
    if (!this.router.url.startsWith('/change-password')) {
      void this.router.navigateByUrl('/change-password');
    }
  }

  private async endSession(): Promise<void> {
    this.clear();
    await this.router.navigateByUrl('/login');
  }

  private async goToLogin(currentUrl: string): Promise<void> {
    const returnUrl = safeReturnUrl(currentUrl);
    await this.router.navigate(['/login'], {
      queryParams: returnUrl === null || returnUrl === '/' ? {} : { returnUrl },
    });
  }

  /** Background cleanup of the browser keys of vanished sessions; needs Web Locks to tell. */
  private async cleanupOrphanKeys(currentSessionId: string | null): Promise<void> {
    if (typeof navigator.locks === 'undefined') {
      return;
    }
    await this.keys.cleanupOrphans(currentSessionId, (id) => this.isSessionFree(id));
  }

  /** Whether no other live tab holds the lock of this session (Web Locks must exist). */
  private isSessionFree(sessionId: string): Promise<boolean> {
    return navigator.locks.request(
      LOCK_PREFIX + sessionId,
      { ifAvailable: true },
      (lock) => lock !== null,
    );
  }

  /**
   * Atomically takes the lock of a session (`ifAvailable`) and keeps holding it until
   * {@link unlock}. Only a tab that obtained it may become the owner of the session. Without Web
   * Locks, or when the request itself fails (warned), the tab proceeds as the owner.
   *
   * @returns `false` when another tab holds the lock.
   */
  private acquireLock(sessionId: string): Promise<boolean> {
    const locks = webLocks();
    if (locks === null) {
      return Promise.resolve(true);
    }
    this.unlock();
    return new Promise<boolean>((resolve) => {
      locks
        .request(LOCK_PREFIX + sessionId, { ifAvailable: true }, (lock) => {
          if (lock === null) {
            resolve(false);
            return undefined;
          }
          const held = new Promise<void>((release) => {
            this.releaseLock = release;
          });
          this.lockedSessionId = sessionId;
          resolve(true);
          return held;
        })
        .catch(() => {
          console.warn('Cannot hold the session lock');
          resolve(true);
        });
    });
  }

  /** Holds the session lock for the life of the page (released by {@link clear}). */
  private holdLock(sessionId: string): void {
    if (this.lockedSessionId === sessionId) {
      return;
    }
    this.unlock();
    const locks = webLocks();
    if (locks === null) {
      return;
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    this.lockedSessionId = sessionId;
    this.releaseLock = release;
    locks
      .request(LOCK_PREFIX + sessionId, () => held)
      .catch(() => {
        console.warn('Cannot hold the session lock');
      });
  }

  private unlock(): void {
    this.releaseLock?.();
    this.releaseLock = null;
    this.lockedSessionId = null;
  }

  /** Revokes the server session with the token in memory before discarding it; failures are logged by code. */
  private async revokeBestEffort(): Promise<void> {
    if (this.accessToken() === null) {
      return;
    }
    try {
      await firstValueFrom(this.http.post<void>('/v1/auth/logout', null));
    } catch (error) {
      console.warn(
        'Revoking the session failed',
        error instanceof ApiError ? error.code : 'unexpected',
      );
    }
  }

  private storeTokens(tokens: TokenPair): void {
    this.accessToken.set(tokens.accessToken);
    this.refreshToken = tokens.refreshToken;
    this.ownedSessionId = tokens.sessionId;
    this.holdLock(tokens.sessionId);
    writeStoredSession({
      sessionId: tokens.sessionId,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    });
  }

  /**
   * Ends the local session. The browser key is deleted from IndexedDB only when this tab owns
   * the session (a tab that found it in use elsewhere owns nothing).
   */
  private clear(): void {
    const owned = this.ownedSessionId;
    this.ownedSessionId = null;
    this.keys.forget();
    if (owned !== null) {
      void this.keys.remove(owned);
    }
    this.unlock();
    this.accessToken.set(null);
    this.refreshToken = null;
    this.meState.set(null);
    this.statusState.set('anonymous');
    clearStoredSession();
    forgetWorkingGroup();
  }
}
