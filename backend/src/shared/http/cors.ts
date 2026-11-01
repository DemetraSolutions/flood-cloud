import type { RequestHandler } from 'express';

/** Response headers a browser client may read. */
export const CORS_EXPOSED_HEADERS =
  'X-Request-Id, Location, ETag, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After';
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key, If-Match, If-None-Match, X-Request-Id';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * Creates the CORS middleware of the `/v1` surface. Only origins that match the
 * allowlist exactly receive CORS headers; any other request proceeds untouched
 * (and will simply be unreadable by the browser). Credentials are not enabled.
 * `Vary: Origin` is always set.
 *
 * @param allowedOrigins Exact origins allowed (scheme, host and port).
 * @returns Express middleware.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.get('origin');
    if (origin === undefined || !allowed.has(origin)) {
      next();
      return;
    }
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
    if (req.method === 'OPTIONS' && req.get('access-control-request-method') !== undefined) {
      res.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
      res.status(204).end();
      return;
    }
    next();
  };
}
