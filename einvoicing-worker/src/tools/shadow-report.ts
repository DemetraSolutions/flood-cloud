/**
 * `npm run shadow:report`: a summary of the shadow reports (`einvoicingShadowReports`) for one code version.
 *
 * Read-only. Prints the totals by outcome and by hub, the most frequent issue codes, the blocked records grouped by code
 * (at most {@link MAX_RECORDS_PER_CODE} per code) and the size of the files that would have been sent. A record is
 * identified by its queue id, hub, document type, number and date: nothing else about a customer is ever printed.
 *
 * Options: `--version <codeVersion>` (default: the version of this build), `--since <ISO date | Nh | Nd>` (reports
 * analysed from then on), `--json` (machine output). Exit code 0, or 2 for a wrong option, 1 when it cannot read.
 *
 * @module
 */
import { parseArgs } from 'node:util';
import type { Collection, Document, ObjectId } from 'mongodb';
import { describeError } from '../engine/context.ts';
import { currentCodeVersion } from '../shadow/version.ts';
import { SHADOW_COLLECTION, SHADOW_OUTCOMES } from '../shadow/reports.ts';
import type { ShadowOutcome, ShadowReport } from '../shadow/reports.ts';
import { openToolContext, TOOL_MAX_TIME_MS } from './context.ts';
import type { ToolDeps, ToolProcess } from './context.ts';

/** Most records listed for one blocking code. */
export const MAX_RECORDS_PER_CODE = 20;

/** Most issue codes listed. */
export const MAX_CODES = 50;

/** One record as the report prints it. */
export interface RecordRef {
  readonly queueId: string;
  readonly hub: string;
  readonly documentType: string | null;
  readonly number: string | null;
  readonly date: string | null;
}

/** The summary the command prints. */
export interface ShadowSummary {
  readonly codeVersion: string;
  /** The lower bound of `analysedAt` (ISO), `null` when there is none. */
  readonly since: string | null;
  readonly total: number;
  readonly byOutcome: Readonly<Record<ShadowOutcome, number>>;
  readonly byHub: ReadonlyArray<{ readonly hub: string; readonly total: number } & Readonly<Record<ShadowOutcome, number>>>;
  /** Occurrences of each issue code over all the reports, most frequent first. */
  readonly topIssues: ReadonlyArray<{ readonly code: string; readonly severity: string; readonly occurrences: number }>;
  /** The refused records grouped by error code: how many, and the first ones by queue id. */
  readonly blocked: ReadonlyArray<{ readonly code: string; readonly records: number; readonly examples: readonly RecordRef[] }>;
  /** Size of the files that would have been sent; `null` when no file was built. */
  readonly size: { readonly files: number; readonly maxBytes: number; readonly p95Bytes: number } | null;
}

const DURATION = /^([0-9]{1,4})([hd])$/;

/**
 * Parses `--since`.
 *
 * @param value An ISO date or date-time, or a duration such as `12h` or `7d`.
 * @param now The current time in milliseconds.
 * @returns The instant, or `undefined` when the value is not valid.
 */
export function parseSince(value: string, now: number): Date | undefined {
  const duration = DURATION.exec(value);
  if (duration !== null) {
    return new Date(now - Number(duration[1]) * (duration[2] === 'h' ? 3_600_000 : 86_400_000));
  }
  const parsed = new Date(value);
  return /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
}

const emptyOutcomes = (): Record<ShadowOutcome, number> => ({ ok: 0, warnings: 0, blocked: 0, mappingFailed: 0 });

const toRef = (entry: Document): RecordRef => ({
  queueId: (entry['queueId'] as ObjectId).toHexString(),
  hub: entry['hub'] as string,
  documentType: (entry['documentType'] as string | null) ?? null,
  number: (entry['number'] as string | null) ?? null,
  date: (entry['date'] as string | null) ?? null,
});

/**
 * Computes the summary with server-side aggregations (the reports are never loaded whole).
 *
 * @param reports The report collection.
 * @param codeVersion The code version to summarise.
 * @param since Only reports analysed from this instant, or `undefined`.
 * @returns The summary.
 */
