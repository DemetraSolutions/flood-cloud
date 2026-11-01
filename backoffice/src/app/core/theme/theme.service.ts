import { DOCUMENT } from '@angular/common';
import { inject, Service, signal } from '@angular/core';
import { readStorage, writeStorage } from '../storage';

/** Theme choices: follow the operating system, or force light or dark. */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;

/** A theme choice. */
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** `localStorage` key of the saved theme choice. */
export const THEME_STORAGE_KEY = 'fc.theme';

/** Type guard for {@link ThemeChoice}. */
export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.some((choice) => choice === value);
}

/**
 * Holds the user's theme choice and applies it to `<html data-theme>`. With `system` the
 * attribute is absent and `prefers-color-scheme` decides (see `styles/themes.css`).
 */
@Service()
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly choiceState = signal<ThemeChoice>('system');

  /** Current choice. */
  readonly choice = this.choiceState.asReadonly();

  constructor() {
    const stored = readStorage(THEME_STORAGE_KEY);
    this.apply(isThemeChoice(stored) ? stored : 'system');
  }

  /**
   * Applies and saves a theme choice.
   *
   * @param choice The theme to use.
   */
  select(choice: ThemeChoice): void {
    this.apply(choice);
    writeStorage(THEME_STORAGE_KEY, choice);
  }

  private apply(choice: ThemeChoice): void {
    this.choiceState.set(choice);
    const root = this.document.documentElement;
    if (choice === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', choice);
    }
  }
}
