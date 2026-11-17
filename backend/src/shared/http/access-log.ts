import type { RequestHandler } from 'express';
import type { Logger } from '../logging/logger.ts';

/**
 * Paths whose last segment is business data (the VAT number of a company looked up on Cerved): the log keeps the route, never the value, whatever the outcome
 * of the request (a rejected one included). Anything after the prefix is hidden, so a malformed path leaks nothing either.
 */
const MASKED_PATHS: ReadonlyArray<readonly [RegExp, string]> = [[/^(\/v1\/vat-lookups\/).*$/is, '$1:vatNumber']];

/** What is logged for a request-target that cannot be parsed: nothing of it, since it could hide a masked path. */
const UNPARSEABLE_PATH = '/:unparseable';

/**
 * The path as it goes in the log: the pathname of the request-target (so the absolute form `GET http://host/v1/...` and dot segments are reduced to the path the router
 * sees), with the masked paths replaced. A target that cannot be parsed is not logged at all.
 */
function loggablePath(target: string): string {
  let pathname: string;
  try {
    pathname = new URL(target, 'http://local').pathname;
  } catch {
    // Not an empty catch: the value is replaced by a fixed one (the raw target could contain what the masks hide).
    return UNPARSEABLE_PATH;
  }
  return MASKED_PATHS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), pathname);
}

/**
 * Creates the access log middleware: exactly one `info` line per request with
 * request id, method, path (query string stripped, the VAT number of a Cerved lookup replaced by its route parameter), status, duration and client
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
      const path = loggablePath(req.originalUrl);
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
