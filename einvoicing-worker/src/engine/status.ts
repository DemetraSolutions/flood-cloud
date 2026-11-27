/**
 * The status job: asks the provider what happened to the files it took, and writes the answer.
 *
 * Records due for a check (`worker.state` `uploaded`, `nextStatusAt` reached, oldest first; plus the records the legacy
 * uploaded, adopted on first sight) are claimed one at a time within the per-IP status spacing and the round budget.
 * After a non-final answer the next check comes after 5, 15, 30 minutes, 1, 2, 4, 8 hours, then every 12 hours; 30 days
 * after the upload, or after three "unknown file" answers, the record stops being polled and is flagged `review` (it stays
 * in the queue, visible). Final states are in `status-rules.ts`.
 *
 * Order of writes on an answer: fence probe, group document, then the queue record (last), so a crash in between only
 * means the status is asked again.
 *
 * @module
 */
import type { Document, ObjectId } from 'mongodb';
import { parseHub } from '../accounts/hub.ts';
import { COOLDOWN_ONLY, FencedError } from '../limits/limiters.ts';
import type { ProviderAdapter, SdiError, StatusOutcome } from '../providers/types.ts';
import type { Job } from '../runner.ts';
import type { EngineContext, RoundState } from './context.ts';
import { describeError, rotate } from './context.ts';
import { settleHistory } from './history-sync.ts';
import { accountKey, ipFreeBefore, ipKey, takeIpSlot } from './pacing.ts';
import { dispositionOf, formatOf, KEPT_ERRORS, MAX_NOT_FOUND, nextStatusDelay, REVIEW_AFTER_MS } from './status-rules.ts';

/** Wait before asking again after an unexpected error. */
export const STATUS_ERROR_RETRY_MS = 60_000;
const MAX_SDI_ERRORS = 20;
const MAX_DESCRIPTION = 500;

