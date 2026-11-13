import { createHash } from 'node:crypto';
import type { Databases } from '../../../db/databases.ts';

/** Length of the default fixed rate limit window in seconds (a rule may ask for a longer one, such as a day). */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Seconds a counter outlives its window before the TTL index removes it. */
const RETENTION_AFTER_WINDOW_SECONDS = 60;

/** MongoDB duplicate key error code, raised when two upserts of the same counter race. */
const DUPLICATE_KEY = 11000;

/** Counter document of one window of one subject (collection `rateLimits` of the common database). */
interface RateLimitDocument {
  /** `<bucket>:<sha256 hex of the key>:<window start in seconds>`: the subject is never stored in clear. */
  _id: string;
  /** Requests counted in the window. */
  count: number;
  /** End of the window plus a margin; the TTL index removes the document at this instant. */
  expiresAt: Date;
}

/** Outcome of {@link RateLimiter.consume}. */
export interface RateLimitDecision {
  /** Whether the request is within the limit. */
  readonly allowed: boolean;
  /** The limit that was applied. */
  readonly limit: number;
  /** Requests still available in the window (never negative). */
  readonly remaining: number;
  /** Seconds until the window ends (at least 1). */
  readonly resetSeconds: number;
  /** True only for the first request over the limit of a window, so the event is reported once. */
  readonly firstExcess: boolean;
}

/** Counts requests per subject in fixed one-minute windows, shared by all server instances. */
export interface RateLimiter {
  /**
   * Counts one request and tells whether it is allowed.
   *
   * @param bucket Name of the rule, for example `login:username`.
   * @param key The subject (username, IP, user id); hashed before it reaches the database.
   * @param limit Requests allowed per window.
   * @param windowSeconds Length of the fixed window in seconds, {@link RATE_LIMIT_WINDOW_SECONDS} by default.
   * @returns The decision. A database failure rejects (callers fail closed).
   */
  consume(bucket: string, key: string, limit: number, windowSeconds?: number): Promise<RateLimitDecision>;
  /**
   * Reads the counter of the current window without changing it.
   *
   * @param bucket Name of the rule.
   * @param key The subject.
   * @param limit Requests allowed per window.
   * @param windowSeconds Length of the fixed window in seconds, {@link RATE_LIMIT_WINDOW_SECONDS} by default.
   * @returns The decision for the counter as it is: `allowed` is false when it has already reached the limit.
   */
  peek(bucket: string, key: string, limit: number, windowSeconds?: number): Promise<RateLimitDecision>;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;
}

/**
 * Creates the rate limiter over `common.rateLimits`. One atomic `findOneAndUpdate` (`$inc` plus
 * `$setOnInsert`, upsert) per request; a duplicate key error from two concurrent upserts of the
 * same new counter is retried once.
 *
 * @param databases Database accessor.
 * @param now Clock in epoch milliseconds (injected for tests).
 * @returns The limiter.
 */
export function createRateLimiter(databases: Databases, now: () => number = Date.now): RateLimiter {
  const window = (bucket: string, key: string, windowSeconds: number) => {
    const nowSeconds = Math.floor(now() / 1000);
    const windowStart = nowSeconds - (nowSeconds % windowSeconds);
    const windowEnd = windowStart + windowSeconds;
    return {
      id: `${bucket}:${createHash('sha256').update(key).digest('hex')}:${windowStart}`,
      windowEnd,
      resetSeconds: Math.max(1, windowEnd - nowSeconds),
    };
  };
  return {
    consume: async (bucket, key, limit, windowSeconds = RATE_LIMIT_WINDOW_SECONDS) => {
      const { id, windowEnd, resetSeconds } = window(bucket, key, windowSeconds);
      const filter = { _id: id };
      const update = {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date((windowEnd + RETENTION_AFTER_WINDOW_SECONDS) * 1000) },
      };
      const options = { upsert: true, returnDocument: 'after' } as const;
      const counters = databases.common().collection<RateLimitDocument>('rateLimits');
      let counter: RateLimitDocument | null;
      try {
        counter = await counters.findOneAndUpdate(filter, update, options);
      } catch (error) {
        if (!isDuplicateKey(error)) {
          throw error;
        }
        counter = await counters.findOneAndUpdate(filter, update, options);
      }
      if (counter === null) {
        throw new Error('Rate limit counter upsert returned no document');
      }
      return {
        allowed: counter.count <= limit,
        limit,
        remaining: Math.max(0, limit - counter.count),
        resetSeconds,
        firstExcess: counter.count === limit + 1,
      };
    },
    peek: async (bucket, key, limit, windowSeconds = RATE_LIMIT_WINDOW_SECONDS) => {
      const { id, resetSeconds } = window(bucket, key, windowSeconds);
      const counter = await databases.common().collection<RateLimitDocument>('rateLimits').findOne({ _id: id }, { projection: { count: 1 } });
      const count = counter?.count ?? 0;
      return { allowed: count < limit, limit, remaining: Math.max(0, limit - count), resetSeconds, firstExcess: false };
    },
  };
}
