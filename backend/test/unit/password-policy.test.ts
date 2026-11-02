import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPasswordPolicy } from '../../src/shared/security/password-policy.ts';

const ctx = { username: 'mario.rossi' };

describe('checkPasswordPolicy', () => {
  it('enforces 12..128 code points', () => {
    assert.deepEqual(checkPasswordPolicy('a'.repeat(11), ctx), { ok: false, issues: ['tooShort'] });
    assert.deepEqual(checkPasswordPolicy('a'.repeat(12), ctx), { ok: true });
    assert.deepEqual(checkPasswordPolicy('a'.repeat(128), ctx), { ok: true });
    assert.deepEqual(checkPasswordPolicy('a'.repeat(129), ctx), { ok: false, issues: ['tooLong'] });
    assert.deepEqual(checkPasswordPolicy('', ctx), { ok: false, issues: ['tooShort'] });
  });

  it('counts code points, not UTF-16 units, after NFC', () => {
    assert.deepEqual(checkPasswordPolicy('\u{1F600}'.repeat(12), ctx), { ok: true });
    assert.deepEqual(checkPasswordPolicy('\u{1F600}'.repeat(11), ctx), { ok: false, issues: ['tooShort'] });
    assert.deepEqual(checkPasswordPolicy('\u{1F600}'.repeat(128), ctx), { ok: true });
    assert.deepEqual(checkPasswordPolicy('\u{1F600}'.repeat(129), ctx), { ok: false, issues: ['tooLong'] });
    // 11 characters in NFC, 12 code points in NFD.
    assert.deepEqual(checkPasswordPolicy('é'.repeat(1) + 'a'.repeat(10), ctx), { ok: false, issues: ['tooShort'] });
  });

  it('has no rule on character classes', () => {
    assert.deepEqual(checkPasswordPolicy('aaaaaaaaaaaa', ctx), { ok: true });
    assert.deepEqual(checkPasswordPolicy('            x', ctx), { ok: true });
  });

  it('rejects the username, case-insensitively and trimmed', () => {
    const long = { username: 'administrator' };
    assert.deepEqual(checkPasswordPolicy('administrator', long), { ok: false, issues: ['sameAsUsername'] });
    assert.deepEqual(checkPasswordPolicy('ADMINISTRATOR', long), { ok: false, issues: ['sameAsUsername'] });
    assert.deepEqual(checkPasswordPolicy('  Administrator ', long), { ok: false, issues: ['sameAsUsername'] });
    assert.deepEqual(checkPasswordPolicy('administrator', { username: '  Administrator  ' }), { ok: false, issues: ['sameAsUsername'] });
    assert.deepEqual(checkPasswordPolicy('administrator1', long), { ok: true });
  });

  it('reports several issues together', () => {
    assert.deepEqual(checkPasswordPolicy('abc', { username: 'ABC' }), { ok: false, issues: ['tooShort', 'sameAsUsername'] });
  });

  it('rejects lone surrogates', () => {
    assert.deepEqual(checkPasswordPolicy('a'.repeat(12) + '\ud800', ctx), { ok: false, issues: ['invalidCharacters'] });
    assert.deepEqual(checkPasswordPolicy('\udc00', ctx), { ok: false, issues: ['tooShort', 'invalidCharacters'] });
  });
});
