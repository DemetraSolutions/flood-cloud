/** The time zone of the company: the month of an activation, and the year of a park, are the ones of the clock on the wall in Rome. */
export const BILLING_TIME_ZONE = 'Europe/Rome';

/** The first year a period may name. */
export const MIN_YEAR = 2020;

/** The last year a period may name. */
export const MAX_YEAR = 2100;

/** A calendar month: `month` from 1 to 12. */
export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

const ROME = new Intl.DateTimeFormat('en-GB', {
  timeZone: BILLING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** The date and the hour on the wall in Rome at an instant. */
function romeParts(date: Date): { readonly year: number; readonly month: number; readonly hour: number } {
  const part = Object.fromEntries(ROME.formatToParts(date).map((entry) => [entry.type, entry.value]));
  return { year: Number(part['year']), month: Number(part['month']), hour: Number(part['hour']) };
}

/**
 * The calendar month of an instant in Rome.
 *
 * @param date The instant.
 * @returns For example `{ year: 2026, month: 6 }` for `2026-05-31T22:00:00Z` (midnight of 1 June in Rome, summer time) and `{ year: 2026, month: 5 }` one millisecond earlier.
 */
export function monthOf(date: Date): YearMonth {
  const { year, month } = romeParts(date);
  return { year, month };
}

/**
 * The instant a month starts in Rome: midnight of its first day, which is 23:00 UTC of the day before in winter and 22:00 UTC in summer (the clocks change at night on the last Sunday of March and of October, never at
 * the turn of a month).
 *
 * @param year The year.
 * @param month The month, from 1 to 13: 13 is January of the next year, the end of a year.
 */
export function monthStart(year: number, month: number): Date {
  const utc = Date.UTC(year, month - 1, 1);
  const winter = new Date(utc - 3_600_000);
  return romeParts(winter).hour === 0 ? winter : new Date(utc - 7_200_000);
}

/**
 * The month before another.
 *
 * @param value The month.
 * @returns December of the previous year for a January.
 */
export function previousMonth(value: YearMonth): YearMonth {
  return value.month === 1 ? { year: value.year - 1, month: 12 } : { year: value.year, month: value.month - 1 };
}

/**
 * The months of the activation year that follow the month of the activation, which is never paid: from the month after to December. May gives 7 (June to December), December gives 0.
 *
 * @param activation The month of the activation.
 */
export function monthsLeft(activation: YearMonth): number {
  return 12 - activation.month;
}

/** The text of a month: `2026-06`. */
export function periodOf(value: YearMonth): string {
  return `${String(value.year)}-${String(value.month).padStart(2, '0')}`;
}

/** The text of a year: `2026`. */
export function yearPeriodOf(year: number): string {
  return String(year);
}

const MONTH_TEXT = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Reads the text of a month.
 *
 * @param text A month, `YYYY-MM`.
 * @returns The month, or `null` when the text is not a month of the years {@link MIN_YEAR} to {@link MAX_YEAR}.
 */
export function parseMonth(text: string): YearMonth | null {
  const match = MONTH_TEXT.exec(text);
  const year = Number(match?.[1]);
  return match !== null && year >= MIN_YEAR && year <= MAX_YEAR ? { year, month: Number(match[2]) } : null;
}

/**
 * Tells whether a month is after the month of an instant, in Rome.
 *
 * @param value The month.
 * @param now The instant.
 */
export function isFuture(value: YearMonth, now: Date): boolean {
  const current = monthOf(now);
  return value.year > current.year || (value.year === current.year && value.month > current.month);
}
