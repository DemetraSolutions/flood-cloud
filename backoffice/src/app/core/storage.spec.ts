import { readStorage, writeStorage } from './storage';

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
