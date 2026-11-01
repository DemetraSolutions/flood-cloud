import type { RequestHandler } from 'express';

/** Security headers sent on every response (`doc/Security-Model.md` §10). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/**
 * Creates the middleware that sets {@link SECURITY_HEADERS} on every response,
 * error responses included (it runs before any route).
 *
 * @returns Express middleware.
 */
export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  };
}
