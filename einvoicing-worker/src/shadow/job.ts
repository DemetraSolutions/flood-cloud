/**
 * The shadow job: runs the send pipeline on the queue records of the selected hubs and stores a report per record and code
 * version, **without ever sending, claiming or modifying anything**.
 *
 * It replaces the engine jobs when `WORKER_MODE=shadow` (the default). What it can touch is fixed by the ports it is given:
 * a read-only queue ({@link ShadowQueue}), the original of a credit note (`readOriginal`), the sent history lookup (a read),
 * and the report collection (the only write, with its own two indexes). It builds no provider adapter and holds no credential.
 *
 * Every round it walks the queue by ascending `_id` from a watermark kept in memory (a restart walks again from the start,
 * skipping the records that already have a report for the code version, which is cheap), analyses at most `batch` records
 * not yet reported, and stops at the round budget or the abort signal. Records with a greater id than the watermark are the
 * new ones: queue ids grow with time. A record the legacy refused (`error`) and later retried by hand, which has an id below the
 * watermark, is not seen again until the next code version.
 *
 * An unexpected error while analysing a record (a database read failing) is logged and the round stops, so the record is
 * tried again next round; after {@link MAX_ANALYSIS_ATTEMPTS} failures the record gets a `blocked` report with the issue
 * `ANALYSIS_ERROR` and the walk goes on.
 *
 * @module
 */
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import type { Logger } from '../logger.ts';
import type { Job } from '../runner.ts';
import { describeError } from '../engine/context.ts';
import type { ShadowHubs } from '../config.ts';
import { analyseRecord, failedReport, hubOf, SHADOW_TRANSMITTERS } from './analyse.ts';
import type { AnalyseOptions } from './analyse.ts';
import type { ShadowQueue } from './queue.ts';
import type { ShadowReports } from './reports.ts';

/** Failures of the analysis of one record after which it is reported as `ANALYSIS_ERROR` and left behind. */
export const MAX_ANALYSIS_ATTEMPTS = 3;

/** Settings and ports of {@link createShadowJob}. */
export interface ShadowJobOptions {
  readonly queue: ShadowQueue;
  readonly reports: ShadowReports;
  readonly groups: AnalyseOptions['groups'];
  readonly lookupFor: AnalyseOptions['lookupFor'];
  /** The hubs to analyse (`SHADOW_HUBS`). */
  readonly hubs: ShadowHubs;
  /** Most records analysed per round (`SHADOW_BATCH`). */
  readonly batch: number;
  /** The code version the reports carry. */
  readonly codeVersion: string;
  /** Days to look back: records with an older id are ignored (`SHADOW_LOOKBACK_DAYS`). */
  readonly lookbackDays: number;
  /** Time budget of a round, in milliseconds. */
  readonly budgetMs: number;
  readonly logger: Logger;
  readonly clock: () => number;
  /** Transmitters by provider ({@link SHADOW_TRANSMITTERS} by default). */
  readonly transmitters?: AnalyseOptions['transmitters'];
}

/**
 * Creates the shadow job.
 *
 * @param options Ports and settings.
 * @returns The job to hand to the runner.
 */
export function createShadowJob(options: ShadowJobOptions): Job {
  const { queue, reports, logger, clock, batch } = options;
  const transmitters = options.transmitters ?? SHADOW_TRANSMITTERS;
  const failures = new Map<string, number>();
  const skippedLogged = new Set<string>();
  let watermark: ObjectId | undefined;
  let announced = false;
  let indexesReady = false;

  /** Analyses and stores one record: the outcome, `skipped`, or `retry` when the round must stop and try it again. */
  const analyseOne = async (record: Document, key: string): Promise<string> => {
    const now = clock();
    try {
      const result = await analyseRecord(record, { transmitters, groups: options.groups, lookupFor: options.lookupFor, now, codeVersion: options.codeVersion });
      if (result.kind === 'skipped') {
        const label = result.hub ?? result.reason;
        if (!skippedLogged.has(label)) {
          skippedLogged.add(label);
          logger.warn('shadow: records skipped', { reason: result.reason, ...(result.hub === undefined ? {} : { hub: result.hub }) });
        }
        return 'skipped';
      }
      await reports.save(result.report);
      failures.delete(key);
      return result.report.outcome;
    } catch (error) {
      const attempts = (failures.get(key) ?? 0) + 1;
      failures.set(key, attempts);
      logger.error('shadow: analysis failed', { queueId: key, attempts, ...describeError(error) });
      if (attempts < MAX_ANALYSIS_ATTEMPTS) {
        return 'retry';
      }
      const report = failedReport(record, hubOf(record) as string, { codeVersion: options.codeVersion, now });
      await reports.save(report);
      failures.delete(key);
      return report.outcome;
    }
  };

  return {
    name: 'shadow',
    async run({ signal }) {
      if (options.hubs.length === 0) {
        if (!announced) {
          announced = true;
          logger.info('no hubs selected (SHADOW_HUBS is empty): the shadow mode analyses nothing');
        }
        return;
      }
      if (!indexesReady) {
        await reports.ensureIndexes();
        indexesReady = true;
      }
      const startedAt = clock();
      const counts: Record<string, number> = {};
      let analysed = 0;
      let skipped = 0;
      const withinBudget = (): boolean => analysed < batch && !signal.aborted && clock() - startedAt < options.budgetMs;
      scan: while (withinBudget()) {
        const ids = await queue.idsAfter(watermark, options.hubs, batch, ObjectId.createFromTime(Math.max(0, Math.floor((clock() - options.lookbackDays * 86_400_000) / 1000))));
        if (ids.length === 0) {
          break;
        }
        const known = await reports.analysed(ids, options.codeVersion);
        for (const id of ids) {
          const key = id.toHexString();
          if (!known.has(key)) {
            if (!withinBudget()) {
              break scan;
            }
            const record = await queue.read(id);
            if (record !== null) {
              const outcome = await analyseOne(record, key);
              if (outcome === 'retry') {
                break scan;
              }
              if (outcome === 'skipped') {
                skipped += 1;
              } else {
                analysed += 1;
                counts[outcome] = (counts[outcome] ?? 0) + 1;
              }
            }
          }
          watermark = id;
        }
      }
      if (analysed > 0 || skipped > 0) {
        logger.info('shadow round', { analysed, skipped, ...counts });
      }
    },
  };
}
