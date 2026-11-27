/**
 * Persistent limiters.
 *
 * One document per key in `einvoicingWorkerLimits` (common database): `ip:<provider>:<kind>` (limits per IP shared by
 * every account of a provider), `account:<hub>:<kind>` (limits and backoff of one account) and `seller:<hub>:<code>`
 * (cooldown of one seller, so the others keep flowing). The state lives in memory while the worker runs and is written
 * through on every change, so a restart never forgets a minimum interval, an hourly or yearly count or a backoff (the
 * legacy kept them in memory only and met every `429` again after a restart).
 *
 * Nothing here sleeps: {@link Limiters.gate} says **when** a key is next free and the caller decides whether to wait.
 *
 * Fencing: every document carries the lease `epoch` of the instance that wrote it, and a write only replaces a document
 * of the same or an older epoch (the filter has `epoch <= mine`; against a newer document the upsert collides on `_id`).
 * A deposed instance therefore cannot overwrite what the new holder wrote, and learns it from {@link FencedError}.
 * The lease check before each write was rejected: the epoch in the document is checked by the database in the same
 * atomic operation, so there is no window between check and write.
 *
 * @module
 */
import type { Collection } from 'mongodb';
import { MAX_TIME_MS } from '../db/timeouts.ts';
import { romeYear, startOfNextRomeYear } from '../time.ts';

/** Name of the collection (in the common database) that holds the limiter documents. */
export const LIMITS_COLLECTION = 'einvoicingWorkerLimits';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Thrown when a write is refused because a newer lease epoch owns the data: this instance is no longer the holder. */
export class FencedError extends Error {
  constructor(what: string) {
    super(`write fenced: ${what}`);
    this.name = 'FencedError';
  }
}

/** What a key allows. `null` means no limit of that kind. */
export interface LimitRule {
  /** Minimum time between two uses, in milliseconds. */
  readonly minIntervalMs: number;
  /** A random extra wait, uniform in `[0, jitterMs]`, added to the minimum interval. */
  readonly jitterMs: number;
  /** Uses in any sliding hour. */
  readonly maxPerHour: number | null;
  /** Uses in a calendar year (Europe/Rome). */
  readonly maxPerYear: number | null;
}

/** A rule that only cares about cooldowns and backoff. */
export const COOLDOWN_ONLY: LimitRule = { minIntervalMs: 0, jitterMs: 0, maxPerHour: null, maxPerYear: null };

/** The state of one key. Times are milliseconds since the epoch. */
interface State {
  /** Earliest next use (minimum interval plus jitter). */
  nextAt: number;
  /** End of a cooldown or backoff. */
  until: number;
  /** Retries suffered since the last success (index into the backoff steps). */
  step: number;
  /** Uses in the last hour (only tracked when a rule has an hourly cap). */
  recent: number[];
  /** Calendar year of {@link State.yearCount}. */
  year: number;
  /** Uses in {@link State.year} (only tracked when a rule has a yearly cap). */
  yearCount: number;
}

/** The persisted form of {@link State}. */
export interface LimiterDocument {
  readonly _id: string;
  readonly epoch: number;
  readonly nextAt: Date;
  readonly until: Date;
  readonly step: number;
  readonly recent: readonly Date[];
  readonly year: number;
  readonly yearCount: number;
  /** TTL (index on this field): absent while a yearly count must be kept. */
  readonly expireAt?: Date;
}

/** Why a key is not free. */
export type GateReason = 'free' | 'interval' | 'hour' | 'year' | 'cooldown';

/** When a key is next free. */
export interface Gate {
  /** The instant, never earlier than `now`. */
  readonly at: number;
  /** What holds it back (`free` when `at` is `now`). */
  readonly reason: GateReason;
}

/** The limiters of the worker. */
export interface Limiters {
  /**
   * Loads the persisted state when the lease epoch changed (and the first time). Call it at the start of every round.
   *
   * @param epoch The fencing epoch of the lease currently held.
   */
  attach(epoch: number): Promise<void>;
  /**
   * When a key is next free for a rule. Pure and synchronous: it reads the in-memory state.
   *
   * @param key Limiter key.
   * @param rule The rule to apply.
   * @param now Worker clock.
   * @returns The instant and the reason.
   */
  gate(key: string, rule: LimitRule, now: number): Gate;
  /**
   * Records a use (minimum interval with jitter, hourly and yearly counts) and persists it.
   *
   * @throws {FencedError} When a newer epoch owns the document.
   */
  consume(key: string, rule: LimitRule, now: number): Promise<void>;
  /**
   * Blocks a key until an instant (the longer of the new and the current end wins) and persists it.
   *
   * @throws {FencedError} When a newer epoch owns the document.
   */
  coolDown(key: string, until: number): Promise<void>;
  /**
   * Starts or deepens a stepped backoff: the n-th retry since the last success waits `steps[n]` (the last step repeats),
   * at least `atLeastMs`.
   *
   * @returns The wait in milliseconds.
   * @throws {FencedError} When a newer epoch owns the document.
   */
  backoff(key: string, steps: readonly number[], atLeastMs: number, now: number): Promise<number>;
  /**
   * Resets the backoff steps of a key (after a success); a no-op when it is not in backoff.
   *
   * @throws {FencedError} When a newer epoch owns the document.
   */
  resetBackoff(key: string): Promise<void>;
  /**
   * The keys with a given prefix that are blocked at `now`, without the prefix.
   *
   * @param prefix For example `seller:aruba:`.
   * @param now Worker clock.
   */
  blocked(prefix: string, now: number): string[];
  /** Forgets the in-memory entries that no longer matter (the database drops its own with the TTL index). */
  sweep(now: number): void;
}

