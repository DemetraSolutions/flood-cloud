/** The series of fiscal documents that are numbered one after the other: each has its own numbers within a company, a sectional and a year. */
export type NumberingSeries = 'invoice' | 'credit-note';

/** Where the legacy prints the name of the sectional in the document number: before it, after it, or not at all. */
export type PrefixSuffixPosition = 'prefix' | 'suffix' | null;

/** Something found wrong in the setup of the numbering and gone around: it never stops a document (the point of sale cannot be refused), the caller shows it. */
export type NumberingAnomaly =
  /** The point of sale names a sectional the company does not have: the next rule decided the sectional. */
  | { readonly code: 'prefixSuffixMissing' }
  /** The point of sale has no valid time zone: `Europe/Rome` decided the fiscal year. */
  | { readonly code: 'timezoneInvalid' };

/** The time zone the fiscal year is read in when the point of sale has none, or has one that does not exist. */
export const DEFAULT_TIME_ZONE = 'Europe/Rome';

/** The first and the last calendar year (inclusive) a document date may fall in: a document outside them is a bug of the caller, never a business case. */
export const MIN_FISCAL_YEAR = 1970;
export const MAX_FISCAL_YEAR = 9998;

/** The sectional a document is numbered in, with the position of its name for the print. */
export interface ResolvedPrefixSuffix {
  /** The name of the sectional, `''` when the documents have none. */
  readonly name: string;
  /** Where the name goes in the printed number (`invoicesPS` of the company), `null` when it does not go anywhere. */
  readonly position: PrefixSuffixPosition;
  readonly anomalies: NumberingAnomaly[];
}

/** What of a company the sectional depends on. */
export interface NumberingCompany {
  readonly invoicesPS?: unknown;
  readonly invoicesPSValues?: unknown;
}

/** What of a point of sale the sectional depends on. */
export interface NumberingPlace {
  readonly invoicePS?: unknown;
}

/** One sectional of a company, in the legacy shape (`{ name, cash }`). */
interface Sectional {
  readonly name: string;
  readonly cash: boolean;
}

/** The sectionals of a company that have a text name; anything else the legacy stored in the list is ignored. */
function sectionalsOf(raw: unknown): Sectional[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as unknown[]).flatMap((item) => {
    const value = item as { readonly name?: unknown; readonly cash?: unknown } | null;
    return value !== null && typeof value === 'object' && typeof value.name === 'string' ? [{ name: value.name, cash: value.cash === true }] : [];
  });
}

/**
 * Decides the sectional of the documents of a point of sale: the one the point of sale chose, if the company has it; else the sectional of the cash desks of the company (`cash: true`, the first when the legacy left more); else none.
 * A point of sale that chose a sectional the company no longer has is never refused: the next rule decides and the `prefixSuffixMissing` anomaly says so.
 *
 * @param company The sectionals of the company (`invoicesPS`, `invoicesPSValues`), as stored (anything that is not a list of `{ name, cash }` counts as no sectional).
 * @param place The choice of the point of sale (`invoicePS`), as stored (anything that is not a non empty text counts as no choice).
 * @returns The name of the sectional (`''` for none), the position of the name in the print (`null` unless the company says `prefix` or `suffix`) and the anomalies.
 * @example
 * resolvePrefixSuffix({ invoicesPS: 'suffix', invoicesPSValues: [{ name: 'A', cash: true }] }, {}); // { name: 'A', position: 'suffix', anomalies: [] }
 */
export function resolvePrefixSuffix(company: NumberingCompany, place: NumberingPlace): ResolvedPrefixSuffix {
  const sectionals = sectionalsOf(company.invoicesPSValues);
  const position: PrefixSuffixPosition = company.invoicesPS === 'prefix' || company.invoicesPS === 'suffix' ? company.invoicesPS : null;
  const anomalies: NumberingAnomaly[] = [];
  const chosen = typeof place.invoicePS === 'string' && place.invoicePS !== '' ? place.invoicePS : null;
  if (chosen !== null) {
    if (sectionals.some((sectional) => sectional.name === chosen)) {
      return { name: chosen, position, anomalies };
    }
    anomalies.push({ code: 'prefixSuffixMissing' });
  }
  const cash = sectionals.find((sectional) => sectional.cash);
  return { name: cash?.name ?? '', position, anomalies };
}

