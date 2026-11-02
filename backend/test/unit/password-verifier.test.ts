import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomBytes, scryptSync } from 'node:crypto';
import { legacyHashFingerprint, legacyPasswordHash } from '../../src/shared/security/legacy-password.ts';
import { verifyDummyPassword, verifyUserPassword, warmUpPasswordVerifier } from '../../src/shared/security/password-verifier.ts';
import { buildPasswordChange } from '../../src/shared/security/password-change.ts';
import { hashPassword, needsRehash, verifyPassword } from '../../src/shared/security/scrypt.ts';
import { Secret } from '../../src/shared/security/secret.ts';

const pepper = new Secret('verifier-test-pepper');
const PASSWORD = 'legacy-pass';
const legacy = legacyPasswordHash(PASSWORD, pepper);
const fingerprint = legacyHashFingerprint(legacy);

function oldScrypt(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
  return ['scrypt', 1024, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

describe('verifyUserPassword', () => {
  afterEach(() => mock.restoreAll());

  it('uses scrypt when the fingerprint matches, with no update', async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const result = await verifyUserPassword({
      password: PASSWORD,
      legacyHash: legacy,
      credentials: { passwordHash, legacyHashFingerprint: fingerprint },
      pepper,
    });
    assert.deepEqual(result, { ok: true, credentialsUpdate: null });
    const wrong = await verifyUserPassword({
      password: 'nope',
      legacyHash: legacy,
      credentials: { passwordHash, legacyHashFingerprint: fingerprint },
      pepper,
    });
    assert.deepEqual(wrong, { ok: false });
  });

  it('rehashes outdated scrypt parameters keeping the fingerprint, without the password in the update', async () => {
    const result = await verifyUserPassword({
      password: PASSWORD,
      legacyHash: legacy,
      credentials: { passwordHash: oldScrypt(PASSWORD), legacyHashFingerprint: fingerprint },
      pepper,
    });
    assert.ok(result.ok && result.credentialsUpdate !== null);
    assert.equal(result.credentialsUpdate.legacyHashFingerprint, fingerprint);
    assert.equal(needsRehash(result.credentialsUpdate.passwordHash), false);
    assert.equal(await verifyPassword(PASSWORD, result.credentialsUpdate.passwordHash), true);
    assert.ok(!JSON.stringify(result).includes(PASSWORD));
  });

  it('does not fall back to the legacy hash when scrypt applies and fails', async () => {
    const passwordHash = await hashPassword('a-different-password');
    const result = await verifyUserPassword({
      password: PASSWORD,
      legacyHash: legacy,
      credentials: { passwordHash, legacyHashFingerprint: fingerprint },
      pepper,
    });
    assert.deepEqual(result, { ok: false });
  });

  it('uses scrypt when both legacy hash and fingerprint are absent', async () => {
    const passwordHash = await hashPassword(PASSWORD);
    const result = await verifyUserPassword({
      password: PASSWORD,
      legacyHash: null,
      credentials: { passwordHash, legacyHashFingerprint: null },
      pepper,
    });
    assert.deepEqual(result, { ok: true, credentialsUpdate: null });
  });

  it('migrates a legacy-only user: verifies and returns scrypt plus the fingerprint', async () => {
    const result = await verifyUserPassword({ password: PASSWORD, legacyHash: legacy, credentials: null, pepper });
    assert.ok(result.ok && result.credentialsUpdate !== null);
    assert.equal(result.credentialsUpdate.legacyHashFingerprint, fingerprint);
    assert.equal(await verifyPassword(PASSWORD, result.credentialsUpdate.passwordHash), true);
    assert.ok(!JSON.stringify(result).includes(PASSWORD));
    assert.deepEqual(await verifyUserPassword({ password: 'bad', legacyHash: legacy, credentials: null, pepper }), { ok: false });
  });

  it('follows a password changed by the legacy system (fingerprint differs)', async () => {
    const staleScrypt = await hashPassword('old-password-before');
    const newLegacy = legacyPasswordHash('changed-in-legacy', pepper);
    const credentials = { passwordHash: staleScrypt, legacyHashFingerprint: fingerprint };
    const ok = await verifyUserPassword({ password: 'changed-in-legacy', legacyHash: newLegacy, credentials, pepper });
    assert.ok(ok.ok && ok.credentialsUpdate !== null);
    assert.equal(ok.credentialsUpdate.legacyHashFingerprint, legacyHashFingerprint(newLegacy));
    assert.equal(await verifyPassword('changed-in-legacy', ok.credentialsUpdate.passwordHash), true);
    // The old scrypt password no longer works once the legacy changed it.
    const stale = await verifyUserPassword({ password: 'old-password-before', legacyHash: newLegacy, credentials, pepper });
    assert.deepEqual(stale, { ok: false });
  });

  it('fails without a usable hash', async () => {
    assert.deepEqual(await verifyUserPassword({ password: PASSWORD, legacyHash: null, credentials: null, pepper }), { ok: false });
    assert.deepEqual(await verifyUserPassword({ password: PASSWORD, legacyHash: 'not-a-hash', credentials: null, pepper }), { ok: false });
  });

  it('runs a scrypt on every failure branch that has no scrypt of its own', async () => {
    await warmUpPasswordVerifier();
    const spy = mock.method(crypto, 'scrypt');
    const cases = [
      { legacyHash: null, credentials: null },
      { legacyHash: 'not-a-hash', credentials: null },
      { legacyHash: legacy, credentials: null },
      { legacyHash: legacyPasswordHash('other', pepper), credentials: { passwordHash: await hashPassword('x-password-long'), legacyHashFingerprint: fingerprint } },
    ];
    for (const entry of cases) {
      spy.mock.resetCalls();
      assert.deepEqual(await verifyUserPassword({ password: 'wrong-password', pepper, ...entry }), { ok: false });
      assert.ok(spy.mock.callCount() >= 1, JSON.stringify(entry.legacyHash));
    }
  });

  it('runs a scrypt when stored scrypt credentials are malformed', async () => {
    const spy = mock.method(crypto, 'scrypt');
    const credentials = { passwordHash: 'garbage', legacyHashFingerprint: null };
    assert.deepEqual(await verifyUserPassword({ password: PASSWORD, legacyHash: legacy, credentials, pepper }), { ok: false });
    assert.equal(spy.mock.callCount(), 1);
  });

  it('with a null fingerprint only scrypt decides and the legacy hash is ignored', async () => {
    const passwordHash = await hashPassword('new-password-123');
    const credentials = { passwordHash, legacyHashFingerprint: null };
    assert.deepEqual(await verifyUserPassword({ password: 'new-password-123', legacyHash: legacy, credentials, pepper }), {
      ok: true,
      credentialsUpdate: null,
    });
    assert.deepEqual(await verifyUserPassword({ password: PASSWORD, legacyHash: legacy, credentials, pepper }), { ok: false });
    const rehash = await verifyUserPassword({
      password: PASSWORD,
      legacyHash: legacy,
      credentials: { passwordHash: oldScrypt(PASSWORD), legacyHashFingerprint: null },
      pepper,
    });
    assert.ok(rehash.ok && rehash.credentialsUpdate?.legacyHashFingerprint === null);
  });

  it('when the legacy hash is gone scrypt stays valid and the fingerprint is kept', async () => {
    const credentials = { passwordHash: oldScrypt(PASSWORD), legacyHashFingerprint: fingerprint };
    const result = await verifyUserPassword({ password: PASSWORD, legacyHash: null, credentials, pepper });
    assert.ok(result.ok && result.credentialsUpdate?.legacyHashFingerprint === fingerprint);
    assert.deepEqual(await verifyUserPassword({ password: 'wrong', legacyHash: null, credentials, pepper }), { ok: false });
  });

  it('after a password change with coexistence off the old legacy password no longer works', async () => {
    const change = await buildPasswordChange('brand-new-password', { username: 'user', pepper, legacyCoexistence: false });
    assert.ok(change.ok);
    const credentials = { passwordHash: change.passwordHash, legacyHashFingerprint: change.legacyHashFingerprint };
    const old = await verifyUserPassword({ password: PASSWORD, legacyHash: legacy, credentials, pepper });
    assert.deepEqual(old, { ok: false });
    const fresh = await verifyUserPassword({ password: 'brand-new-password', legacyHash: legacy, credentials, pepper });
    assert.deepEqual(fresh, { ok: true, credentialsUpdate: null });
  });
});

describe('verifyDummyPassword', () => {
  it('always returns false and reuses the cached fake hash', async () => {
    assert.equal(await verifyDummyPassword('anything'), false);
    assert.equal(await verifyDummyPassword('anything else'), false);
  });
});
