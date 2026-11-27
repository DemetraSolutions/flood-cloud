/**
 * A turn on a persistent per-IP limiter, taken from inside an adapter call (sign-in, notification download, the
 * second and later requests of a search): the engine takes its own turns for the upload and status requests it makes.
 *
 * @module
 */
import type { LimitRule, Limiters } from '../../limits/limiters.ts';

/** What {@link takeSlot} needs. */
export interface SlotDeps {
  readonly limiters: Limiters;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Why a turn could not be taken now, and how long to wait before asking again. */
export interface SlotRefusal {
  readonly afterMs: number;
  /** `LIMITED`: the limiter is busy for longer than the call may wait; `ABORTED`: the signal fired while waiting. */
  readonly code: 'LIMITED' | 'ABORTED';
}

/**
 * Waits (at most `maxWaitMs`) for a limiter to be free and records the use.
 *
 * @param deps Limiters, clock and sleep.
 * @param key The limiter key (`ip:aruba:auth`).
 * @param rule Its rule.
 * @param maxWaitMs Longest wait inside the call; a longer one is refused so the caller can hand the work back.
 * @param signal Aborted when the lease is lost or the worker stops.
 * @returns `undefined` when the turn was taken, otherwise why not.
 * @throws {FencedError} When a newer lease epoch owns the limiter.
 */
export async function takeSlot(deps: SlotDeps, key: string, rule: LimitRule, maxWaitMs: number, signal: AbortSignal): Promise<SlotRefusal | undefined> {
  const now = deps.clock();
  const delay = deps.limiters.gate(key, rule, now).at - now;
  if (delay > maxWaitMs) {
    return { afterMs: delay, code: 'LIMITED' };
  }
  if (delay > 0) {
    await deps.sleep(delay, signal);
    if (signal.aborted) {
      return { afterMs: 1_000, code: 'ABORTED' };
    }
  }
  await deps.limiters.consume(key, rule, deps.clock());
  return undefined;
}
