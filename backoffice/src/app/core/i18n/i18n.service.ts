import { HttpClient } from '@angular/common/http';
import { computed, inject, Service, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { readStorage, writeStorage } from '../storage';
import { flattenDictionary, interpolate, TranslateParams } from './dictionary';
import { Language, LANGUAGE_STORAGE_KEY, resolveInitialLanguage } from './language';

/**
 * Runtime translation service: one JSON dictionary per language, downloaded from
 * `/i18n/<lang>.json`, switchable without reloading the page.
 */
@Service()
export class I18nService {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly dictionary = signal<ReadonlyMap<string, string>>(new Map());
  private readonly languageState = signal<Language | null>(null);
  private readonly warnedKeys = new Set<string>();

  /** Current language; `null` until a dictionary has been loaded. */
  readonly language = this.languageState.asReadonly();

  /** `true` once a dictionary is loaded and {@link t} can be relied upon. */
  readonly ready = computed(() => this.dictionary().size > 0);

  /**
   * Loads the dictionary of the initial language (saved preference, browser, default).
   *
   * @throws Error when the dictionary cannot be fetched or is invalid.
   */
  async initialize(): Promise<void> {
    await this.use(resolveInitialLanguage(readStorage(LANGUAGE_STORAGE_KEY), navigator.languages));
  }

  /**
   * Downloads and activates the dictionary of a language. The current language is unchanged
   * when loading fails.
   *
   * @param language Language to activate.
   * @throws Error when the dictionary cannot be fetched or is invalid.
   */
  async use(language: Language): Promise<void> {
    const raw = await firstValueFrom(this.http.get<unknown>(`/i18n/${language}.json`));
    this.dictionary.set(flattenDictionary(raw));
    this.languageState.set(language);
    this.document.documentElement.lang = language;
  }

  /**
   * Switches language and saves the choice as the preference for the next visits.
   *
   * @param language Language to activate.
   * @throws Error when the dictionary cannot be fetched or is invalid.
   */
  async select(language: Language): Promise<void> {
    await this.use(language);
    writeStorage(LANGUAGE_STORAGE_KEY, language);
  }

  /**
   * Translates a key. Reactive: reads signals, so templates re-render on language change.
   * A missing key renders as a visible `⟦KEY⟧` marker and is logged once per key.
   *
   * @param key Flat dictionary key, e.g. `COMMON.RETRY`.
   * @param params Values for `{name}` placeholders.
   */
  t(key: string, params?: TranslateParams): string {
    const text = this.dictionary().get(key);
    if (text === undefined) {
      if (!this.warnedKeys.has(key)) {
        this.warnedKeys.add(key);
        console.warn(`Missing translation key: ${key}`);
      }
      return `⟦${key}⟧`;
    }
    return params === undefined ? text : interpolate(text, params);
  }
}