export async function summarise(reports: Collection<ShadowReport>, codeVersion: string, since: Date | undefined): Promise<ShadowSummary> {
  const filter: Document = { codeVersion, ...(since === undefined ? {} : { analysedAt: { $gte: since } }) };
  const options = { maxTimeMS: TOOL_MAX_TIME_MS };
  const groups = await reports.aggregate<{ _id: { hub: string; outcome: ShadowOutcome }; count: number }>([{ $match: filter }, { $group: { _id: { hub: '$hub', outcome: '$outcome' }, count: { $sum: 1 } } }], options).toArray();
  const byOutcome = emptyOutcomes();
  const hubs = new Map<string, { hub: string; total: number } & Record<ShadowOutcome, number>>();
  let total = 0;
  for (const { _id, count } of groups) {
    byOutcome[_id.outcome] += count;
    total += count;
    const row = hubs.get(_id.hub) ?? { hub: _id.hub, total: 0, ...emptyOutcomes() };
    row[_id.outcome] += count;
    row.total += count;
    hubs.set(_id.hub, row);
  }
  const topIssues = (
    await reports
      .aggregate<{ _id: { code: string; severity: string }; count: number }>(
        [{ $match: filter }, { $unwind: '$issues' }, { $group: { _id: { code: '$issues.code', severity: '$issues.severity' }, count: { $sum: 1 } } }, { $sort: { count: -1, '_id.code': 1 } }, { $limit: MAX_CODES }],
        options,
      )
      .toArray()
  ).map(({ _id, count }) => ({ code: _id.code, severity: _id.severity, occurrences: count }));
  const blocked = (
    await reports
      .aggregate<{ _id: string; count: number; records: Document[] }>(
        [
          { $match: { ...filter, outcome: { $in: ['blocked', 'mappingFailed'] } } },
          { $unwind: '$issues' },
          { $match: { 'issues.severity': 'error' } },
          { $group: { _id: { code: '$issues.code', queueId: '$queueId' }, hub: { $first: '$hub' }, documentType: { $first: '$documentType' }, number: { $first: '$number' }, date: { $first: '$date' } } },
          { $sort: { '_id.queueId': 1 } },
          {
            $group: {
              _id: '$_id.code',
              count: { $sum: 1 },
              records: { $firstN: { n: MAX_RECORDS_PER_CODE, input: { queueId: '$_id.queueId', hub: '$hub', documentType: '$documentType', number: '$number', date: '$date' } } },
            },
          },
          { $sort: { count: -1, _id: 1 } },
          { $limit: MAX_CODES },
        ],
        options,
      )
      .toArray()
  ).map((entry) => ({ code: entry._id, records: entry.count, examples: entry.records.map(toRef) }));
  const sized: Document = { ...filter, xmlBytes: { $ne: null } };
  const files = await reports.countDocuments(sized, options);
  let size: ShadowSummary['size'] = null;
  if (files > 0) {
    const rank = Math.ceil(0.95 * files);
    const at = async (skip: number): Promise<number> => ((await reports.find(sized, { projection: { xmlBytes: 1 }, sort: { xmlBytes: -1 }, skip, limit: 1, ...options }).next()) as { xmlBytes: number }).xmlBytes;
    size = { files, maxBytes: await at(0), p95Bytes: await at(files - rank) };
  }
  return {
    codeVersion,
    since: since === undefined ? null : since.toISOString(),
    total,
    byOutcome,
    byHub: [...hubs.values()].sort((left, right) => left.hub.localeCompare(right.hub)),
    topIssues,
    blocked,
    size,
  };
}

/**
 * Formats the summary as plain text.
 *
 * @param summary The summary.
 * @returns The lines, ending with a line break.
 */
export function formatSummary(summary: ShadowSummary): string {
  const lines = [`Shadow report - code version ${summary.codeVersion}${summary.since === null ? '' : ` - analysed since ${summary.since}`}`, `Records analysed: ${summary.total}`];
  lines.push(`By outcome: ${SHADOW_OUTCOMES.map((outcome) => `${outcome} ${summary.byOutcome[outcome]}`).join(', ')}`, 'By hub:');
  for (const row of summary.byHub) {
    lines.push(`  ${row.hub}: total ${row.total}, ${SHADOW_OUTCOMES.map((outcome) => `${outcome} ${row[outcome]}`).join(', ')}`);
  }
  lines.push('Top issue codes:');
  for (const entry of summary.topIssues) {
    lines.push(`  ${entry.code} (${entry.severity}): ${entry.occurrences}`);
  }
  lines.push('Blocked records by code:');
  for (const entry of summary.blocked) {
    lines.push(`  ${entry.code}: ${entry.records} record(s)`);
    for (const record of entry.examples) {
      lines.push(`    ${record.queueId} ${record.hub} ${record.documentType ?? '-'} ${record.number ?? '-'} ${record.date ?? '-'}`);
    }
  }
  lines.push(summary.size === null ? 'File size: no file was built' : `File size: max ${summary.size.maxBytes} bytes, p95 ${summary.size.p95Bytes} bytes (${summary.size.files} files)`);
  return `${lines.join('\n')}\n`;
}

const USAGE = 'usage: shadow-report [--version <codeVersion>] [--since <ISO date | Nh | Nd>] [--json]\n';

/**
 * Runs the command.
 *
 * @param proc The process (environment, arguments, output).
 * @param deps Replaceable collaborators.
 * @returns The exit code: 0, 1 when the configuration or MongoDB is wrong, 2 for a wrong option.
 */
export async function runShadowReport(proc: ToolProcess, deps: ToolDeps = {}): Promise<number> {
  const now = (deps.clock ?? Date.now)();
  let values: { version?: string | undefined; since?: string | undefined; json?: boolean | undefined };
  try {
    values = parseArgs({ args: [...proc.argv], options: { version: { type: 'string' }, since: { type: 'string' }, json: { type: 'boolean' } }, strict: true }).values;
  } catch (error) {
    proc.stderr.write(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const since = values.since === undefined ? undefined : parseSince(values.since, now);
  if (values.since !== undefined && since === undefined) {
    proc.stderr.write(`--since must be an ISO date or a duration such as 12h or 7d\n${USAGE}`);
    return 2;
  }
  const context = await openToolContext(proc, deps);
  if (context === undefined) {
    return 1;
  }
  let code: number;
  try {
    const version = values.version ?? currentCodeVersion(context.config.buildSha);
    const summary = await summarise(context.client.db(context.commonDatabase).collection<ShadowReport>(SHADOW_COLLECTION), version, since);
    proc.stdout.write(values.json === true ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary));
    code = 0;
  } catch (error) {
    proc.stderr.write(`the report failed (${describeError(error).errorName})\n`);
    code = 1;
  }
  await context.close();
  return code;
}

if (import.meta.main) {
  process.exitCode = await runShadowReport({ env: process.env, argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr });
}
