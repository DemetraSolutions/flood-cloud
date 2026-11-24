import type { Document, Filter, ObjectId } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { ACTION_CATALOG, ACTIVITY_ALERT_ACTIONS } from '../../shared/activity-log/catalog.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { ACTIVITY_LOG_LIST } from './activity-log.list.ts';
import { outranksViewer, toActivityEntry } from './activity-log.mapper.ts';
import type { ActivityEntryView } from './activity-log.mapper.ts';
import type { ActivityLogRepository } from './activity-log.repository.ts';
import type { ActivityAlertsCountQuery, ActivityLogQuery } from './activity-log.schemas.ts';

/** Longest period a query may span. */
export const MAX_PERIOD_DAYS = 400;

const DAY_MS = 86_400_000;

/** How far back `since` of the alert count may go. */
export const MAX_ALERTS_PERIOD_DAYS = 30;

/** The count of alerts stops here: more is reported as `capped`. */
export const ALERTS_COUNT_CAP = 100;

/** Result of the alert count. */
export interface ActivityAlertsCount {
  /** Alerts since the given instant, at most {@link ALERTS_COUNT_CAP}. */
  readonly count: number;
  /** True when there are more than {@link ALERTS_COUNT_CAP}: the count is then the cap. */
  readonly capped: boolean;
}

/** One page of mapped entries. */
export interface ActivityLogPage {
  readonly items: ActivityEntryView[];
  readonly page: PageInfo;
}

/** Business rules of the activity log monitor. */
export interface ActivityLogService {
  /**
   * Lists the entries the caller may read, newest first. The scope is always applied: a PSA reads
   * everything, a dealer the entries of his groups, a group administrator those of his group, a company or
   * place administrator his own actions; the `error` category is the PSA's alone. A `groupId` filter outside
   * the caller's perimeter yields an empty page.
   *
   * @param principal The authenticated caller.
   * @param query Validated query.
   * @throws {AppError} `FORBIDDEN` when a caller who is not a PSA asks for the `error` category or for an action of it;
   * `VALIDATION_ERROR` when `to` precedes `from` or the period exceeds {@link MAX_PERIOD_DAYS} days.
   */
  list(principal: AuthPrincipal, query: ActivityLogQuery): Promise<ActivityLogPage>;
  /**
   * Counts the alert entries (`ACTIVITY_ALERT_ACTIONS`) since an instant, inside the perimeter the caller already reads in the list
   * (a PSA all, a dealer his groups, a group administrator his group, anybody else his own actions).
   *
   * @param principal The authenticated caller.
   * @param query Validated query (`since`).
   * @returns The count, capped at {@link ALERTS_COUNT_CAP}.
   * @throws {AppError} `VALIDATION_ERROR` (`since` / `minimum`) when `since` is more than {@link MAX_ALERTS_PERIOD_DAYS} days back; `SERVICE_UNAVAILABLE` on a database time-out.
   */
  alertsCount(principal: AuthPrincipal, query: ActivityAlertsCountQuery): Promise<ActivityAlertsCount>;
}

/** The condition on the entry time, from the optional `from` and `to` (both inclusive). */
function periodFilter(query: ActivityLogQuery): Filter<Document> {
  const { from, to } = query;
  if (from !== undefined && to !== undefined) {
    if (to < from) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'to', issue: 'minimum' }] });
    }
    if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'to', issue: 'maximum' }] });
    }
  }
  if (from === undefined && to === undefined) {
    return {};
  }
  return { at: { ...(from === undefined ? {} : { $gte: from }), ...(to === undefined ? {} : { $lte: to }) } };
}

/**
 * Builds the activity log service.
 *
 * @param repository Activity log repository.
 * @param now Clock in epoch milliseconds (injected for tests).
 */
export function createActivityLogService(repository: ActivityLogRepository, now: () => number = Date.now): ActivityLogService {
  return {
    alertsCount: async (principal, query) => {
      if (query.since.getTime() < now() - MAX_ALERTS_PERIOD_DAYS * DAY_MS) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'since', issue: 'minimum' }] });
      }
      const total = await repository.count(principal, { action: { $in: [...ACTIVITY_ALERT_ACTIONS] }, at: { $gte: query.since } }, ALERTS_COUNT_CAP);
      return { count: Math.min(total, ALERTS_COUNT_CAP), capped: total > ALERTS_COUNT_CAP };
    },

    list: async (principal, query) => {
      const errorAction = query.action !== undefined && ACTION_CATALOG.get(query.action)?.categories.includes('error') === true;
      if ((query.category === 'error' || errorAction) && principal.scope.kind !== 'platform') {
        throw new AppError('FORBIDDEN');
      }
      const conditions: Filter<Document>[] = [periodFilter(query)];
      if (query.category !== undefined) {
        conditions.push({ category: query.category });
      }
      if (query.action !== undefined) {
        conditions.push({ action: query.action });
      }
      if (query.alerts !== undefined) {
        conditions.push({ action: { $in: [...ACTIVITY_ALERT_ACTIONS] } });
      }
      if (query.outcome !== undefined) {
        conditions.push({ outcome: query.outcome });
      }
      if (query.actorId !== undefined) {
        conditions.push({ 'actor.id': query.actorId });
      }
      if (query.groupId !== undefined) {
        conditions.push({ groupId: query.groupId });
      }
      if (query.requestId !== undefined) {
        conditions.push({ requestId: query.requestId });
      }
      const { items, page } = await repository.list(principal, { $and: conditions }, listParamsOf(query, ACTIVITY_LOG_LIST));
      const actorIds = new Map<string, ObjectId>();
      for (const item of items) {
        const id = (item['actor'] as { id?: ObjectId }).id;
        if (id !== undefined && !outranksViewer(item, principal.role)) {
          actorIds.set(id.toHexString(), id);
        }
      }
      const usernames = await repository.usernames([...actorIds.values()]);
      return { items: items.map((item) => toActivityEntry(item, usernames, principal.role)), page };
    },
  };
}
