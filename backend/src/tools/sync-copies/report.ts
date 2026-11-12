import { ISSUE_KINDS, SYNC_COLLECTIONS } from './issues.ts';
import type { IssueCounts } from './issues.ts';
import { emptyStats } from './reconcile.ts';
import type { CollectionStats } from './reconcile.ts';
import type { SyncResult } from './sync.ts';

/** Largest number of per-group detail lines of the report. */
export const MAX_DETAIL_LINES = 50;

const differences = (stats: CollectionStats): number => stats.missing + stats.different + stats.extra;
const issueTotal = (counts: IssueCounts): number => ISSUE_KINDS.reduce((sum, kind) => sum + counts[kind], 0);

/**
 * Exit code of the command: 1 when some work failed; 2 when the copies were not equal to the originals (a missing or
 * different copy, or an `_id` collision), whether this run wrote them or not: it means a write path is not covered;
 * 0 otherwise. The known data issues (`groupIdMismatch`, `orphanCompany`, `extraCopy`, `invalidCopy`,
 * `databaseWithoutGroup`, `nonObjectId`, `unknownCluster`) are printed but do not change the code.
 *
 * @param result Outcome of the run.
 */
export function exitCodeOf(result: SyncResult): 0 | 1 | 2 {
  if (result.errors > 0) {
    return 1;
  }
  const totals = result.issues.totals();
  return totals.missingCopy + totals.differentCopy + totals.idCollision > 0 ? 2 : 0;
}

/**
 * The report: counts and group ids only, never a name, a document or a connection string. Per-group lines are limited to
 * {@link MAX_DETAIL_LINES}.
 *
 * @param result Outcome of the run.
 * @param mode Whether the run applied its repairs, and the environment name.
 * @returns The lines to print.
 */
export function formatReport(result: SyncResult, mode: { readonly apply: boolean; readonly appEnv: string }): string[] {
  const lines: string[] = result.checks.map((check) => `Cluster ${check.clusterId}: MongoDB ${check.version}, replica set`);
  lines.push(
    mode.apply
      ? `Applied on ${mode.appEnv}: groups examined ${result.groupsExamined}, with database ${result.groupsCopied}, failed ${result.errors}`
      : `Dry run on ${mode.appEnv}, nothing written: groups examined ${result.groupsExamined}, with database ${result.groupsCopied}, failed ${result.errors}`,
  );
  for (const name of SYNC_COLLECTIONS) {
    const total = emptyStats();
    for (const summary of result.summaries.values()) {
      for (const key of Object.keys(total) as Array<keyof CollectionStats>) {
        total[key] += summary[name][key];
      }
    }
    lines.push(`${name}: originals ${total.originals}, copies ${total.copies}, missing ${total.missing}, different ${total.different}, extra ${total.extra}, repaired ${total.repaired}`);
  }
  const totals = result.issues.totals();
  const kinds = ISSUE_KINDS.filter((kind) => totals[kind] > 0).map((kind) => `${kind} ${totals[kind]}`);
  lines.push(`Issues: ${kinds.length === 0 ? 'none' : kinds.join(', ')}`);

  const detail: string[] = [];
  for (const hex of [...new Set([...result.summaries.keys(), ...result.issues.groupHexes()])].sort()) {
    const summary = result.summaries.get(hex) ?? { companies: emptyStats(), places: emptyStats() };
    const issues = result.issues.ofGroup(hex);
    if (SYNC_COLLECTIONS.every((name) => differences(summary[name]) === 0) && issueTotal(issues) === 0) {
      continue;
    }
    const parts = SYNC_COLLECTIONS.map((name) => `${name} missing ${summary[name].missing}, different ${summary[name].different}, extra ${summary[name].extra}`);
    const issueKinds = ISSUE_KINDS.filter((kind) => issues[kind] > 0).map((kind) => `${kind} ${issues[kind]}`);
    detail.push(`  group ${hex}: ${parts.join('; ')}${issueKinds.length === 0 ? '' : `; issues ${issueKinds.join(', ')}`}`);
  }
  lines.push(...detail.slice(0, MAX_DETAIL_LINES));
  if (detail.length > MAX_DETAIL_LINES) {
    lines.push(`  ... and ${detail.length - MAX_DETAIL_LINES} more`);
  }
  if (!mode.apply && detail.length > 0) {
    lines.push('Run again with --apply to repair the differences');
  }
  return lines;
}
