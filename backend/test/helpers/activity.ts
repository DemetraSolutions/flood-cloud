import type { ErrorActivityReporter } from '../../src/shared/http/error-activity.ts';
import type { MountOptions } from '../../src/shared/http/routes.ts';
import type { RateLimitRule } from '../../src/shared/security/rate-limit/rate-limit.ts';
import { createRateLimitRules } from '../../src/shared/security/rate-limit/rules.ts';
import { testConfig } from './app.ts';
import type { ActivityEntry, ActivityLog } from '../../src/shared/activity-log/activity-log.ts';
import type { RateLimitDecision, RateLimiter } from '../../src/shared/security/rate-limit/rate-limiter.ts';

/** In-memory activity log: the entries accepted by `record` are in `entries`. */
export interface MemoryActivityLog extends ActivityLog {
  readonly entries: ActivityEntry[];
}

/** An activity log that keeps entries in memory, for tests that do not need MongoDB. */
export function memoryActivityLog(): MemoryActivityLog {
  const entries: ActivityEntry[] = [];
  return {
    entries,
    record: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
}

/**
 * In-memory fixed-window limiter with the semantics of the real one (a single window that never
 * ends unless `reset` is called), for tests that do not need MongoDB.
 */
export interface MemoryRateLimiter extends RateLimiter {
  /** Every call, in order. */
  readonly calls: Array<{ bucket: string; key: string; limit: number }>;
  /** Every read-only check, in order. */
  readonly peeks: Array<{ bucket: string; key: string; limit: number }>;
  /** Forgets all counters. */
  reset(): void;
}

/** Creates a {@link MemoryRateLimiter}. */
export function memoryRateLimiter(): MemoryRateLimiter {
  const counters = new Map<string, number>();
  const calls: MemoryRateLimiter['calls'] = [];
  const peeks: MemoryRateLimiter['calls'] = [];
  return {
    calls,
    reset: () => counters.clear(),
    peek: (bucket, key, limit) => {
      peeks.push({ bucket, key, limit });
      const count = counters.get(`${bucket}:${key}`) ?? 0;
      return Promise.resolve({ allowed: count < limit, limit, remaining: Math.max(0, limit - count), resetSeconds: 30, firstExcess: false });
    },
    peeks,
    consume: (bucket, key, limit, _windowSeconds, amount = 1) => {
      calls.push({ bucket, key, limit });
      const id = `${bucket}:${key}`;
      const count = (counters.get(id) ?? 0) + amount;
      counters.set(id, count);
      const decision: RateLimitDecision = { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetSeconds: 30, firstExcess: count > limit && count - amount <= limit };
      return Promise.resolve(decision);
    },
  };
}

/** Error reporter that remembers what the error handler reported. */
export function recordingErrorReporter(): { reporter: ErrorActivityReporter; reported: unknown[] } {
  const reported: unknown[] = [];
  return { reporter: { report: (error) => void reported.push(error) }, reported };
}

/** `rateLimit` option of `mountRoutes` backed by an in-memory limiter and the default thresholds. */
export function memoryRateLimitMount(limiter: RateLimiter = memoryRateLimiter()): NonNullable<MountOptions['rateLimit']> {
  const rules = createRateLimitRules(testConfig());
  return { limiter, apiRule: rules.apiPerUser, authFailureRule: rules.unauthenticatedPerIp, apiKeyAuthFailureRule: rules.unauthenticatedPublicPerIp, onExceeded: () => undefined };
}

/** A generous rate limit rule for test routes that are anonymous but not about rate limiting. */
export const testIpRule: RateLimitRule = { bucket: 'test:ip', limit: 1_000_000, key: (req) => req.ip ?? 'unknown' };
/** `rateLimit` declaration of such a test route. */
export const testIpLimit: readonly RateLimitRule[] = [testIpRule];
