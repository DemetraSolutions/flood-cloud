import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../../http/errors.ts';
import type { RateLimiter } from './rate-limiter.ts';

/** A rate limit rule: which counter a request feeds and how many requests it may make per minute. */
export interface RateLimitRule {
  /** Name of the counter family, for example `login:ip`. Distinct rules must have distinct buckets. */
  readonly bucket: string;
  /** Requests allowed per window (from the configuration). */
  readonly limit: number;
  /**
   * The subject of the request. `null` means the rule does not apply to this request.
   *
   * @param req The request.
   * @param res The response, whose `locals` hold the authenticated principal.
   */
  readonly key: (req: Request, res: Response) => string | null;
  /** True when {@link key} reads the parsed body, so the route builder runs the rule after the body parser. */
  readonly needsBody?: boolean;
  /** True when {@link key} reads the verified group (`res.locals.groupAccess`): the route builder runs the rule after the group check and the permission check. Only for routes with `group: true`. */
  readonly needsGroup?: boolean;
  /** Length of the fixed window in seconds; one minute when absent. A day (86400) makes the rule a daily quota. */
  readonly windowSeconds?: number;
}

/** A request that went over a limit for the first time in its window. */
export interface RateLimitExceededEvent {
  readonly rule: RateLimitRule;
  readonly req: Request;
  readonly res: Response;
}

/** Called once per window, at the first excess; it must not throw. */
export type RateLimitExceededHandler = (event: RateLimitExceededEvent) => void | Promise<void>;

/** What the rate limit middleware needs from the application. */
export interface RateLimitDeps {
  readonly limiter: RateLimiter;
  readonly onExceeded: RateLimitExceededHandler;
}

/**
 * Builds the middleware that applies a rule. It sets `RateLimit-Limit`, `RateLimit-Remaining` and
 * `RateLimit-Reset` on every response it handles (when several rules apply to a request, the
 * headers describe the one with the fewest requests left) and answers `429 RATE_LIMITED` with
 * `Retry-After` over the limit. A database failure propagates: no request goes unchecked.
 *
 * @param rule The rule.
 * @param deps Limiter and exceeded callback.
 * @returns The handler.
 */
export function rateLimit(rule: RateLimitRule, deps: RateLimitDeps): RequestHandler {
  return async (req, res, next) => {
    const key = rule.key(req, res);
    if (key === null) {
      next();
      return;
    }
    const decision = await deps.limiter.consume(rule.bucket, key, rule.limit, rule.windowSeconds);
    const current = Number(res.getHeader('RateLimit-Remaining'));
    if (!(current <= decision.remaining)) {
      res.set({
        'RateLimit-Limit': String(decision.limit),
        'RateLimit-Remaining': String(decision.remaining),
        'RateLimit-Reset': String(decision.resetSeconds),
      });
    }
    if (!decision.allowed) {
      if (decision.firstExcess) {
        await deps.onExceeded({ rule, req, res });
      }
      throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(decision.resetSeconds) } });
    }
    next();
  };
}

/** What the route builder needs to rate limit a surface. */
export interface RateLimitMount extends RateLimitDeps {
  /** Applied after `authenticate` to every `user` route. */
  readonly apiRule: RateLimitRule;
  /** Counts failed authentications per IP; see {@link guardAuthentication}. */
  readonly authFailureRule: RateLimitRule;
  /** The same for the routes of the public surface: its own bucket, so what a client guesses there never locks an office out of `/v1`, and the other way round. */
  readonly apiKeyAuthFailureRule: RateLimitRule;
}

/**
 * Wraps an authentication middleware with the per-IP limit on failures. Before authenticating it
 * only reads the counter of the current window: at the limit the answer is `429 RATE_LIMITED`
 * with `Retry-After` and `authenticate` is not even called. When `authenticate` fails with a 401
 * the counter is incremented (and the first excess of a window is reported like any other rate limit excess); requests that authenticate successfully never touch it, so an office
 * behind one NAT address is not locked out by its own legitimate traffic. The middleware must
 * either call `next` or fail.
 *
 * @param authenticate The surface's authentication middleware.
 * @param mount Limiter and the failure rule.
 * @returns The guarded middleware.
 */
export function guardAuthentication(authenticate: RequestHandler, mount: RateLimitMount): RequestHandler {
  const { authFailureRule: rule, limiter } = mount;
  return async (req, res, next) => {
    const key = rule.key(req, res);
    if (key !== null) {
      const current = await limiter.peek(rule.bucket, key, rule.limit, rule.windowSeconds);
      if (!current.allowed) {
        throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(current.resetSeconds) } });
      }
    }
    let failure: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        const returned: unknown = authenticate(req, res, (error?: unknown) => (error === undefined ? resolve() : reject(error)));
        Promise.resolve(returned).catch(reject);
      });
    } catch (error) {
      failure = error;
    }
    if (failure === undefined) {
      next();
      return;
    }
    if (key !== null && failure instanceof AppError && failure.status === 401) {
      const decision = await limiter.consume(rule.bucket, key, rule.limit, rule.windowSeconds);
      if (decision.firstExcess) {
        await mount.onExceeded({ rule, req, res });
      }
    }
    throw failure;
  };
}
