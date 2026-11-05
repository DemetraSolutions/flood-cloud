import {
  readSessionStorage,
  readStorage,
  removeSessionStorage,
  writeSessionStorage,
  writeStorage,
} from './storage';

describe('storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('round-trips a value', () => {
    writeStorage('fc.test', 'x');
    expect(readStorage('fc.test')).toBe('x');
  });

  it('returns null for an absent key', () => {
    expect(readStorage('fc.absent')).toBeNull();
  });

  it('logs and returns null when reading fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(readStorage('fc.test')).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('logs when writing fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeStorage('fc.test', 'x');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('session storage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('round-trips and removes a value', () => {
    writeSessionStorage('fc.test', 'x');
    expect(readSessionStorage('fc.test')).toBe('x');
    removeSessionStorage('fc.test');
    expect(readSessionStorage('fc.test')).toBeNull();
  });

  it.each([
    ['getItem', () => readSessionStorage('k')],
    ['setItem', () => writeSessionStorage('k', 'v')],
    ['removeItem', () => removeSessionStorage('k')],
  ] as const)('logs and carries on when %s fails', (method, run) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error('blocked');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(run() ?? null).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
