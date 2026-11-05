import type { Logger } from '../logging/logger.ts';

const MINUTE_MS = 60_000;

/** A per-process budget of events per minute. */
export interface MinuteCap {
  /**
   * Takes one event from the budget of the current minute. The first refused event of a minute is
   * logged at once, and the number refused is logged when the next minute's first event arrives.
   *
   * @returns `true` when the event may be written, `false` when the minute's budget is spent.
   */
  take(): boolean;
}

/** Options of {@link createMinuteCap}. */
export interface MinuteCapOptions {
  /** Events allowed per minute and process. */
  readonly limit: number;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  readonly logger: Logger;
  /** Log message when the first event of a minute is refused. */
  readonly skippingMessage: string;
  /** Log message, with the count, when a minute that refused events is over. */
  readonly skippedMessage: string;
}

/**
 * Creates a fixed one-minute budget, so a flood of events cannot flood the database: beyond the limit
 * events are only counted and reported on stdout.
 *
 * @param options Limit, clock, logger and log messages.
 * @returns The cap.
 */
export function createMinuteCap(options: MinuteCapOptions): MinuteCap {
  let minute = -1;
  let taken = 0;
  let skipped = 0;
  return {
    take: () => {
      const current = Math.floor(options.now() / MINUTE_MS);
      if (current !== minute) {
        if (skipped > 0) {
          options.logger.warn(options.skippedMessage, { skipped, limit: options.limit });
        }
        minute = current;
        taken = 0;
        skipped = 0;
      }
      if (taken >= options.limit) {
        if (skipped === 0) {
          options.logger.warn(options.skippingMessage, { limit: options.limit });
        }
        skipped += 1;
        return false;
      }
      taken += 1;
      return true;
    },
  };
}