/** Collaborators and settings of {@link createLimiters}. */
export interface LimiterOptions {
  readonly collection: Collection<LimiterDocument>;
  /** Random number in `[0, 1)` for the jitter (`Math.random` in production). */
  readonly random: () => number;
  /** Most documents loaded at an epoch change; more is an error rather than a silently partial state. */
  readonly loadLimit: number;
}

/**
 * Creates the TTL index that removes expired limiter documents.
 *
 * @param collection The limits collection.
 */
export async function ensureLimiterIndexes(collection: Collection<LimiterDocument>): Promise<void> {
  await collection.createIndex({ expireAt: 1 }, { name: 'expireAt_1', expireAfterSeconds: 0, maxTimeMS: MAX_TIME_MS });
}

const emptyState = (): State => ({ nextAt: 0, until: 0, step: 0, recent: [], year: 0, yearCount: 0 });

/** Whether a document is of no use any more: nothing is blocked and no yearly count must be kept. */
function expiryOf(state: State): number | undefined {
  if (state.yearCount > 0) {
    return undefined;
  }
  const last = state.recent.length === 0 ? 0 : (state.recent[state.recent.length - 1] as number) + HOUR_MS;
  return Math.max(state.nextAt, state.until, last) + DAY_MS;
}

/**
 * Creates the limiters.
 *
 * @param options Collection, random source and load limit.
 * @returns The limiters.
 */
export function createLimiters(options: LimiterOptions): Limiters {
  const { collection, random, loadLimit } = options;
  const states = new Map<string, State>();
  let loadedEpoch: number | null = null;
  let epoch = 0;

  const stateOf = (key: string): State => states.get(key) ?? emptyState();

  const persist = async (key: string, state: State): Promise<void> => {
    const expire = expiryOf(state);
    const doc: LimiterDocument = {
      _id: key,
      epoch,
      nextAt: new Date(state.nextAt),
      until: new Date(state.until),
      step: state.step,
      recent: state.recent.map((at) => new Date(at)),
      year: state.year,
      yearCount: state.yearCount,
      ...(expire === undefined ? {} : { expireAt: new Date(expire) }),
    };
    try {
      await collection.replaceOne({ _id: key, epoch: { $lte: epoch } }, doc, { upsert: true, maxTimeMS: MAX_TIME_MS });
    } catch (error) {
      if ((error as { code?: unknown }).code === 11000) {
        throw new FencedError(`limiter ${key.split(':', 2).join(':')}`);
      }
      throw error;
    }
    states.set(key, state);
  };

  return {
    async attach(current) {
      epoch = current;
      if (loadedEpoch === current) {
        return;
      }
      const loaded = await collection.find({}).limit(loadLimit + 1).maxTimeMS(MAX_TIME_MS).toArray();
      if (loaded.length > loadLimit) {
        throw new Error('too many limiter documents to load');
      }
      states.clear();
      for (const doc of loaded) {
        states.set(doc._id, {
          nextAt: doc.nextAt.getTime(),
          until: doc.until.getTime(),
          step: doc.step,
          recent: doc.recent.map((at) => at.getTime()),
          year: doc.year,
          yearCount: doc.yearCount,
        });
      }
      loadedEpoch = current;
    },

    gate(key, rule, now) {
      const state = stateOf(key);
      let gate: Gate = { at: now, reason: 'free' };
      const consider = (at: number, reason: GateReason): void => {
        if (at > gate.at) {
          gate = { at, reason };
        }
      };
      consider(state.until, 'cooldown');
      consider(state.nextAt, 'interval');
      const recent = state.recent.filter((at) => at > now - HOUR_MS);
      if (rule.maxPerHour !== null && recent.length >= rule.maxPerHour) {
        consider((recent[recent.length - rule.maxPerHour] as number) + HOUR_MS, 'hour');
      }
      if (rule.maxPerYear !== null && state.year === romeYear(now) && state.yearCount >= rule.maxPerYear) {
        consider(startOfNextRomeYear(now), 'year');
      }
      return gate;
    },

    async consume(key, rule, now) {
      const state = stateOf(key);
      const year = romeYear(now);
      await persist(key, {
        ...state,
        nextAt: now + rule.minIntervalMs + Math.floor(random() * (rule.jitterMs + 1)),
        recent: rule.maxPerHour === null ? [] : [...state.recent.filter((at) => at > now - HOUR_MS), now],
        year: rule.maxPerYear === null ? state.year : year,
        yearCount: rule.maxPerYear === null ? state.yearCount : (state.year === year ? state.yearCount : 0) + 1,
      });
    },

    async coolDown(key, until) {
      const state = stateOf(key);
      await persist(key, { ...state, until: Math.max(state.until, until) });
    },

    async backoff(key, steps, atLeastMs, now) {
      const state = stateOf(key);
      const delay = Math.max(steps[Math.min(state.step, steps.length - 1)] as number, atLeastMs);
      await persist(key, { ...state, step: state.step + 1, until: Math.max(state.until, now + delay) });
      return delay;
    },

    async resetBackoff(key) {
      const state = stateOf(key);
      if (state.step !== 0) {
        await persist(key, { ...state, step: 0 });
      }
    },

    blocked(prefix, now) {
      const keys: string[] = [];
      for (const [key, state] of states) {
        if (key.startsWith(prefix) && state.until > now) {
          keys.push(key.slice(prefix.length));
        }
      }
      return keys;
    },

    sweep(now) {
      for (const [key, state] of states) {
        const expire = expiryOf(state);
        if (expire !== undefined && expire < now) {
          states.delete(key);
        }
      }
    },
  };
}
