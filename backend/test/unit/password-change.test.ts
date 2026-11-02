import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPasswordChange } from '../../src/shared/security/password-change.ts';
import { legacyHashFingerprint, legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { verifyPassword } from '../../src/shared/security/scrypt.ts';
import { Secret } from '../../src/shared/security/secret.ts';

const pepper = new Secret('change-test-pepper');
const PASSWORD = 'a-long-enough-password';

describe('buildPasswordChange', () => {
  it('rejects policy violations with the issues', async () => {
    assert.deepEqual(await buildPasswordChange('short', { username: 'user', pepper, legacyCoexistence: true }), {
      ok: false,
      issues: ['tooShort'],
    });
  });

  it('also writes the legacy hash during coexistence', async () => {
    const result = await buildPasswordChange(PASSWORD, { username: 'user', pepper, legacyCoexistence: true });
    assert.ok(result.ok);
    assert.equal(await verifyPassword(PASSWORD, result.passwordHash), true);
    assert.equal(result.legacyHash, legacyPasswordHash(PASSWORD, pepper));
    assert.equal(result.legacyHashFingerprint, legacyHashFingerprint(result.legacyHash as string));
  });

  it('skips the legacy hash when coexistence is off', async () => {
    const result = await buildPasswordChange(PASSWORD, { username: 'user', pepper, legacyCoexistence: false });
    assert.ok(result.ok);
    assert.equal(result.legacyHash, null);
    assert.equal(result.legacyHashFingerprint, null);
  });
});
