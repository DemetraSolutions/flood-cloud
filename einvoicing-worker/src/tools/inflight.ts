/**
 * `npm run ops:inflight`: what the worker has in flight in the send queue, for the switch-over from the legacy cron and
 * for the rollback.
 *
 * Read-only. Lists the records being claimed (lease running) or `uploading`, the `review` records without `hubId` (possibly
 * already at the provider), counts the claimed ones with an expired lease and all `review` ones, lists the records whose history
 * entry is still pending (`worker.historyPending`), and counts the records by `sendStatus`. A record is identified by its
 * queue id, hub, document type, number and date. The exit code is 0 when nothing is claimed with a running lease, `uploading` or possibly sent (the worker
 * can be stopped and the legacy cron started again without risk of a double upload), 1 otherwise, 2 for a wrong option.
 * The queries have no index of their own: they scan the queue and are bounded by {@link TOOL_MAX_TIME_MS}.
 *
 * @module
 */
import { parseArgs } from 'node:util';
import type { Document } from 'mongodb';
import { describeError } from '../engine/context.ts';
import { openToolContext, TOOL_MAX_TIME_MS } from './context.ts';
import type { ToolDeps, ToolProcess } from './context.ts';

/** Most records listed per list. */
export const MAX_LISTED = 100;

/** One record in flight. */
export interface InflightRecord {
  readonly queueId: string;
  readonly hub: string | null;
  readonly state: string | null;
  readonly attempts: number | null;
  /** When the claim on the record ends (ISO). */
  readonly leaseUntil: string | null;
  readonly lastCode: string | null;
  readonly documentType: string | null;
  readonly number: string | null;
  readonly date: string | null;
}

/** The result of the check. */
export interface InflightReport {
  /** When the check ran (ISO): the lease of a claim is compared with it. */
  readonly at: string;
  /** Records per situation. */
  readonly counts: {
    /** `claimed` with a lease still running: a worker is on them. Blocks the rollback. */
    readonly activeClaimed: number;
    /** `claimed` with an expired lease: parked, nobody is on them (information only). */
    readonly parkedClaimed: number;
    /** `uploading`: the file may already be at the provider. Blocks the rollback. */
    readonly uploading: number;
    /** Every `review` record. */
    readonly review: number;
    /** `review` without `hubId`: stopped for a person, and the file **may already be at the provider**. Blocks the rollback. */
    readonly possiblySent: number;
  };
  /** The active `claimed` and the `uploading` records. */
  readonly records: readonly InflightRecord[];
  /** The `review` records without `hubId` (possibly sent). */
  readonly possiblySent: readonly InflightRecord[];
  /** Records uploaded whose entry in the sent history is still to be written. */
  readonly historyPending: number;
  readonly historyPendingRecords: readonly InflightRecord[];
  /** Records per `sendStatus` (`null` for a record without one). */
  readonly sendStatus: ReadonlyArray<{ readonly status: string | null; readonly count: number }>;
  /** Whether a list was cut at {@link MAX_LISTED}. */
  readonly truncated: boolean;
}

/**
 * Tells whether the worker can be stopped and the legacy cron started again: nothing is being claimed, uploaded or possibly sent.
 *
 * @param report The report.
 * @returns `true` when the exit code is 0.
 */
export function isClear(report: InflightReport): boolean {
  return report.counts.activeClaimed + report.counts.uploading + report.counts.possiblySent === 0;
}

const PROJECTION: Document = { 'company.fattura_elettronica.hub': 1, 'fattura_elettronica.tipo': 1, number: 1, prefixSuffix: 1, date: 1, 'worker.state': 1, 'worker.attempts': 1, 'worker.leaseUntil': 1, 'worker.lastCode': 1 };

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function toRecord(entry: Document): InflightRecord {
  const worker = entry['worker'] as Document;
  const number: unknown = entry['number'];
  const section = text(entry['prefixSuffix']);
  const date: unknown = entry['date'];
  const leaseUntil: unknown = worker['leaseUntil'];
  return {
    queueId: String(entry['_id']),
    hub: text(((entry['company'] as Document | undefined)?.['fattura_elettronica'] as Document | undefined)?.['hub']),
    state: text(worker['state']),
    attempts: typeof worker['attempts'] === 'number' ? worker['attempts'] : null,
    leaseUntil: leaseUntil instanceof Date ? leaseUntil.toISOString() : null,
    lastCode: text(worker['lastCode']),
    documentType: text((entry['fattura_elettronica'] as Document | undefined)?.['tipo']),
    number: typeof number === 'number' || typeof number === 'string' ? `${section ?? ''}${number}` : null,
    date: date instanceof Date ? date.toISOString().slice(0, 10) : text(date)?.slice(0, 10) ?? null,
  };
}

