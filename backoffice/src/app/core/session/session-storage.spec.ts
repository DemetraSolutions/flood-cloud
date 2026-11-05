import {
  clearStoredSession,
  readStoredSession,
  SESSION_STORAGE_KEY,
  writeStoredSession,
} from './session-storage';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const TOKEN = `fc_rt_${'a'.repeat(43)}`;
const VALID = {
  sessionId: '665f1c2e9b1d4a0012ab34cd',
  refreshToken: TOKEN,
  refreshTokenExpiresAt: '2026-11-12T10:00:00.000Z',
};

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('session storage', () => {
  it('round-trips the refresh token under the documented key', () => {
    writeStoredSession(VALID);
    expect(sessionStorage.getItem('fc.session')).toBe(JSON.stringify(VALID));
    expect(SESSION_STORAGE_KEY).toBe('fc.session');
    expect(readStoredSession(NOW)).toEqual(VALID);
  });

  it('returns null without warning when nothing is stored', () => {
    expect(readStoredSession(NOW)).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('defaults to the current time', () => {
    writeStoredSession({ ...VALID, refreshTokenExpiresAt: '2000-01-01T00:00:00.000Z' });
    expect(readStoredSession()).toBeNull();
  });

  it('removes and warns about corrupted JSON without quoting it', () => {
    sessionStorage.setItem('fc.session', '{fc_rt_secret');
    expect(readStoredSession(NOW)).toBeNull();
    expect(sessionStorage.getItem('fc.session')).toBeNull();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('fc_rt_secret');
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it.each([
    ['a non-object', '"text"'],
    ['null', 'null'],
    ['a missing token', JSON.stringify({ refreshTokenExpiresAt: VALID.refreshTokenExpiresAt })],
    ['an empty token', JSON.stringify({ ...VALID, refreshToken: '' })],
    ['a non-string token', JSON.stringify({ ...VALID, refreshToken: 5 })],
    ['an oversized token', JSON.stringify({ ...VALID, refreshToken: `${TOKEN}a` })],
    [
      'a token of the wrong format',
      JSON.stringify({ ...VALID, refreshToken: `fc_at_${'a'.repeat(43)}` }),
    ],
    [
      'a token with forbidden characters',
      JSON.stringify({ ...VALID, refreshToken: `fc_rt_${'!'.repeat(43)}` }),
    ],
    ['a missing session id', JSON.stringify({ ...VALID, sessionId: undefined })],
    ['an empty session id', JSON.stringify({ ...VALID, sessionId: '' })],
    ['an oversized session id', JSON.stringify({ ...VALID, sessionId: 'a'.repeat(65) })],
    ['a missing expiry', JSON.stringify({ sessionId: VALID.sessionId, refreshToken: TOKEN })],
    ['an invalid expiry', JSON.stringify({ ...VALID, refreshTokenExpiresAt: 'tomorrow' })],
    [
      'an expired token',
      JSON.stringify({ ...VALID, refreshTokenExpiresAt: '2026-11-05T09:59:59.000Z' }),
    ],
  ])('removes %s', (_label, raw) => {
    sessionStorage.setItem('fc.session', raw);
    expect(readStoredSession(NOW)).toBeNull();
    expect(sessionStorage.getItem('fc.session')).toBeNull();
  });

  it('keeps only the allowlisted fields', () => {
    sessionStorage.setItem('fc.session', JSON.stringify({ ...VALID, accessToken: 'fc_at_x' }));
    expect(readStoredSession(NOW)).toEqual(VALID);
  });

  it('never persists an access token', () => {
    writeStoredSession(VALID);
    expect(sessionStorage.getItem('fc.session')).not.toContain('fc_at_');
  });

  it('clears the stored session', () => {
    writeStoredSession(VALID);
    clearStoredSession();
    expect(sessionStorage.getItem('fc.session')).toBeNull();
  });

  it('survives an unavailable storage, warning each time', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readStoredSession(NOW)).toBeNull();
    expect(() => writeStoredSession(VALID)).not.toThrow();
    expect(() => clearStoredSession()).not.toThrow();
    expect(console.warn).toHaveBeenCalledTimes(3);
  });
});
