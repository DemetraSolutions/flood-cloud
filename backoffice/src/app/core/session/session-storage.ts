/** `sessionStorage` key of the persisted session (only the refresh token, never the access token). */
export const SESSION_STORAGE_KEY = 'fc.session';

/** What survives a page reload: the refresh token and its expiry. */
export interface StoredSession {
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

/** Format of the refresh tokens the server issues. */
const REFRESH_TOKEN_FORMAT = /^fc_rt_[A-Za-z0-9_-]{43}$/;
const MAX_SESSION_ID_LENGTH = 64;

function isStoredSession(value: unknown, now: number): value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { sessionId, refreshToken, refreshTokenExpiresAt } = value as Record<string, unknown>;
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    typeof refreshToken === 'string' &&
    REFRESH_TOKEN_FORMAT.test(refreshToken) &&
    typeof refreshTokenExpiresAt === 'string' &&
    Date.parse(refreshTokenExpiresAt) > now
  );
}

/**
 * Reads the persisted session. A missing, unreadable, corrupted, malformed or expired value
 * yields `null` and is removed. Errors are logged without their content: a parse error could
 * quote part of the stored token.
 *
 * @param now Current time in epoch milliseconds (injectable for tests).
 */
export function readStoredSession(now: number = Date.now()): StoredSession | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    console.warn('Cannot read the stored session');
    return null;
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('Discarding the corrupted stored session');
  }
  if (isStoredSession(parsed, now)) {
    return {
      sessionId: parsed.sessionId,
      refreshToken: parsed.refreshToken,
      refreshTokenExpiresAt: parsed.refreshTokenExpiresAt,
    };
  }
  clearStoredSession();
  return null;
}

/**
 * Persists the refresh token for the current tab. A failure is logged (never silent) and not
 * fatal: the session then simply does not survive a reload.
 */
export function writeStoredSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    console.warn('Cannot persist the session');
  }
}

/** Removes the persisted session; a failure is logged. */
export function clearStoredSession(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    console.warn('Cannot clear the stored session');
  }
}
