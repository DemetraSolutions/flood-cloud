import type { ObjectId } from 'mongodb';
import type { Logger } from '../../shared/logging/logger.ts';
import type { ApiKeysRepository } from './api-keys.repository.ts';
import type { UsageIncrement } from './api-keys.types.ts';

/** Most distinct rows (key, day and route) the meter keeps in memory before it writes them. */
export const DEFAULT_MAX_USAGE_ENTRIES = 5000;

/** Error codes of the database that no new attempt can cure: a row that violates the schema (121), has a value the database cannot take (2) or cannot be parsed (9). */
export const NON_TRANSIENT_WRITE_CODES: ReadonlySet<number | undefined> = new Set([121, 2, 9]);

/** How many times a row the database refuses is written again before it is dropped. */
export const MAX_ROW_ATTEMPTS = 5;

/** What the meter learns about a finished request of a key. */
export interface UsageEvent {
  readonly keyId: ObjectId;
  readonly groupId: ObjectId;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  /** `<METHOD> <route pattern>`. */
  readonly route: string;
  /** The status code of the response. */
  readonly status: number;
  /** `true` when the client closed the connection before the response was complete: the request is counted as a call and as aborted, whatever the status. */
  readonly aborted?: boolean;
}

/** Counts the requests of the public API keys in memory and writes them to the database in blocks. */
export interface UsageMeter {
  /**
   * Counts a finished request of a key: a call, plus an error (`4xx` other than `429`, `5xx`), a rate limit (`429`) or an aborted request. A row that is new when the meter already holds the maximum is not kept: it is counted as
   * dropped and logged at the next write. The row that makes the meter reach the maximum starts a write at once.
   *
   * @param event The request.
   */
  record(event: UsageEvent): void;
  /**
   * Writes what the meter holds. It never rejects: a write that fails is logged by the name of the error and its rows stay in memory for the next write (within the limit of the memory), so the response of
   * a request is never touched by it. Writes run one after the other.
   */
  flush(): Promise<void>;
  /** Starts the periodic write. */
  start(): void;
  /** Stops the periodic write and writes what is left: the shutdown calls it before the database is closed. */
  stop(): Promise<void>;
}

/** Collaborators of {@link createUsageMeter}. */
export interface UsageMeterDeps {
  readonly repository: Pick<ApiKeysRepository, 'addUsage'>;
  readonly logger: Logger;
  /** Milliseconds between two writes. */
  readonly flushIntervalMs: number;
  /** Most distinct rows kept in memory, {@link DEFAULT_MAX_USAGE_ENTRIES} by default. */
  readonly maxEntries?: number;
}

type Counts = { -readonly [K in 'calls' | 'errors4xx' | 'errors5xx' | 'rateLimited' | 'aborted']: number };

/** A row held by the meter, with the times the database refused it. */
type Entry = Pick<UsageIncrement, 'keyId' | 'groupId' | 'day' | 'route'> & Counts & { attempts: number };

const rowKey = (keyId: ObjectId, day: string, route: string): string => `${keyId.toHexString()}|${day}|${route}`;

function addCounts(target: Counts, source: Counts): void {
  target.calls += source.calls;
  target.errors4xx += source.errors4xx;
  target.errors5xx += source.errors5xx;
  target.rateLimited += source.rateLimited;
  target.aborted += source.aborted;
}

/**
 * Builds the usage meter of the public API (`doc/Security-Model.md` section 7): the counters of the requests are aggregated in memory by key, day (UTC), route pattern and outcome, and written with `$inc`
 * upserts every `flushIntervalMs`, when {@link DEFAULT_MAX_USAGE_ENTRIES} distinct rows are reached, and at shutdown. A request costs a map update, never a database write.
 *
 * @param deps Repository, logger, interval and optional cap.
 */
export function createUsageMeter(deps: UsageMeterDeps): UsageMeter {
  const { repository, logger, flushIntervalMs } = deps;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_USAGE_ENTRIES;
  let entries = new Map<string, Entry>();
  let dropped = 0;
  let timer: NodeJS.Timeout | undefined;
  let writes: Promise<void> = Promise.resolve();

  /** Puts a row back (after a write that failed) without going over the cap: a row that is new when the meter is full is dropped, and counted. */
  const keep = (row: Entry): void => {
    const held = entries.get(rowKey(row.keyId, row.day, row.route));
    if (held !== undefined) {
      addCounts(held, row);
      held.attempts = Math.max(held.attempts, row.attempts);
    } else if (entries.size < maxEntries) {
      entries.set(rowKey(row.keyId, row.day, row.route), row);
    } else {
      dropped += 1;
    }
  };

  const write = async (): Promise<void> => {
    if (dropped > 0) {
      logger.warn('public API usage rows dropped: the memory of the meter was full', { dropped });
      dropped = 0;
    }
    if (entries.size === 0) {
      return;
    }
    const batch = [...entries.values()];
    entries = new Map();
    try {
      const result = await repository.addUsage(batch);
      if (result.unacknowledged) {
        logger.error('the usage of the public API was written without the confirmation asked: it is not written again', { rows: batch.length });
      }
      if (result.failed.length > 0) {
        // The database refused some rows. One that no new attempt can cure is dropped at once, any other is tried again until it has been refused MAX_ROW_ATTEMPTS times.
        const held = new Map(batch.map((entry) => [rowKey(entry.keyId, entry.day, entry.route), entry]));
        let dropped = 0;
        for (const { row, code } of result.failed) {
          const entry = held.get(rowKey(row.keyId, row.day, row.route))!;
          entry.attempts += 1;
          if (NON_TRANSIENT_WRITE_CODES.has(code) || entry.attempts >= MAX_ROW_ATTEMPTS) {
            dropped += 1;
          } else {
            keep(entry);
          }
        }
        logger.error('the database refused rows of the usage of the public API', { rows: result.failed.length, dropped, codes: [...new Set(result.failed.map(({ code }) => code ?? null))] });
      }
    } catch (error) {
      logger.error('writing the usage of the public API failed', { errorName: error instanceof Error ? error.name : typeof error, rows: batch.length });
      batch.forEach(keep);
    }
  };

  const flush = (): Promise<void> => {
    writes = writes.then(write);
    return writes;
  };

  return {
    record: (event) => {
      const key = rowKey(event.keyId, event.day, event.route);
      let entry = entries.get(key);
      let full = false;
      if (entry === undefined) {
        if (entries.size >= maxEntries) {
          dropped += 1;
          return;
        }
        entry = { keyId: event.keyId, groupId: event.groupId, day: event.day, route: event.route, calls: 0, errors4xx: 0, errors5xx: 0, rateLimited: 0, aborted: 0, attempts: 0 };
        entries.set(key, entry);
        full = entries.size === maxEntries;
      }
      entry.calls += 1;
      if (event.aborted === true) {
        entry.aborted += 1;
      } else if (event.status === 429) {
        entry.rateLimited += 1;
      } else if (event.status >= 500) {
        entry.errors5xx += 1;
      } else if (event.status >= 400) {
        entry.errors4xx += 1;
      }
      if (full) {
        // The memory is full: write now, instead of waiting for the next tick (the write never rejects).
        void flush();
      }
    },
    flush,
    start: () => {
      timer = setInterval(() => void flush(), flushIntervalMs);
      timer.unref();
    },
    stop: async () => {
      clearInterval(timer);
      timer = undefined;
      await flush();
    },
  };
}
