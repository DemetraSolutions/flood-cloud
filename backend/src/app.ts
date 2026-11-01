import express from 'express';
import type { Express } from 'express';
import type { Config } from './config.ts';
import { createHealthRoutes } from './modules/health/health.routes.ts';
import type { Readiness } from './modules/health/health.routes.ts';
import { accessLog } from './shared/http/access-log.ts';
import { compressionMiddleware } from './shared/http/compression.ts';
import { cors } from './shared/http/cors.ts';
import { errorHandler } from './shared/http/error-handler.ts';
import { AppError } from './shared/http/errors.ts';
import { requestId } from './shared/http/request-id.ts';
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
}

/**
 * Builds the Express application without opening ports or connections.
 * Pipeline: request id, access log, security headers, compression, health,
 * `/v1` (CORS), `/public/v1`, 404, central error handler.
 *
 * @param deps Configuration, logger, readiness and optional routes.
 * @returns The configured Express app, ready for `listen`.
 * @throws {Error} If a route definition is invalid.
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger, readiness } = deps;
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
  mountRoutes(health, createHealthRoutes(readiness, logger));
  app.use('/health', health);

  const v1 = express.Router();
  mountRoutes(v1, deps.routes?.v1 ?? []);
  app.use('/v1', cors(config.corsAllowedOrigins), v1);

  const publicApi = express.Router();
  mountRoutes(publicApi, deps.routes?.public ?? []);
  app.use('/public/v1', publicApi);

  app.use(() => {
    throw new AppError('NOT_FOUND');
  });
  app.use(errorHandler(logger));
  return app;
}
