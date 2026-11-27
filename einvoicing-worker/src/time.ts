/**
 * Waits `ms` milliseconds, or less if `signal` is aborted. It never rejects.
 *
 * @param ms Duration in milliseconds.
 * @param signal Optional signal that ends the wait early (also when already aborted).
 * @returns A promise settled when the time has elapsed or the signal fired.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Time zone of the fiscal calendar (invoice dates, sending day, annual caps). */
export const FISCAL_TIME_ZONE = 'Europe/Rome';

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: FISCAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * The calendar day of an instant in the fiscal time zone.
 *
 * @param ms Milliseconds since the epoch.
 * @returns `YYYY-MM-DD` in Europe/Rome.
 * @example
 * romeDate(Date.UTC(2026, 11, 31, 23, 30)); // '2027-01-01'
 */
export function romeDate(ms: number): string {
  return DAY_FORMAT.format(new Date(ms));
}

/**
 * The calendar year of an instant in the fiscal time zone.
 *
 * @param ms Milliseconds since the epoch.
 * @returns The year in Europe/Rome.
 */
export function romeYear(ms: number): number {
  return Number(romeDate(ms).slice(0, 4));
}

/**
 * The first instant of the next calendar year in the fiscal time zone: 1 January 00:00 in Italy is always 23:00 UTC of
 * 31 December (the offset in January is +01:00).
 *
 * @param ms Milliseconds since the epoch.
 * @returns Milliseconds since the epoch.
 */
export function startOfNextRomeYear(ms: number): number {
  return Date.UTC(romeYear(ms) + 1, 0, 1) - 3_600_000;
}