/**
 * The value `settings.global.lastInvoiceNumber` of a company stands for: the last invoice number issued outside Flood, which the next one follows. Whole numbers and texts made of digits only count; anything else (missing, negative, fractional, not a number) is no base.
 *
 * @param raw The stored value.
 * @returns A whole number of at least 0, `0` when there is no base.
 */
export function numberingBase(raw: unknown): number {
  const value = typeof raw === 'string' && /^[0-9]{1,15}$/.test(raw) ? Number(raw) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The fiscal year of a document: its number, the instants it starts and ends at in the time zone it was read in, and what was gone around. */
export interface FiscalYear {
  /** The calendar year of the date in the time zone. */
  readonly year: number;
  /** The first instant of the year (1 January 00:00 local), included. */
  readonly start: Date;
  /** The first instant of the next year (1 January 00:00 local of the year after), excluded. */
  readonly end: Date;
  /** The time zone actually used. */
  readonly timeZone: string;
  readonly anomalies: NumberingAnomaly[];
}

/** Builds the formatter that tells the calendar year an instant has in a time zone; `null` when the time zone is not one `Intl` knows. */
function yearFormatter(timeZone: unknown): Intl.DateTimeFormat | null {
  if (typeof timeZone !== 'string' || timeZone === '') {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', era: 'short' });
  } catch {
    // The only failure of the constructor for a text time zone is the `RangeError` of a name it does not know: that is the answer, not a fault.
    return null;
  }
}

/** The calendar year an instant has in the time zone of the formatter (a year before the common era is negative, which is out of the supported years anyway). */
function localYear(formatter: Intl.DateTimeFormat, instant: number): number {
  const parts = formatter.formatToParts(instant);
  const year = Number(parts.find((part) => part.type === 'year')!.value);
  return parts.find((part) => part.type === 'era')!.value === 'AD' ? year : 1 - year;
}

/**
 * The first instant whose local calendar year is `year` or later: 1 January 00:00 of `year` in the time zone, or the first instant after the gap when a clock change skipped that midnight. The year of an instant never goes down as the instant grows (but for
 * a clock moved back across a new year, which no real zone does at present), so a bisection over the two days around the UTC midnight finds it exactly, with no arithmetic on offsets and so no mistake at a daylight saving change.
 */
function yearStart(formatter: Intl.DateTimeFormat, year: number): number {
  const guess = Date.UTC(year, 0, 1);
  let low = guess - 2 * 86_400_000;
  let high = guess + 2 * 86_400_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localYear(formatter, middle) >= year) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/**
 * The fiscal year of a document: the calendar year of its date in the time zone of the point of sale, with the instants it starts and ends at, so a sale at 23:30 on 31 December in Rome belongs to the year that ends, whatever the time of the server. A missing or invalid time
 * zone is replaced by {@link DEFAULT_TIME_ZONE} and reported with the `timezoneInvalid` anomaly.
 *
 * @param date The date of the document.
 * @param timeZone The time zone of the point of sale, as stored.
 * @returns The year, its boundaries as instants, the time zone used and the anomalies.
 * @throws {RangeError} When `date` is not a valid date or falls outside the years {@link MIN_FISCAL_YEAR} to {@link MAX_FISCAL_YEAR} (a bug of the caller).
 * @example
 * fiscalYearOf(new Date('2026-12-31T22:30:00Z'), 'Europe/Rome').year; // 2027
 */
export function fiscalYearOf(date: Date, timeZone: unknown): FiscalYear {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('A document needs a valid date');
  }
  const found = yearFormatter(timeZone);
  const formatter = found ?? yearFormatter(DEFAULT_TIME_ZONE)!;
  const zone = found === null ? DEFAULT_TIME_ZONE : (timeZone as string);
  const year = localYear(formatter, date.getTime());
  if (year < MIN_FISCAL_YEAR || year > MAX_FISCAL_YEAR) {
    throw new RangeError(`The date of a document must be in the years ${String(MIN_FISCAL_YEAR)} to ${String(MAX_FISCAL_YEAR)}`);
  }
  return { year, start: new Date(yearStart(formatter, year)), end: new Date(yearStart(formatter, year + 1)), timeZone: zone, anomalies: found === null ? [{ code: 'timezoneInvalid' }] : [] };
}