/** Everything one claimed record needs. */
interface Work {
  readonly hub: string;
  readonly adapter: ProviderAdapter;
  readonly record: Document;
  readonly id: ObjectId;
  readonly queueId: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

/**
 * Creates the status job.
 *
 * @param ctx Shared collaborators.
 * @param round State of the current round, set by the preparation job.
 * @param budgetMs Time budget of the whole round; this job may use all of it (the upload job went first).
 * @returns The job.
 */
export function createStatusJob(ctx: EngineContext, round: RoundState, budgetMs: number): Job {
  const { queue, history, groups, registry, limiters, logger, clock } = ctx;

  const workerOf = (work: Work): Document => work.record['worker'] as Document;

  /** Writes the next due time (and anything else) on the record and releases the claim. */
  const reschedule = async (work: Work, delayMs: number, set: Document = {}): Promise<void> => {
    const now = clock();
    await queue.update(work.id, work.epoch, { 'worker.leaseUntil': new Date(now), 'worker.nextStatusAt': new Date(now + delayMs), ...set });
  };

  /** After a non-final answer: the next check, or `review` when the record is too old (or the provider never knew it). */
  const next = async (work: Work, answers: number, set: Document, forceReview: boolean): Promise<void> => {
    const now = clock();
    const uploadedAt = (workerOf(work)['uploadedAt'] as Date).getTime();
    if (forceReview || now - uploadedAt >= REVIEW_AFTER_MS) {
      await queue.update(work.id, work.epoch, { ...set, 'worker.state': 'review', 'worker.statusChecks': answers, 'worker.leaseUntil': new Date(now) }, ['worker.nextStatusAt']);
      logger.warn('the invoice needs a manual check: polling stopped', { hub: work.hub, queueId: work.queueId, answers });
      return;
    }
    await reschedule(work, nextStatusDelay(answers), { ...set, 'worker.statusChecks': answers });
  };

  const answered = async (work: Work, outcome: Extract<StatusOutcome, { kind: 'status' }>, answers: number): Promise<void> => {
    const now = clock();
    const { status } = outcome;
    await queue.extendLease(work.id, work.epoch, now);
    if (!(await groups.setSendStatus(work.record['groupId'], work.id, status))) {
      logger.warn('the group document was not updated', { hub: work.hub, queueId: work.queueId });
    }
    const disposition = dispositionOf(status, formatOf(work.record));
    if (disposition === 'delete') {
      await queue.remove(work.id, work.epoch);
      logger.info('invoice finished: removed from the queue', { hub: work.hub, queueId: work.queueId, status });
      return;
    }
    if (disposition === 'continue') {
      await next(work, answers, { sendStatus: status, 'worker.lastCode': status }, false);
      return;
    }
    await history.release(work.id, now);
    const sdiErrors: readonly SdiError[] = (outcome.sdiErrors ?? []).slice(0, MAX_SDI_ERRORS).map(({ code, description }) => ({ code: code.slice(0, 50), description: description.slice(0, 300) }));
    const base = KEPT_ERRORS[status as 'rejected' | 'processingError' | 'refused'];
    const first = sdiErrors[0];
    const errorDescription = (first === undefined ? base.errorDescription : `${base.errorDescription}: ${first.code} ${first.description}`).slice(0, MAX_DESCRIPTION);
    await queue.update(
      work.id,
      work.epoch,
      {
        sendStatus: status,
        error: { errorCode: base.errorCode, errorDescription },
        'worker.state': 'done',
        'worker.statusChecks': answers,
        'worker.lastCode': status,
        'worker.leaseUntil': new Date(now),
        ...(sdiErrors.length > 0 ? { 'worker.sdiErrors': sdiErrors } : {}),
      },
      ['worker.nextStatusAt'],
    );
    logger.warn('invoice finished with an error: kept in the queue', { hub: work.hub, queueId: work.queueId, status });
  };

  const handle = async (work: Work): Promise<boolean> => {
    const pending = workerOf(work);
    if (pending['historyPending'] === true) {
      // The upload wrote `sent` and `hubId` but not the history entry: do it before the file can reach a final state.
      await settleHistory({ history, queue, logger, id: work.id, epoch: work.epoch, hub: work.hub, queueId: work.queueId, key: pending['historyKey'] as string, providerId: String(work.record['hubId']), sentAt: pending['uploadedAt'] as Date });
    }
    const account = await registry.get(work.hub, { fresh: true });
    if (account === undefined) {
      await reschedule(work, STATUS_ERROR_RETRY_MS);
      return false;
    }
    if (!(await takeIpSlot(ctx, work.adapter, 'status', work.deadline, work.signal))) {
      await reschedule(work, 0);
      return false;
    }
    const outcome = await work.adapter.status(account, String(work.record['hubId']), work.signal);
    const answers = (workerOf(work)['statusChecks'] as number) + 1;
    switch (outcome.kind) {
      case 'status':
        await answered(work, outcome, answers);
        return true;
      case 'notFound': {
        const missing = ((workerOf(work)['notFoundChecks'] as number | undefined) ?? 0) + 1;
        logger.warn('the provider does not know the file', { hub: work.hub, queueId: work.queueId, missing });
        await next(work, answers, { 'worker.notFoundChecks': missing }, missing >= MAX_NOT_FOUND);
        return true;
      }
      case 'retry':
        await limiters.coolDown(outcome.scope === 'ip' ? ipKey(work.adapter.provider, 'status') : accountKey(work.hub, 'status'), clock() + outcome.afterMs);
        await reschedule(work, outcome.afterMs, { 'worker.lastCode': outcome.code });
        logger.warn('the provider asked to wait before the next status request', { hub: work.hub, scope: outcome.scope, code: outcome.code, afterMs: outcome.afterMs });
        return true;
    }
  };

  /** Claims and handles one record of a provider. Returns whether the record was dealt with (`false`: nothing claimed, or given back unprocessed: do not come back this round). */
  const checkOne = async (provider: string, epoch: number, signal: AbortSignal, deadline: number): Promise<boolean> => {
    const adapter = ctx.adapters.get(provider) as ProviderAdapter;
    if (!ipFreeBefore(ctx, adapter, 'status', deadline)) {
      return false;
    }
    const now = clock();
    const hubs = round.activeHubs.filter((hub) => parseHub(hub).provider === provider && limiters.gate(accountKey(hub, 'status'), COOLDOWN_ONLY, now).at <= now);
    if (hubs.length === 0) {
      return false;
    }
    const record = await queue.claimForStatus(hubs, epoch, now);
    if (record === null) {
      return false;
    }
    const id = record['_id'] as ObjectId;
    const hub = ((record['company'] as Document)['fattura_elettronica'] as Document)['hub'] as string;
    const work: Work = { hub, adapter, record, id, queueId: id.toHexString(), epoch, signal, deadline };
    try {
      return await handle(work);
    } catch (error) {
      if (error instanceof FencedError) {
        throw error;
      }
      logger.error('status check failed: it will be tried again', { hub, queueId: work.queueId, ...describeError(error) });
      await reschedule(work, STATUS_ERROR_RETRY_MS);
      return true;
    }
  };

  return {
    name: 'status',
    async run({ epoch, signal }) {
      const deadline = round.startedAt + budgetMs;
      const providers = rotate([...new Set(round.activeHubs.map((hub) => parseHub(hub).provider))], round.rotation);
      let progressed = providers.length > 0;
      try {
        while (progressed && !signal.aborted && clock() < deadline) {
          progressed = false;
          for (const provider of providers) {
            if (signal.aborted || clock() >= deadline) {
              break;
            }
            progressed = (await checkOne(provider, epoch, signal, deadline)) || progressed;
          }
        }
      } catch (error) {
        if (!(error instanceof FencedError)) {
          throw error;
        }
        logger.warn('status stopped: a newer lease epoch owns the data');
      }
    },
  };
}
