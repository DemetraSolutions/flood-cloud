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
    // The e-mail preview frame (`PREVIEW_PATHS`) is the only frame the application opens.
    "frame-src 'self'",
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
 * The two files of the e-mail preview document (`public/email-preview.html` and its script), shown in a
 * sandboxed frame of the template page. They are the only paths with their own headers ({@link buildPreviewHeaders}).
 */
export const PREVIEW_PATHS: ReadonlySet<string> = new Set(['/email-preview.html', '/email-preview.js']);

/**
 * Content-Security-Policy of the preview document: the HTML of an e-mail is written in it, so nothing may
 * run but our one script (`'self'`), styles are inline, images come over HTTPS or `data:`, there is no
 * connection, frame, font or form, only the application may frame it, and the document is sandboxed (opaque origin, scripts allowed) by the policy itself.
 */
export const PREVIEW_CSP = [
  // An opaque origin whatever the context: even if someone opened the file as a page, or framed it without `sandbox`, it never has the origin of the application.
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  'img-src https: data:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * Builds the headers of the preview files: the usual set with the policy of {@link PREVIEW_CSP}, the page
 * framable by the application only (`SAMEORIGIN`), and `Cross-Origin-Resource-Policy: cross-origin` because
 * the frame is sandboxed without `allow-same-origin` (opaque origin) and must still load its script.
 *
 * @param apiOrigin Origin of the API.
 * @returns A header map (lower-case names).
 */
export function buildPreviewHeaders(apiOrigin: string): Record<string, string> {
  return {
    ...buildSecurityHeaders(apiOrigin),
    'content-security-policy': PREVIEW_CSP,
    'x-frame-options': 'SAMEORIGIN',
    'cross-origin-resource-policy': 'cross-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
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
