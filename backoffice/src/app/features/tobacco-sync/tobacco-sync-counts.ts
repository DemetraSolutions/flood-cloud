import { Component, computed, inject, input } from '@angular/core';
import { formatNumber } from '../../core/i18n/format';
import { I18nService } from '../../core/i18n/i18n.service';
import { DEFAULT_LANGUAGE } from '../../core/i18n/language';
import { SYNC_PRODUCT_COUNTS, SyncOutcome } from './tobacco-sync.types';

/** The figures a synchronization wrote (or, on a check, would write), as a list of terms and values. */
export const COUNT_KEYS = [
  ...SYNC_PRODUCT_COUNTS,
  'categoriesInserted',
  'duplicateNames',
  'duplicateCodes',
] as const;

/** A figure of {@link COUNT_KEYS}. */
export type CountKey = (typeof COUNT_KEYS)[number];

/** One term of the list. */
interface CountLine {
  readonly key: CountKey;
  readonly value: string;
}

/**
 * The counts of a check or of a synchronization: products inserted, updated, disabled, reactivated, unchanged and skipped,
 * categories created, and the duplicate names and codes found. Presentation only: the counts and their caption come from the page.
 */
@Component({
  selector: 'fc-tobacco-sync-counts',
  templateUrl: './tobacco-sync-counts.html',
  styleUrl: './tobacco-sync-counts.css',
})
export class TobaccoSyncCounts {
  private readonly i18n = inject(I18nService);

  /** The counts to show. */
  readonly outcome = input.required<SyncOutcome>();
  /** Accessible name of the list (already translated). */
  readonly label = input.required<string>();

  protected readonly lines = computed<CountLine[]>(() => {
    const { products, categories, duplicateCodes } = this.outcome();
    const language = this.i18n.language() ?? DEFAULT_LANGUAGE;
    const values: Readonly<Record<CountKey, number>> = {
      ...products,
      categoriesInserted: categories.inserted,
      duplicateNames: categories.duplicateNames,
      duplicateCodes,
    };
    return COUNT_KEYS.map((key) => ({ key, value: formatNumber(values[key], language) }));
  });

  /**
   * The text of a term.
   *
   * @param key The figure.
   */
  protected term(key: CountKey): string {
    return this.i18n.t(`TOBACCO_SYNC.COUNT.${key}`);
  }
}
