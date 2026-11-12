import { ISO_639_1, languageName } from './languages';

describe('languages', () => {
  it('lists the ISO 639-1 codes', () => {
    expect(ISO_639_1).toContain('it');
    expect(ISO_639_1).toContain('en');
    expect(new Set(ISO_639_1).size).toBe(ISO_639_1.length);
  });

  it('names a language in the given locale', () => {
    expect(languageName('it', 'en')).toBe('Italian');
    expect(languageName('en', 'it')).toBe('inglese');
  });

  it('falls back to the code when the runtime does not know the language', () => {
    expect(languageName('zzzz-invalid-', 'en')).toBe('zzzz-invalid-');
  });

  it('falls back to the code when the locale is not valid', () => {
    expect(languageName('it', 'not a locale')).toBe('it');
  });

  it('falls back to the code when the runtime has no name for it', () => {
    vi.spyOn(Intl, 'DisplayNames').mockImplementation(function () {
      return { of: () => undefined } as unknown as Intl.DisplayNames;
    } as unknown as typeof Intl.DisplayNames);
    expect(languageName('it', 'en')).toBe('it');
    vi.restoreAllMocks();
  });
});