/**
 * Formats the report as plain text.
 *
 * @param report The report.
 * @returns The lines, ending with a line break.
 */
export function formatInflight(report: InflightReport): string {
  const line = (entry: InflightRecord): string =>
    `  ${entry.queueId} ${entry.hub ?? '-'} ${entry.state ?? '-'} attempts ${entry.attempts ?? '-'} lease until ${entry.leaseUntil ?? '-'} code ${entry.lastCode ?? '-'} ${entry.documentType ?? '-'} ${entry.number ?? '-'} ${entry.date ?? '-'}`;
  const { counts } = report;
  const lines = [`In flight: claimed (lease running) ${counts.activeClaimed}, uploading ${counts.uploading}, possibly sent (review without hubId) ${counts.possiblySent}`];
  lines.push(`Information only: claimed with an expired lease ${counts.parkedClaimed}, review in total ${counts.review}`);
  lines.push('Claimed and uploading:', ...report.records.map(line));
  lines.push('Possibly sent (check them on the provider panel):', ...report.possiblySent.map(line));
  lines.push(`History entry pending: ${report.historyPending}`, ...report.historyPendingRecords.map(line));
  lines.push('By sendStatus:', ...report.sendStatus.map((entry) => `  ${entry.status ?? '(none)'}: ${entry.count}`));
  if (report.truncated) {
    lines.push(`(the lists are cut at ${MAX_LISTED} records)`);
  }
  lines.push(isClear(report) ? 'Nothing is claimed, uploading or possibly sent: exit 0' : 'Records are claimed, uploading or possibly sent: exit 1');
  return `${lines.join('\n')}\n`;
}

const USAGE = 'usage: inflight [--json]\n';

/**
 * Runs the command.
 *
 * @param proc The process (environment, arguments, output).
 * @param deps Replaceable collaborators.
 * @returns 0 when nothing is `claimed` or `uploading`, 1 when something is (or the configuration or MongoDB is wrong), 2 for a wrong option.
 */
export async function runInflight(proc: ToolProcess, deps: ToolDeps = {}): Promise<number> {
  let json: boolean;
  try {
    json = parseArgs({ args: [...proc.argv], options: { json: { type: 'boolean' } }, strict: true }).values.json === true;
  } catch (error) {
    proc.stderr.write(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const context = await openToolContext(proc, deps);
  if (context === undefined) {
    return 1;
  }
  let code: number;
  try {
    const queue = context.client.db(context.queueDatabase).collection('documents');
    const options = { maxTimeMS: TOOL_MAX_TIME_MS };
    const now = new Date((deps.clock ?? Date.now)());
    const running = { 'worker.state': 'claimed', 'worker.leaseUntil': { $gt: now } };
    const possiblySentFilter = { 'worker.state': 'review', hubId: { $exists: false } };
    const list = async (filter: Document): Promise<{ records: InflightRecord[]; cut: boolean }> => {
      const found = await queue.find(filter, { projection: PROJECTION, sort: { _id: 1 }, limit: MAX_LISTED + 1, ...options }).toArray();
      return { records: found.slice(0, MAX_LISTED).map(toRecord), cut: found.length > MAX_LISTED };
    };
    const counts = {
      activeClaimed: await queue.countDocuments(running, options),
      parkedClaimed: await queue.countDocuments({ 'worker.state': 'claimed', $nor: [{ 'worker.leaseUntil': { $gt: now } }] }, options),
      uploading: await queue.countDocuments({ 'worker.state': 'uploading' }, options),
      review: await queue.countDocuments({ 'worker.state': 'review' }, options),
      possiblySent: await queue.countDocuments(possiblySentFilter, options),
    };
    const open = await list({ $or: [running, { 'worker.state': 'uploading' }] });
    const possiblySent = await list(possiblySentFilter);
    const pending = await list({ 'worker.historyPending': true });
    const historyPending = await queue.countDocuments({ 'worker.historyPending': true }, options);
    const sendStatus = (await queue.aggregate<{ _id: string | null; count: number }>([{ $group: { _id: '$sendStatus', count: { $sum: 1 } } }, { $sort: { _id: 1 } }], options).toArray()).map(({ _id, count }) => ({ status: text(_id), count }));
    const report: InflightReport = {
      at: now.toISOString(),
      counts,
      records: open.records,
      possiblySent: possiblySent.records,
      historyPending,
      historyPendingRecords: pending.records,
      sendStatus,
      truncated: open.cut || possiblySent.cut || pending.cut,
    };
    proc.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatInflight(report));
    code = isClear(report) ? 0 : 1;
  } catch (error) {
    proc.stderr.write(`the check failed (${describeError(error).errorName})\n`);
    code = 1;
  }
  await context.close();
  return code;
}

if (import.meta.main) {
  process.exitCode = await runInflight({ env: process.env, argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr });
}
