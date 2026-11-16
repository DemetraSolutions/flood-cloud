import type { Request, Response } from 'express';
import type { ActivityLog } from '../activity-log/activity-log.ts';
import type { MetadataValue } from '../activity-log/activity-log.ts';
import { responseActorOf } from '../activity-log/actor.ts';
import type { Logger } from '../logging/logger.ts';
import { createMinuteCap } from './minute-cap.ts';

/** Maximum `error` entries per minute and process; beyond it errors go to stdout only. */
export const MAX_ERROR_ENTRIES_PER_MINUTE = 100;

const UNMATCHED = '[unmatched]';

/** Reports an unexpected error to the activity log. */
export interface ErrorActivityReporter {
  /**
   * Records a `request.failed` entry for an error that became a `500`, without waiting for the
   * write. The entry has the method, the route pattern (`/v1/groups/:groupId`, or `[unmatched]`;
   * never the concrete path, which can carry identifiers or tokens), the error class and code:
   * never the message or the stack, which stay on stdout.
   *
   * @param error The thrown value.
   * @param req The request.
   * @param res The response (for the request id, principal and group).
   */
  report(error: unknown, req: Request, res: Response): void;
}

/** Options of {@link createErrorActivityReporter}. */
export interface ErrorActivityOptions {
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Defaults to {@link MAX_ERROR_ENTRIES_PER_MINUTE}. */
  readonly maxPerMinute?: number;
}

/**
 * Creates the reporter used by the central error handler. It is fire-and-forget (a failing log
 * never delays or alters the response) and flood-safe: at most `maxPerMinute` entries per minute;
 * the first skipped entry of a minute is logged at once, and the number skipped is logged when the
 * next minute's first error arrives.
 *
 * @param options Log, logger, clock and optional limit.
 * @returns The reporter.
 */
export function createErrorActivityReporter(options: ErrorActivityOptions): ErrorActivityReporter {
  const maxPerMinute = options.maxPerMinute ?? MAX_ERROR_ENTRIES_PER_MINUTE;
  const cap = createMinuteCap({
    limit: maxPerMinute,
    now: options.now,
    logger: options.logger,
    skippingMessage: 'error activity entries are being skipped by the per-minute limit',
    skippedMessage: 'error activity entries were skipped by the per-minute limit',
  });
  return {
    report: (error, req, res) => {
      if (!cap.take()) {
        return;
      }
      const code = (error as { code?: unknown } | null)?.code;
      const metadata: Record<string, MetadataValue> = {
        method: req.method,
        route: res.locals.routePattern ?? UNMATCHED,
        errorName: error instanceof Error ? error.name : typeof error,
        ...(typeof code === 'string' || typeof code === 'number' ? { errorCode: code } : {}),
      };
      options.activityLog
        .record({
          category: 'error',
          action: 'request.failed',
          outcome: 'failure',
          actor: responseActorOf(res),
          ...(res.locals.groupAccess === undefined ? {} : { groupId: res.locals.groupAccess.groupId }),
          requestId: res.locals.requestId,
          ...(req.ip === undefined ? {} : { ip: req.ip }),
          metadata,
        })
        .catch((failure: unknown) => options.logger.error('error activity entry rejected', { requestId: res.locals.requestId, error: failure }));
    },
  };
}
