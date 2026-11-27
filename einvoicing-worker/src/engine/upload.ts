/**
 * The upload job: claims queued invoices and sends them through the provider adapters.
 *
 * Per round, the allowlisted hubs with a usable account take turns (round robin, the starting hub moves every round).
 * For a hub whose account limiter is free and whose per-IP spacing fits the round, the job claims the oldest due record
 * atomically, prepares the file (`prepare.ts`), asks the provider whether it already has the file when the claim
 * inherited an `uploading` record, waits for the IP spacing, marks the record `uploading` **before** the call, records the
 * use of the limiters, calls the adapter and writes the outcome. No sleep is longer than the per-IP spacing and none
 * runs past the round budget.
 *
 * Failure model: the only way an invoice goes out twice is a lost record of a successful upload, so the record is
 * marked `uploading` first (a crash leaves a record the next claim checks with `findSent` before uploading), an
 * unknown outcome (`maybeSent`, a thrown error) keeps it `uploading`, and every write is fenced by the lease epoch.
 *
 * @module
 */
import type { Document, ObjectId } from 'mongodb';
import { parseHub } from '../accounts/hub.ts';
import { FencedError } from '../limits/limiters.ts';
import type { Job } from '../runner.ts';
import type { Account, InvoiceRef, ProviderAdapter, UploadOutcome } from '../providers/types.ts';
import { romeDate } from '../time.ts';
import type { ValidationIssue } from '../validation/issue.ts';
import type { EngineContext, RoundState } from './context.ts';
import { describeError, rotate } from './context.ts';
import { settleHistory } from './history-sync.ts';
import { rawInvoiceRef } from './ref.ts';
import { accountKey, accountRule, ipFreeBefore, ipKey, sellerPrefix, takeIpSlot } from './pacing.ts';
import { prepareInvoice } from './prepare.ts';
import type { Prepared } from './prepare.ts';
import { FIRST_STATUS_DELAY_MS } from './status-rules.ts';

/** Wait before looking again at a file that may have been sent. */
export const MAYBE_SENT_RETRY_MS = 5 * 60_000;
/** Wait before retrying a record after an unexpected error. */
export const ERROR_RETRY_MS = 60_000;
/** How far back a complete search that found nothing is trusted: the provider may list a file a while after taking it. */
export const SEARCH_LAG_MS = 3_600_000;
/** `maybeSent` answers tolerated for one record; the next one stops it for a person (a loop of unknown outcomes). */
export const MAX_MAYBE_SENT_CYCLES = 3;
/** Most issues stored on a record. */
export const MAX_STORED_ISSUES = 50;
const MAX_DESCRIPTION = 500;

/** Everything one claimed record needs. */
interface Work {
  readonly hub: string;
  readonly adapter: ProviderAdapter;
  readonly record: Document;
  readonly id: ObjectId;
  readonly queueId: string;
  readonly previousState: string | undefined;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly deadline: number;
}

/**
 * Creates the upload job.
 *
 * @param ctx Shared collaborators.
 * @param round State of the current round, set by the preparation job.
 * @param budgetMs Time budget of the whole round; this job uses the first half.
 * @returns The job.
 */
