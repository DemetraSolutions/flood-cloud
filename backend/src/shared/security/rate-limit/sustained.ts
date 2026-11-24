import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../../http/errors.ts';
import type { Role } from '../rbac/permissions.ts';
import type { RateLimitRule } from './rate-limit.ts';
import type { RateLimitDecision, RateLimiter } from './rate-limiter.ts';

/** The windows of the sustained use limit of a user on `/v1`. */
export type SustainedWindow = 'hour' | 'day';

/** What happens over the sustained limits: `report` lets the request pass and records an event, `enforce` refuses it. */
export type SustainedMode = 'report' | 'enforce';

/**
 * Roles that work on many groups and are therefore never refused by the sustained limits, whatever the mode: they are
 * only reported. They stay under the per-minute limit.
 */
export const SUSTAINED_EXEMPT_ROLES: readonly Role[] = Object.freeze(['PSA', 'D'] as const);

/** The first request over a sustained limit of a user in a window. */
export interface SustainedExceededEvent {
  /** The window that was exceeded. */
  readonly window: SustainedWindow;
  /** The rule of that window (its bucket and limit). */
  readonly rule: RateLimitRule;
  /** The mode that applied to this user: `report` also for PSA and D under `enforce`. */
  readonly mode: SustainedMode;
  readonly req: Request;
  readonly res: Response;
}

/** Called once per user and window, at the first excess; it must not throw. */
export type SustainedExceededHandler = (event: SustainedExceededEvent) => void | Promise<void>;

/** The sustained use limit of `/v1`: the two rules, the configured mode and the event callback. */
export interface SustainedRateLimit {
  readonly hour: RateLimitRule;
  readonly day: RateLimitRule;
  /** The mode in force, read at every request (the security policy in memory: what the PSA saved, else `RATE_LIMIT_API_SUSTAINED_MODE`). It never fails: a fault of the setting is `report`. */
  readonly mode: () => Promise<SustainedMode>;
  /** Records the first excess of a window. */
  readonly onExceeded: SustainedExceededHandler;
}

/**
 * Builds the middleware of the sustained use limit: one atomic counter per window (hour and day, both counted on every
 * request that reaches it, in parallel), keyed by the user id like every per-user rule. It runs after the per-minute
 * rule, so a request refused there is counted by neither window.
 *
 * - `report`: the request always passes, the first excess of each window records an event, headers are left as they are.
 * - `enforce`: over a limit the answer is `429 RATE_LIMITED` with `Retry-After` up to the end of the window (the later
 *   one when both are exceeded). The `RateLimit-*` headers describe the window with the fewest requests left, or, on
 *   the refusal, the exceeded window that ends last, merged with the per-minute headers like every other rule.
 * - PSA and D ({@link SUSTAINED_EXEMPT_ROLES}) are handled as in `report` whatever the mode, and so is every request to a route that is never refused (`neverRefuse`: logout, change of the own credentials).
 *
 * A request without an authenticated user is not counted. A database failure propagates (fail closed, like every rule).
 *
 * @param sustained The rules, mode and callback.
 * @param limiter The counters.
 * @param neverRefuse `true` for a route declared `sustainedExempt`: counted and reported, never refused.
 * @returns The handler.
 * @throws {AppError} `RATE_LIMITED` when enforced.
 */
export function sustainedRateLimit(sustained: SustainedRateLimit, limiter: RateLimiter, neverRefuse = false): RequestHandler {
  const { hour, day } = sustained;
  const windows = [
    { window: 'hour', rule: hour },
    { window: 'day', rule: day },
  ] as const;
  return async (req, res, next) => {
    const key = hour.key(req, res);
    if (key === null) {
      next();
      return;
    }
    const decisions: readonly RateLimitDecision[] = await Promise.all(windows.map(({ rule }) => limiter.consume(rule.bucket, key, rule.limit, rule.windowSeconds)));
    // The rules are keyed by the user id, so a key means an authenticated user.
    const exempt = SUSTAINED_EXEMPT_ROLES.includes(res.locals.auth!.role);
    const mode: SustainedMode = exempt || neverRefuse ? 'report' : await sustained.mode();
    for (const [index, { window, rule }] of windows.entries()) {
      if (decisions[index]!.firstExcess) {
        await sustained.onExceeded({ window, rule, mode, req, res });
      }
    }
    if (mode === 'report') {
      next();
      return;
    }
    const exceeded = decisions.filter((decision) => !decision.allowed);
    // Refused: the window that reopens last (the day ends with its last hour, so the last of the two); allowed: the one with the fewest requests left (the hour on a tie).
    const shown = exceeded.length > 0 ? exceeded[exceeded.length - 1]! : decisions.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    const current = Number(res.getHeader('RateLimit-Remaining'));
    if (exceeded.length > 0 || !(current <= shown.remaining)) {
      res.set({ 'RateLimit-Limit': String(shown.limit), 'RateLimit-Remaining': String(shown.remaining), 'RateLimit-Reset': String(shown.resetSeconds) });
    }
    if (exceeded.length > 0) {
      throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(shown.resetSeconds) } });
    }
    next();
  };
}
