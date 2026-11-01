/**
 * Security headers attached to every response of the static server.
 * @module
 */

/** Placeholder that `index.html` may contain where a CSP nonce is needed. */
export const NONCE_PLACEHOLDER = '__CSP_NONCE__';

/**
 * Builds the Content-Security-Policy value.
 *
 * Styles are limited to same-origin files; when a nonce is given it is added
 * to `style-src` so Angular can insert component styles (`ngCspNonce`).
 * `unsafe-inline` is never used.
 *
 * @param apiOrigin Origin of the API, allowed in `connect-src`.
 * @param styleNonce Optional per-request nonce for inline styles.
 * @returns The policy string.
 */
export function buildCsp(apiOrigin: string, styleNonce?: string): string {
  const styleSrc = styleNonce === undefined ? "'self'" : `'self' 'nonce-${styleNonce}'`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src ${styleSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types angular angular#bundler',
  ].join('; ');
}

/**
 * Builds the security headers sent on every response.
 *
 * @param apiOrigin Origin of the API, allowed in the CSP.
 * @param styleNonce Optional per-request nonce for inline styles.
 * @returns A header map (lower-case names).
 */
export function buildSecurityHeaders(apiOrigin: string, styleNonce?: string): Record<string, string> {
  return {
    'content-security-policy': buildCsp(apiOrigin, styleNonce),
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  };
}
