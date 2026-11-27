/**
 * Writing the sent-history entry of an accepted file, **after** the file is recorded as sent.
 *
 * The queue record is written first (`sent`, `hubId`), so a failure here can never cause a second upload. The entry is
 * best effort: on a failure the record keeps `worker.historyPending` (and `worker.historyKey`) and the status job tries
 * again at its next check. A duplicate-key error means another live entry holds the key (an SdI-level collision):
 * it is logged, `worker.historyPending` becomes `false`, `worker.historyConflict` is set, and the record is never
 * processed again for it.
 *
 * @module
 */
import type { ObjectId } from 'mongodb';
import type { Logger } from '../logger.ts';
import { describeError } from './context.ts';
import type { SentHistory } from './history.ts';
import type { QueueStore } from './queue.ts';

/** What {@link settleHistory} needs. */
export interface HistoryWork {
  readonly history: SentHistory;
  readonly queue: QueueStore;
  readonly logger: Logger;
  readonly id: ObjectId;
  readonly epoch: number;
  readonly hub: string;
  readonly queueId: string;
  readonly key: string;
  readonly providerId: string;
  readonly sentAt: Date;
}

/**
 * Writes the history entry and clears the pending mark; never raises for a history problem.
 *
 * @param work The record and the entry.
 * @throws {FencedError} Only when the record's `worker.*` write is fenced out.
 */
export async function settleHistory(work: HistoryWork): Promise<void> {
  const { id, epoch, hub, queueId } = work;
  try {
    await work.history.recordAccepted({ key: work.key, queueId: id, hub, providerId: work.providerId, sentAt: work.sentAt });
  } catch (error) {
    if ((error as { code?: unknown }).code === 11000) {
      work.logger.warn('the invoice number is already in the history: no entry written', { hub, queueId });
      await work.queue.update(id, epoch, { 'worker.historyPending': false, 'worker.historyConflict': true });
      return;
    }
    work.logger.warn('the history entry could not be written: it will be tried again', { hub, queueId, ...describeError(error) });
    return;
  }
  await work.queue.update(id, epoch, {}, ['worker.historyPending', 'worker.historyKey']);
}
