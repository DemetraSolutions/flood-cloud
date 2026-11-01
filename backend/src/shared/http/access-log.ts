import type { RequestHandler } from 'express';
import type { Logger } from '../logging/logger.ts';

/**
 * Creates the access log middleware: exactly one `info` line per request with
 * request id, method, path (query string stripped), status, duration and client
 * ip. A request whose connection closed before the response finished is logged
 * once with `aborted: true`. A valid client `X-Request-Id` appears as
 * `clientRequestId`. Bodies, query strings and headers are never logged.
 * Successful health probes are skipped to keep the log readable.
 *
 * @param logger Logger receiving the events.
 * @returns Express middleware.
 */
export function accessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    let logged = false;
    const record = (aborted: boolean): void => {
      if (logged) {
        return;
      }
      logged = true;
      const path = req.originalUrl.replace(/\?.*$/s, '');
      if (!aborted && path.startsWith('/health/') && res.statusCode >= 200 && res.statusCode < 300) {
        return;
      }
      logger.info('request', {
        requestId: res.locals.requestId,
        ...(res.locals.clientRequestId === undefined ? {} : { clientRequestId: res.locals.clientRequestId }),
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        ip: req.ip,
        ...(aborted ? { aborted: true } : {}),
      });
    };
    res.on('finish', () => record(false));
    res.on('close', () => record(!res.writableFinished));
    next();
  };
}
