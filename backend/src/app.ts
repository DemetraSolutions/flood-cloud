import express from 'express';
import type { Express, RequestHandler } from 'express';
import type { Config } from './config.ts';
import { createHealthRoutes } from './modules/health/health.routes.ts';
import type { Readiness } from './modules/health/health.routes.ts';
import { accessLog } from './shared/http/access-log.ts';
import { compressionMiddleware } from './shared/http/compression.ts';
import { cors } from './shared/http/cors.ts';
import { errorHandler } from './shared/http/error-handler.ts';
import { AppError } from './shared/http/errors.ts';
import { requestId } from './shared/http/request-id.ts';
import { createCrossGroupAuditor } from './shared/activity-log/cross-group-audit.ts';
import type { ActivityLog } from './shared/activity-log/activity-log.ts';
import { createRateLimitAudit } from './shared/activity-log/rate-limit-audit.ts';
import { createErrorActivityReporter } from './shared/http/error-activity.ts';
import { createRateLimitRules } from './shared/security/rate-limit/rules.ts';
import type { RateLimiter } from './shared/security/rate-limit/rate-limiter.ts';
import type { GroupsRepository } from './shared/security/scope/groups.repository.ts';
import { mountRoutes } from './shared/http/routes.ts';
import type { RouteDefinition } from './shared/http/routes.ts';
import { securityHeaders } from './shared/http/security-headers.ts';
import type { Logger } from './shared/logging/logger.ts';

/** Everything {@link createApp} needs; all injected so the app has no side effects. */
export interface AppDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly readiness: Readiness;
  /**
   * Routes of each API surface. Domain modules register here; both lists are
   * empty until the first module exists. Every route is validated at startup.
   */
  readonly routes?: {
    /** Backoffice surface, mounted on `/v1` with CORS. */
    readonly v1?: readonly RouteDefinition[];
    /** Public surface, mounted on `/public/v1` without CORS. */
    readonly public?: readonly RouteDefinition[];
  };
  /**
   * Authentication middleware of each surface; it sets `res.locals.auth` or fails. A surface that
   * declares `user` routes without one cannot start (deny by default).
   */
  readonly authenticate?: {
    /** Backoffice sessions on `/v1`. */
    readonly v1?: RequestHandler;
  };
  /** Group lookup for the `/v1` routes declaring `group: true`; PSA and D accesses are audited by the app itself. */
  readonly groupAccess?: { readonly groups: GroupsRepository };
  /** The activity log: security events and server errors. */
  readonly activityLog: ActivityLog;
  /** The rate limit counters. */
  readonly rateLimiter: RateLimiter;
  /** Clock in epoch milliseconds (injected for tests); defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Builds the Express application without opening ports or connections.
 * Pipeline: request id, access log, security headers, compression, health,
 * `/v1` (CORS), `/public/v1`, 404, central error handler. Per route (see `mountRoutes`):
 * authentication, rate limit, group, permission, body parser. PSA and D accesses to a group,
 * first rate limit excesses and unexpected errors are written to the activity log.
 *
 * @param deps Configuration, logger, readiness, activity log, rate limiter and optional routes.
 * @returns The configured Express app, ready for `listen`.
 * @throws {Error} If a route definition is invalid.
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger, readiness, activityLog } = deps;
  const now = deps.now ?? Date.now;
  const rules = createRateLimitRules(config);
  const rateLimitMount = {
    limiter: deps.rateLimiter,
    apiRule: rules.apiPerUser,
    authFailureRule: rules.unauthenticatedPerIp,
    onExceeded: createRateLimitAudit(activityLog),
  };
  const app = express();
  // Never let Express render its development error page (stack traces).
  app.set('env', 'production');
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', config.trustProxy === 0 ? false : config.trustProxy);

  app.use(requestId());
  app.use(accessLog(logger));
  app.use(securityHeaders());
  app.use(compressionMiddleware());

  const health = express.Router();
  mountRoutes(health, createHealthRoutes(readiness, logger), { allowRateLimitExempt: true });
  app.use('/health', health);

  const v1 = express.Router();
  mountRoutes(v1, deps.routes?.v1 ?? [], {
    allowedAuth: ['anonymous', 'user'],
    ...(deps.authenticate?.v1 === undefined ? {} : { authenticate: deps.authenticate.v1 }),
    ...(deps.groupAccess === undefined
      ? {}
      : { groupAccess: { groups: deps.groupAccess.groups, onCrossGroupAccess: createCrossGroupAuditor({ activityLog, now }) } }),
    rateLimit: rateLimitMount,
  });
  app.use('/v1', cors(config.corsAllowedOrigins), v1);

  const publicApi = express.Router();
  mountRoutes(publicApi, deps.routes?.public ?? [], { rateLimit: rateLimitMount });
  app.use('/public/v1', publicApi);

  app.use(() => {
    throw new AppError('NOT_FOUND');
  });
  app.use(errorHandler(logger, createErrorActivityReporter({ activityLog, logger, now })));
  return app;
}
