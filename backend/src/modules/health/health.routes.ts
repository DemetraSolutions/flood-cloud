import type { Logger } from '../../shared/logging/logger.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { defineRoute } from '../../shared/http/routes.ts';
import type { RouteDefinition } from '../../shared/http/routes.ts';

/** Maximum time a single readiness check may take, in milliseconds. */
export const READINESS_CHECK_TIMEOUT_MS = 2000;

/** What the readiness probe depends on. */
export interface Readiness {
  /** True once a graceful shutdown has started. */
  isShuttingDown(): boolean;
  /** Dependency checks; each must resolve when healthy and reject otherwise. */
  readonly checks: ReadonlyArray<() => Promise<void>>;
}

async function runWithTimeout(check: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the health routes, relative to the `/health` mount point.
 * `GET /live` always answers 200 while the process runs. `GET /ready` answers 200
 * only if the server is not shutting down and every check succeeds within the
 * timeout; otherwise 503 `SERVICE_UNAVAILABLE` without details (the reason goes
 * to the `warn` log).
 *
 * @param readiness Shutdown flag and dependency checks.
 * @param logger Logger for readiness failures.
 * @param checkTimeoutMs Per-check timeout, {@link READINESS_CHECK_TIMEOUT_MS} by default.
 * @returns Route declarations, both explicitly anonymous.
 */
export function createHealthRoutes(
  readiness: Readiness,
  logger: Logger,
  checkTimeoutMs: number = READINESS_CHECK_TIMEOUT_MS,
): RouteDefinition[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/live',
      auth: { kind: 'anonymous', reason: 'liveness probe called by the orchestrator' },
      handler: (_req, res) => {
        sendData(res, { status: 'ok' });
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/ready',
      auth: { kind: 'anonymous', reason: 'readiness probe called by the orchestrator' },
      handler: async (_req, res) => {
        if (readiness.isShuttingDown()) {
          logger.warn('not ready: shutting down');
          throw new AppError('SERVICE_UNAVAILABLE');
        }
        const results = await Promise.allSettled(readiness.checks.map((check) => runWithTimeout(check, checkTimeoutMs)));
        const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown);
        if (failures.length > 0) {
          logger.warn('not ready: dependency check failed', { failures });
          throw new AppError('SERVICE_UNAVAILABLE');
        }
        sendData(res, { status: 'ok' });
      },
    }),
  ];
}
