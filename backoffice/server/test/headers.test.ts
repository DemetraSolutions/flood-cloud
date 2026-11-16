import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCsp, buildPreviewHeaders, buildSecurityHeaders, PREVIEW_CSP, PREVIEW_PATHS } from '../headers.ts';
import { mimeType } from '../mime.ts';

test('CSP is strict and never uses unsafe-inline', () => {
  const csp = buildCsp('https://api.example.com');
  assert.match(csp, /^default-src 'none'; script-src 'self'; style-src 'self'; /);
  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.com;/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /require-trusted-types-for 'script'; trusted-types angular angular#bundler/);
});

test('CSP adds the nonce to style-src only', () => {
  const csp = buildCsp('https://api.example.com', 'abc');
  assert.match(csp, /style-src 'self' 'nonce-abc';/);
  assert.match(csp, /script-src 'self';/);
});

test('security headers include the mandatory set', () => {
  const headers = buildSecurityHeaders('https://api.example.com');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['strict-transport-security'], 'max-age=63072000; includeSubDomains');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(headers['permissions-policy'] as string, /camera=\(\)/);
});

test('mime table maps known extensions and falls back', () => {
  assert.equal(mimeType('a.JS'), 'text/javascript; charset=utf-8');
  assert.equal(mimeType('a.woff2'), 'font/woff2');
  assert.equal(mimeType('a.bin'), 'application/octet-stream');
  assert.equal(mimeType('noext'), 'application/octet-stream');
});

test('the application CSP allows frames of its own origin only, for the preview', () => {
  assert.match(buildCsp('https://api.example.com'), /frame-src 'self';/);
});

test('the preview files have their own policy, and nothing else changes', () => {
  assert.deepEqual([...PREVIEW_PATHS].sort(), ['/email-preview.html', '/email-preview.js']);
  assert.equal(
    PREVIEW_CSP,
    "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  );
  const headers = buildPreviewHeaders('https://api.example.com');
  const strict = buildSecurityHeaders('https://api.example.com');
  assert.equal(headers['content-security-policy'], PREVIEW_CSP);
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin');
  assert.equal(headers['strict-transport-security'], strict['strict-transport-security']);
  assert.notEqual(strict['content-security-policy'], PREVIEW_CSP);
  assert.equal(strict['x-frame-options'], 'DENY');
  assert.doesNotMatch(strict['content-security-policy'] as string, /unsafe-inline|https:(?!\/)/);
});
