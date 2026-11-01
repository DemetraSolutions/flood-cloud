/** Languages for which a dictionary exists (`public/i18n/<lang>.json`). */
export const SUPPORTED_LANGUAGES = ['it'] as const;

/** A supported UI language. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Language used when neither the saved preference nor the browser match a supported one. */
export const DEFAULT_LANGUAGE: Language = 'it';

/** `localStorage` key of the saved language preference. */
export const LANGUAGE_STORAGE_KEY = 'fc.language';

/** Type guard for {@link Language}. */
export function isSupportedLanguage(value: unknown): value is Language {
  return SUPPORTED_LANGUAGES.some((language) => language === value);
}

/**
 * Chooses the initial language: saved preference, then the first supported browser language
 * (by primary subtag, so `it-IT` matches `it`), then {@link DEFAULT_LANGUAGE}.
 *
 * @param stored Saved preference, if any.
 * @param browserLanguages Browser language tags in order of preference.
 */
export function resolveInitialLanguage(
  stored: string | null,
  browserLanguages: readonly string[],
): Language {
  if (isSupportedLanguage(stored)) {
    return stored;
  }
  for (const tag of browserLanguages) {
    const primary = tag.toLowerCase().split('-')[0];
    if (isSupportedLanguage(primary)) {
      return primary;
    }
  }
  return DEFAULT_LANGUAGE;
}
