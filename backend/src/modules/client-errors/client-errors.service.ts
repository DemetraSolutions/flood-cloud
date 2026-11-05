import { createHash } from 'node:crypto';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { createMinuteCap } from '../../shared/http/minute-cap.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { ClientErrorBody } from './client-errors.schemas.ts';

/** Maximum `client.error` entries per minute and process; beyond it reports go to stdout counters only. */
export const MAX_CLIENT_ERROR_ENTRIES_PER_MINUTE = 100;

/** Longest `User-Agent` kept in an entry. */
export const MAX_CLIENT_ERROR_USER_AGENT_LENGTH = 120;

/** The same error of the same user is stored at most once in this period. */
export const CLIENT_ERROR_DEDUPLICATION_MS = 600_000;

/** Most distinct errors remembered for the deduplication. */
export const MAX_REMEMBERED_CLIENT_ERRORS = 10_000;

/** Business rules of the browser error reports. */
export interface ClientErrorsService {
  /**
   * Records a JavaScript error of the backoffice as a `client.error` entry of the `error` category,
   * attributed to the reporting user and to his group. Name, message and stack are redacted and bounded by
   * the activity log. The write never fails the request: beyond the per-process budget of
   * {@link MAX_CLIENT_ERROR_ENTRIES_PER_MINUTE} entries per minute the report is dropped (only counted on
   * stdout), and a failing write is logged.
   *
   * An error already reported by the same user (same name, message and first stack line) in the last
   * {@link CLIENT_ERROR_DEDUPLICATION_MS} is not stored again: it is only counted on stdout.
   *
   * @param principal The authenticated reporter.
   * @param body Validated report.
   * @param client Request id, address and user agent.
   */
  report(principal: AuthPrincipal, body: ClientErrorBody, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createClientErrorsService}. */
export interface ClientErrorsDeps {
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Defaults to {@link MAX_CLIENT_ERROR_ENTRIES_PER_MINUTE}. */
  readonly maxPerMinute?: number;
  /** Defaults to {@link MAX_REMEMBERED_CLIENT_ERRORS}. */
  readonly maxRemembered?: number;
}

/**
 * Builds the browser error service.
 *
 * @param deps Activity log, logger, clock and optional limit.
 */
export function createClientErrorsService(deps: ClientErrorsDeps): ClientErrorsService {
  const cap = createMinuteCap({
    limit: deps.maxPerMinute ?? MAX_CLIENT_ERROR_ENTRIES_PER_MINUTE,
    now: deps.now,
    logger: deps.logger,
    skippingMessage: 'client error entries are being skipped by the per-minute limit',
    skippedMessage: 'client error entries were skipped by the per-minute limit',
  });
  const maxRemembered = deps.maxRemembered ?? MAX_REMEMBERED_CLIENT_ERRORS;
  /** Fingerprint to the time until which it is a repeat, and how many repeats were seen. Oldest first. */
  const remembered = new Map<string, { until: number; repeats: number }>();
  /** True when this error was stored lately (and counts the repeat); otherwise remembers it. */
  const isRepeat = (principal: AuthPrincipal, body: ClientErrorBody, requestId: string): boolean => {
    const now = deps.now();
    const fingerprint = createHash('sha256').update(JSON.stringify([principal.userId.toHexString(), body.name, body.message, (body.stack ?? '').split('\n', 1)[0]])).digest('hex');
    const seen = remembered.get(fingerprint);
    if (seen !== undefined && now < seen.until) {
      seen.repeats += 1;
      deps.logger.info('client error repeated, not stored again', { requestId, repeats: seen.repeats });
      return true;
    }
    remembered.delete(fingerprint);
    if (remembered.size >= maxRemembered) {
      remembered.delete(remembered.keys().next().value!);
    }
    remembered.set(fingerprint, { until: now + CLIENT_ERROR_DEDUPLICATION_MS, repeats: 0 });
    return false;
  };
  return {
    report: async (principal, body, client) => {
      if (isRepeat(principal, body, client.requestId) || !cap.take()) {
        return;
      }
      try {
        await deps.activityLog.record({
          category: 'error',
          action: 'client.error',
          outcome: 'failure',
          actor: { kind: 'user', id: principal.userId, role: principal.role },
          ...(principal.groupId === null ? {} : { groupId: principal.groupId }),
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
          metadata: {
            route: body.route,
            appVersion: body.appVersion,
            ...(client.userAgent === null ? {} : { userAgent: client.userAgent.slice(0, MAX_CLIENT_ERROR_USER_AGENT_LENGTH) }),
          },
          error: { name: body.name, message: body.message, ...(body.stack === undefined ? {} : { stack: body.stack }) },
        });
      } catch (error) {
        deps.logger.error('client error entry rejected', { requestId: client.requestId, error });
      }
    },
  };
}