export function createUploadJob(ctx: EngineContext, round: RoundState, budgetMs: number): Job {
  const { queue, history, groups, registry, limiters, logger, clock } = ctx;
  const warnedYear = new Map<string, string>();

  const adapterOf = (hub: string): ProviderAdapter => ctx.adapters.get(parseHub(hub).provider) as ProviderAdapter;

  /** Hands the record back: due again after `delayMs`, the claim released, any other field as given. */
  const release = async (work: Work, delayMs: number, set: Document = {}, inc: Document = {}): Promise<void> => {
    const now = clock();
    await queue.update(work.id, work.epoch, { 'worker.leaseUntil': new Date(now), 'worker.nextAttemptAt': new Date(now + delayMs), ...set }, [], inc);
  };

  /** Stops the record for a person: it stays in the queue, never uploaded, never looked at again by the worker. */
  const toReview = async (work: Work, code: string, message: string): Promise<void> => {
    await queue.update(work.id, work.epoch, { 'worker.state': 'review', 'worker.lastCode': code, 'worker.leaseUntil': new Date(clock()) });
    logger.warn(message, { hub: work.hub, queueId: work.queueId });
  };

  /** Stores a failure on the record and on the group's document. The record is never sent. */
  const fail = async (work: Work, sendStatus: string, error: Document, set: Document): Promise<void> => {
    const now = clock();
    await queue.extendLease(work.id, work.epoch, now);
    if (!(await groups.setSendStatus(work.record['groupId'], work.id, sendStatus))) {
      logger.warn('the group document was not updated', { hub: work.hub, queueId: work.queueId });
    }
    await queue.update(work.id, work.epoch, { error, sendStatus, 'worker.state': 'failed', 'worker.leaseUntil': new Date(now), ...set });
  };

  const failValidation = async (work: Work, prepared: Extract<Prepared, { ok: false }>): Promise<void> => {
    const issues = prepared.issues.slice(0, MAX_STORED_ISSUES);
    const description = prepared.errors === 1 ? '1 errore di validazione' : `${prepared.errors} errori di validazione`;
    await fail(
      work,
      'validationError',
      { errorCode: 'VALIDATION', errorDescription: description, issues: issues.map(({ code, path, message }: ValidationIssue) => ({ code, path, message })) },
      { 'worker.lastCode': 'VALIDATION', 'worker.validation': issues },
    );
    logger.warn('invoice not sent: validation failed', { hub: work.hub, queueId: work.queueId, errors: prepared.errors });
  };

  /**
   * The provider took the file (or already had it). The queue record is written **first** (`sent`, `hubId`: not fenced,
   * the file is at the provider whatever happened to the lease), then its `worker` state (fenced), then the history entry
   * (best effort, see `history-sync.ts`): nothing after the first write can cause a second upload.
   */
  const accepted = async (work: Work, account: Account, key: string | undefined, providerId: string): Promise<void> => {
    const now = clock();
    await queue.markSent(work.id, providerId, key);
    await queue.update(
      work.id,
      work.epoch,
      {
        'worker.state': 'uploaded',
        'worker.uploadedAt': new Date(now),
        'worker.nextStatusAt': new Date(now + FIRST_STATUS_DELAY_MS),
        'worker.statusChecks': 0,
        'worker.leaseUntil': new Date(now),
      },
      ['worker.lastCode', 'worker.validation', 'worker.nextAttemptAt'],
    );
    if (key !== undefined) {
      await settleHistory({ history, queue, logger, id: work.id, epoch: work.epoch, hub: work.hub, queueId: work.queueId, key, providerId, sentAt: new Date(now) });
    }
    await limiters.resetBackoff(accountKey(account.hub, 'upload'));
    logger.info('invoice uploaded', { hub: work.hub, queueId: work.queueId });
  };

  const retryLater = async (work: Work, outcome: Extract<UploadOutcome, { kind: 'retry' }>): Promise<void> => {
    const now = clock();
    let delay = outcome.afterMs;
    switch (outcome.scope) {
      case 'document':
        break;
      case 'seller': {
        const code: unknown = (work.record['company'] as Document)['code'];
        if (typeof code === 'string' && code !== '') {
          await limiters.coolDown(`${sellerPrefix(work.hub)}${code}`, now + delay);
        } else {
          // No seller code to key the cooldown on: the whole account waits instead (the conservative reading).
          delay = await limiters.backoff(accountKey(work.hub, 'upload'), work.adapter.limits.account.backoffStepsMs, delay, now);
        }
        break;
      }
      case 'account':
        delay = await limiters.backoff(accountKey(work.hub, 'upload'), work.adapter.limits.account.backoffStepsMs, delay, now);
        break;
      case 'ip':
        await limiters.coolDown(ipKey(work.adapter.provider, 'upload'), now + delay);
        break;
    }
    await release(work, delay, { 'worker.state': 'claimed', 'worker.lastCode': outcome.code });
    logger.warn('the provider asked to retry', { hub: work.hub, queueId: work.queueId, scope: outcome.scope, code: outcome.code, afterMs: delay });
  };

  /**
   * Settles a record found `uploading` **before** anything else: asks the provider whether it already has the file,
   * using a reference built from the raw record (no validation: a record that no longer validates may still be at the
   * provider). Returns `upload` to go on, `done` when the record was dealt with, `deferred` when it was handed back.
   */
  const recover = async (work: Work, account: Account, ref: InvoiceRef): Promise<'upload' | 'done' | 'deferred'> => {
    if (!(await takeIpSlot(ctx, work.adapter, 'status', work.deadline, work.signal))) {
      await release(work, 0);
      return 'deferred';
    }
    const found = await work.adapter.findSent(account, ref, work.signal);
    switch (found.kind) {
      case 'found': {
        logger.warn('an interrupted upload had been accepted: recorded', { hub: work.hub, queueId: work.queueId });
        const prepared = await prepareInvoice(work.record, { transmitter: work.adapter.transmitter, groups, lookup: history.lookupFor(work.id), now: clock() });
        if (!prepared.ok) {
          logger.warn('the recovered invoice no longer validates: no history entry is written', { hub: work.hub, queueId: work.queueId });
        }
        await accepted(work, account, prepared.ok ? prepared.key : undefined, found.providerId);
        return 'done';
      }
      case 'retry':
        await release(work, found.afterMs, { 'worker.lastCode': found.code, ...(found.resume === undefined ? {} : { 'worker.findFrom': found.resume }) });
        return 'deferred';
      case 'unknown':
        await toReview(work, 'FIND_INCOMPLETE', 'the search at the provider could not be completed: the invoice needs a manual check');
        return 'done';
      case 'notFound':
        // A complete search found nothing up to an hour ago (the provider may list a file late): the next one starts there.
        await queue.update(work.id, work.epoch, { 'worker.searchedUntil': new Date(clock() - SEARCH_LAG_MS) }, ['worker.findFrom']);
        return 'upload';
    }
  };

  const handle = async (work: Work): Promise<boolean> => {
    const account = await registry.get(work.hub, { fresh: true });
    if (account === undefined) {
      await release(work, ERROR_RETRY_MS);
      logger.warn('the account is no longer usable: the record waits', { hub: work.hub, queueId: work.queueId });
      return false;
    }
    if (work.previousState === 'uploading') {
      const ref = rawInvoiceRef(work.record);
      if (ref === undefined) {
        await toReview(work, 'NO_REF', 'a record that may have been sent cannot be looked up: it needs a manual check');
        return true;
      }
      const recovered = await recover(work, account, ref);
      if (recovered !== 'upload') {
        return recovered === 'done';
      }
    }
    const prepared = await prepareInvoice(work.record, { transmitter: work.adapter.transmitter, groups, lookup: history.lookupFor(work.id), now: clock() });
    if (!prepared.ok) {
      await failValidation(work, prepared);
      return true;
    }
    if (!(await takeIpSlot(ctx, work.adapter, 'upload', work.deadline, work.signal))) {
      await release(work, 0);
      return false;
    }
    await queue.markUploading(work.id, work.epoch, clock());
    await limiters.consume(accountKey(work.hub, 'upload'), accountRule(work.adapter, account), clock());
    const outcome = await work.adapter.upload(account, prepared.file, work.signal);
    switch (outcome.kind) {
      case 'accepted':
        await accepted(work, account, prepared.key, outcome.providerId);
        return true;
      case 'rejected':
        await fail(work, 'processingError', { errorCode: outcome.code, errorDescription: outcome.description.slice(0, MAX_DESCRIPTION) }, { 'worker.lastCode': outcome.code });
        logger.warn('invoice rejected by the provider', { hub: work.hub, queueId: work.queueId, code: outcome.code });
        return true;
      case 'maybeSent': {
        const cycles = (((work.record['worker'] ?? {}) as Document)['maybeSentCycles'] as number | undefined) ?? 0;
        if (cycles >= MAX_MAYBE_SENT_CYCLES) {
          await toReview(work, 'MAYBE_SENT_LOOP', 'the file keeps being "maybe sent": the invoice needs a manual check');
          return true;
        }
        await release(work, MAYBE_SENT_RETRY_MS, { 'worker.state': 'uploading', 'worker.lastCode': 'MAYBE_SENT' }, { 'worker.maybeSentCycles': 1 });
        logger.warn('the file may have been sent: it will be looked up', { hub: work.hub, queueId: work.queueId });
        return true;
      }
      case 'retry':
        await retryLater(work, outcome);
        return true;
    }
  };

  /** Claims and handles one record of a hub. Returns whether the record was dealt with (`false`: nothing claimed, or given back unprocessed: do not come back this round). */
  const uploadOne = async (hub: string, epoch: number, signal: AbortSignal, deadline: number): Promise<boolean> => {
    const adapter = adapterOf(hub);
    const cached = await registry.get(hub);
    if (cached === undefined) {
      return false;
    }
    const now = clock();
    const gate = limiters.gate(accountKey(hub, 'upload'), accountRule(adapter, cached), now);
    if (gate.at > now) {
      if (gate.reason === 'year' && warnedYear.get(hub) !== romeDate(now)) {
        warnedYear.set(hub, romeDate(now));
        logger.warn('the yearly cap of the account is reached: nothing is sent until 1 January', { hub });
      }
      return false;
    }
    if (!ipFreeBefore(ctx, adapter, 'upload', deadline)) {
      return false;
    }
    const claim = await queue.claimForUpload(hub, limiters.blocked(sellerPrefix(hub), now), epoch, now);
    if (claim === null) {
      return false;
    }
    const id = claim.record['_id'] as ObjectId;
    const work: Work = { hub, adapter, record: claim.record, id, queueId: id.toHexString(), previousState: claim.previousState, epoch, signal, deadline };
    try {
      return await handle(work);
    } catch (error) {
      if (error instanceof FencedError) {
        throw error;
      }
      logger.error('upload failed: the record will be tried again', { hub, queueId: work.queueId, ...describeError(error) });
      await release(work, ERROR_RETRY_MS, { 'worker.lastCode': 'ERROR' });
      return true;
    }
  };

  return {
    name: 'upload',
    async run({ epoch, signal }) {
      const deadline = round.startedAt + Math.floor(budgetMs / 2);
      const hubs = rotate(round.activeHubs, round.rotation);
      let progressed = hubs.length > 0;
      try {
        while (progressed && !signal.aborted && clock() < deadline) {
          progressed = false;
          for (const hub of hubs) {
            if (signal.aborted || clock() >= deadline) {
              break;
            }
            progressed = (await uploadOne(hub, epoch, signal, deadline)) || progressed;
          }
        }
      } catch (error) {
        if (!(error instanceof FencedError)) {
          throw error;
        }
        logger.warn('upload stopped: a newer lease epoch owns the data');
      }
    },
  };
}
