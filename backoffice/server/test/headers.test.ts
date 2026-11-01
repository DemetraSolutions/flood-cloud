import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCsp, buildSecurityHeaders } from '../headers.ts';
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
