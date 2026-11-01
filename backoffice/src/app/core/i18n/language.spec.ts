import {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  resolveInitialLanguage,
  SUPPORTED_LANGUAGES,
} from './language';

describe('language', () => {
  it('supports Italian only for now', () => {
    expect([...SUPPORTED_LANGUAGES]).toEqual(['it']);
    expect(DEFAULT_LANGUAGE).toBe('it');
  });

  it('recognises supported languages', () => {
    expect(isSupportedLanguage('it')).toBe(true);
    expect(isSupportedLanguage('xx')).toBe(false);
    expect(isSupportedLanguage(null)).toBe(false);
  });

  it('prefers the saved language', () => {
    expect(resolveInitialLanguage('it', ['en'])).toBe('it');
  });

  it('ignores an unsupported saved language and matches the browser primary subtag', () => {
    expect(resolveInitialLanguage('xx', ['en-US', 'IT-ch'])).toBe('it');
  });

  it('falls back to the default language', () => {
    expect(resolveInitialLanguage(null, ['en-US'])).toBe('it');
    expect(resolveInitialLanguage(null, [])).toBe('it');
  });
});
