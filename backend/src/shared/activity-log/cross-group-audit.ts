import { actorOf } from './actor.ts';
import type { ActivityLog } from './activity-log.ts';
import type { CrossGroupAccessHandler } from '../security/scope/group-access.ts';

/** Window in which a repeated (actor, group, outcome) access is recorded only once. */
export const CROSS_GROUP_DEDUP_WINDOW_MS = 15 * 60 * 1000;
/** Maximum number of remembered (actor, group, outcome) triples. */
export const CROSS_GROUP_DEDUP_MAX_ENTRIES = 10_000;

/** Options of {@link createCrossGroupAuditor}. */
export interface CrossGroupAuditorOptions {
  readonly activityLog: ActivityLog;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Defaults to {@link CROSS_GROUP_DEDUP_WINDOW_MS}. */
  readonly windowMs?: number;
  /** Defaults to {@link CROSS_GROUP_DEDUP_MAX_ENTRIES}. */
  readonly maxEntries?: number;
}

/**
 * Builds the `onCrossGroupAccess` callback: every PSA or D access to a group goes to the activity
 * log as `group.crossAccess` (security), `success` when the permission was granted and `denied`
 * otherwise. To avoid one entry per request, a repeated (actor, group, outcome) is skipped for
 * 15 minutes. The memory of seen triples is a small LRU (a `Map` in insertion order, capped); each
 * instance has its own, so replicas may each record the same access once.
 *
 * @param options Log, clock and optional limits.
 * @returns The handler for `GroupAccessDeps.onCrossGroupAccess`.
 */
export function createCrossGroupAuditor(options: CrossGroupAuditorOptions): CrossGroupAccessHandler {
  const windowMs = options.windowMs ?? CROSS_GROUP_DEDUP_WINDOW_MS;
  const maxEntries = options.maxEntries ?? CROSS_GROUP_DEDUP_MAX_ENTRIES;
  const seen = new Map<string, number>();
  return async ({ principal, groupId, req, granted }) => {
    const key = `${principal.userId.toHexString()}:${groupId.toHexString()}:${granted ? 'success' : 'denied'}`;
    const now = options.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) {
      return;
    }
    // Re-inserting moves the key to the most recent position; the oldest is dropped when full.
    seen.delete(key);
    seen.set(key, now);
    if (seen.size > maxEntries) {
      seen.delete(seen.keys().next().value as string);
    }
    await options.activityLog.record({
      category: 'security',
      action: 'group.crossAccess',
      outcome: granted ? 'success' : 'denied',
      actor: actorOf(principal),
      groupId,
      ...(req.res === undefined ? {} : { requestId: req.res.locals.requestId }),
      ...(req.ip === undefined ? {} : { ip: req.ip }),
    });
  };
}
