import type { ObjectId } from 'mongodb';
import type { GroupAudit } from './audit.ts';
import { addCounts, COUNT_KEYS, emptyCounts } from './counts.ts';
import type { GroupCounts } from './counts.ts';
import type { Plan } from './plan.ts';

/** Lines of groups the dry run prints in each list before it summarizes the rest. */
export const MAX_GROUP_LINES = 50;

/** The counters printed for a group in the audit (the idempotency keys are found only through the users a run deletes). */
const AUDIT_KEYS = COUNT_KEYS.filter((key) => key !== 'idempotencyKeys');

/** `key=value` pairs of the counters, in a fixed order: the only shape in which a group is described (an id and counts, never a name or any other value). */
function describe(counts: GroupCounts, keys: readonly (keyof GroupCounts)[] = COUNT_KEYS): string {
  return keys.map((key) => `${key}=${counts[key]}`).join(' ');
}

/** A date as `YYYY-MM-DD`, `none` when it is not known. */
function day(date: Date | null): string {
  return date === null ? 'none' : date.toISOString().slice(0, 10);
}

/** The lines of a list, at most {@link MAX_GROUP_LINES}, and how many more there are. */
function capped(lines: readonly string[]): string[] {
  return lines.length > MAX_GROUP_LINES ? [...lines.slice(0, MAX_GROUP_LINES), `… and ${lines.length - MAX_GROUP_LINES} more`] : [...lines];
}

/** A held back group with no users and no active users that still has a database: the trace of a purge that was interrupted after its users were deleted. */
function isPossiblyInterrupted(audit: GroupAudit): boolean {
  return audit.activeUsers === 0 && audit.counts.users === 0 && audit.counts.collections > 0;
}

/** How many audits have a status. */
function countOf(audits: readonly GroupAudit[], status: GroupAudit['status']): number {
  return audits.filter((audit) => audit.status === status).length;
}

/**
 * The lines of the dry run: how many groups were examined, how many are purgeable and how many are held back (and why), the totals of the purgeable ones, the digest
 * of the selection, one line per group of each list (at most {@link MAX_GROUP_LINES} each) and the command to apply. Only ids, dates and counts: no name, e-mail,
 * document value or connection string.
 *
 * @param plan The selection.
 * @param appEnv The environment the run is on.
 * @param minIdleDays The idle limit in days.
 */
export function formatDryRun(plan: Plan, appEnv: string, minIdleDays: number): string[] {
  const { audits, purgeable } = plan;
  const total = purgeable.reduce((sum, audit) => addCounts(sum, audit.counts), emptyCounts());
  const heldBack = audits.filter((audit) => audit.status !== 'purgeable');
  const withoutDatabase = purgeable.filter((audit) => audit.withoutDatabase);
  const interrupted = heldBack.filter(isPossiblyInterrupted);
  const lines = [
    `Dry run on ${appEnv}, nothing written: trashed groups examined ${audits.length}, purgeable ${purgeable.length}`,
    `Held back: recentlyActive ${countOf(audits, 'recentlyActive')} (activity newer than ${minIdleDays} days), unknownActivity ${countOf(audits, 'unknownActivity')} (documents but no activity date), externalHost ${countOf(audits, 'externalHost')}, unusableCluster ${countOf(audits, 'unusableCluster')}, possiblyInterrupted ${interrupted.length}. Purgeable without a database: withoutDatabase ${withoutDatabase.length}`,
    `Totals of the purgeable groups: databases ${purgeable.length - withoutDatabase.length}, ${describe(total, AUDIT_KEYS)}, usersKept=${purgeable.reduce((sum, audit) => sum + audit.usersKept, 0)} (users of the groups that are not deleted: PSA, D, or without a group role)`,
    `Selection digest: ${plan.digest}`,
    ...capped(purgeable.map((audit) => `${audit.group.id.toHexString()} ${describe(audit.counts, AUDIT_KEYS)} usersKept=${audit.usersKept} activeUsers=${audit.activeUsers} lastActivity=${day(audit.lastActivity)}`)),
  ];
  if (heldBack.length > 0) {
    lines.push('Held back, never purged by this run:');
    lines.push(...capped(heldBack.map((audit) => `${audit.group.id.toHexString()} held=${audit.status} activeUsers=${audit.activeUsers} lastActivity=${day(audit.lastActivity)}${isPossiblyInterrupted(audit) ? ' possibly interrupted purge: no users left but the database is still there (repeat the run with the options of the first one)' : ''}`)));
  }
  if (withoutDatabase.length > 0) {
    lines.push('Purgeable but without a database (check them):');
    lines.push(...capped(withoutDatabase.map((audit) => audit.group.id.toHexString())));
  }
  lines.push(`Nothing has been deleted. Take a backup, then run again with the same options plus --apply --expect ${purgeable.length} --expect-digest ${plan.digest}`);
  return lines;
}

/**
 * The line printed when a group has been purged: its id and the counts of what was deleted by this run.
 *
 * @param id The group.
 * @param counts What was deleted.
 * @param resumed The group database was already gone (the counts are those of this run only).
 */
export function formatPurged(id: ObjectId, counts: GroupCounts, resumed: boolean): string {
  return `Purged ${id.toHexString()} ${describe(counts)}${resumed ? ' resumed=true' : ''}`;
}

/** The counters of a whole run. */
export interface RunTotals {
  readonly purged: number;
  readonly skipped: number;
  readonly skippedExternalHost: number;
  readonly restoredDuringPurge: number;
  readonly failed: number;
  /** Groups purged whose `group.purged` event could not be stored. */
  readonly eventsFailed: number;
  /** Groups purged that had no database. */
  readonly withoutDatabase: number;
  readonly counts: GroupCounts;
}

/**
 * The closing line of a run with `--apply`.
 *
 * @param totals The counters of the run.
 * @param appEnv The environment the run is on.
 */
export function formatSummary(totals: RunTotals, appEnv: string): string {
  return `Applied on ${appEnv}: purged ${totals.purged}, skipped ${totals.skipped}, skippedExternalHost ${totals.skippedExternalHost}, restoredDuringPurge ${totals.restoredDuringPurge}, failed ${totals.failed}, events not written ${totals.eventsFailed}, withoutDatabase ${totals.withoutDatabase}. Deleted: ${describe(totals.counts)}`;
}

/**
 * The lines of the read-only `--orphans` listing: group databases that have no group document, by cluster.
 *
 * @param appEnv The environment the run is on.
 * @param orphans The orphans, as `cluster id` and group id (hex).
 */
export function formatOrphans(appEnv: string, orphans: ReadonlyArray<{ readonly cluster: string; readonly hex: string }>): string[] {
  return [`Orphans on ${appEnv}, nothing written: group databases without a group document ${orphans.length}`, ...orphans.map((orphan) => `${orphan.cluster} ${orphan.hex}`)];
}
