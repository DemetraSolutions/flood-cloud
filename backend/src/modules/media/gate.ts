import { AppError } from '../../shared/http/errors.ts';

/** Uploads handled at the same time by one process: each holds up to 10 MB in memory and a CPU while it is processed. */
export const MAX_RUNNING_UPLOADS = 2;

/** Uploads that may wait for a slot; beyond them the answer is `503` at once, so the memory held by waiting requests has a ceiling. */
export const MAX_WAITING_UPLOADS = 6;

/** Seconds a refused client is told to wait. */
const RETRY_AFTER_SECONDS = '5';

/** A bounded gate in front of the upload: at most `running` requests inside and `waiting` queued. */
export interface Gate {
  /**
   * Takes a slot, waiting in a queue when all are taken.
   *
   * @returns The function that gives the slot back (safe to call more than once).
   * @throws {AppError} `SERVICE_UNAVAILABLE` with `Retry-After` when the queue is full.
   */
  enter(): Promise<() => void>;
}

/**
 * Creates a gate.
 *
 * @param running Most requests inside at once, at least 1.
 * @param waiting Most requests waiting for a slot; 0 refuses everything beyond `running`.
 */
export function createGate(running: number, waiting: number): Gate {
  let inside = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    const next = queue.shift();
    if (next === undefined) {
      inside -= 1;
    } else {
      // The slot passes straight to the next waiting request.
      next();
    }
  };
  return {
    enter: async () => {
      if (inside >= running) {
        if (queue.length >= waiting) {
          throw new AppError('SERVICE_UNAVAILABLE', { headers: { 'Retry-After': RETRY_AFTER_SECONDS } });
        }
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        inside += 1;
      }
      let given = false;
      return () => {
        if (!given) {
          given = true;
          release();
        }
      };
    },
  };
}
