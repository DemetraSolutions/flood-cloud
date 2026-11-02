import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomBytes, scryptSync } from 'node:crypto';
import {
  SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  verifyDummyPassword,
  verifyPassword,
  warmUpDummyHash,
} from '../../src/shared/security/scrypt.ts';

/** Builds a stored hash with arbitrary (cheap) parameters. */
function build(N: number, r: number, p: number, saltBytes = 16, keyBytes = 32): string {
  const salt = randomBytes(saltBytes);
  const key = scryptSync('pw', salt, keyBytes, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

describe('scrypt passwords', () => {
  afterEach(() => mock.restoreAll());

  it('uses the OWASP parameters', () => {
    assert.deepEqual({ ...SCRYPT_PARAMS }, { N: 65536, r: 8, p: 2 });
  });

  it('round-trips, with the documented format and a fresh salt each time', async () => {
    const started = Date.now();
    const first = await hashPassword('correct horse battery');
    const elapsed = Date.now() - started;
    const second = await hashPassword('correct horse battery');
    console.log(`scrypt hashPassword took ${elapsed} ms`);
    assert.match(first, /^scrypt\$65536\$8\$2\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
    assert.equal(await verifyPassword('correct horse battery', first), true);
    assert.equal(await verifyPassword('correct horse batterz', first), false);
    assert.equal(needsRehash(first), false);
  });

  it('normalizes to NFC before hashing and verifying', async () => {
    const stored = await hashPassword('café café café');
    assert.equal(await verifyPassword('café café café', stored), true);
  });

  it('verifies a record with valid older parameters and flags it for rehash', async () => {
    const old = build(1024, 8, 1);
    assert.equal(await verifyPassword('pw', old), true);
    assert.equal(await verifyPassword('other', old), false);
    assert.equal(needsRehash(old), true);
    assert.equal(needsRehash(build(65536, 8, 2, 8)), true);
    assert.equal(needsRehash(build(65536, 8, 2, 16, 64)), true);
    assert.equal(needsRehash(build(65536, 8, 1)), true);
    assert.equal(needsRehash(build(65536, 4, 2)), true);
  });

  it('rejects malformed or tampered records quickly, without throwing', async () => {
    const good = build(1024, 8, 1);
    const [, , , , salt, key] = good.split('$') as string[];
    const bad: unknown[] = [
      '',
      'bcrypt$10$abc',
      'scrypt$1024$8$1$salt',
      `${good}$extra`,
      `scrypt$1024$8$1$${salt}`,
      `scrypt$1024$8$1$$${key}`,
      `scrypt$1024$8$1$${salt}$`,
      `scrypt$1$8$1$${salt}$${key}`,
      `scrypt$1000$8$1$${salt}$${key}`,
      `scrypt$0$8$1$${salt}$${key}`,
      `scrypt$-1024$8$1$${salt}$${key}`,
      `scrypt$1024$0$1$${salt}$${key}`,
      `scrypt$1024$8$0$${salt}$${key}`,
      `scrypt$1024$8$1.5$${salt}$${key}`,
      `scrypt$1024$8$01$${salt}$${key}`,
      `scrypt$2097152$8$1$${salt}$${key}`,
      `scrypt$65536$1$1$${salt}$${key}`,
      `scrypt$65536$2$1$${salt}$${key}`,
      `scrypt$262144$8$1$${salt}$${key}`,
      `scrypt$32768$16$16$${salt}$${key}`,
      `scrypt$65536$8$16$${salt}$${key}`,
      `scrypt$1048576$8$1$${salt}$${key}`,
      `scrypt$1024$33$1$${salt}$${key}`,
      `scrypt$1024$8$17$${salt}$${key}`,
      `scrypt$99999999999999999999$8$1$${salt}$${key}`,
      `scrypt$1024$8$1$@@@$${key}`,
      `scrypt$1024$8$1$${salt}$!!!`,
      `scrypt$1024$8$1$${randomBytes(4).toString('base64url')}$${key}`,
      `scrypt$1024$8$1$${randomBytes(65).toString('base64url')}$${key}`,
      `scrypt$1024$8$1$${salt}$${randomBytes(8).toString('base64url')}`,
      `scrypt$1024$8$1$${salt}$${randomBytes(65).toString('base64url')}`,
      `scrypt$1024$8$1$${salt}$${key}=`,
      null,
      undefined,
      42,
    ];
    await verifyDummyPassword('warm');
    const spy = mock.method(crypto, 'scrypt');
    for (const record of bad) {
      spy.mock.resetCalls();
      assert.equal(await verifyPassword('pw', record as string), false, String(record));
      // Exactly one fake scrypt with the current parameters, never the tampered ones.
      assert.equal(spy.mock.callCount(), 1, String(record));
      assert.equal((spy.mock.calls[0]?.arguments[3] as { N: number }).N, 65536);
      assert.equal(needsRehash(record as string), true);
    }
  });

  it('absorbs only ERR_CRYPTO_INVALID_SCRYPT_PARAMS from scrypt', async () => {
    await verifyDummyPassword('warm');
    const stored = build(1024, 8, 1);
    const original = crypto.scrypt;
    let failWith: (Error & { code?: string }) | undefined;
    mock.method(crypto, 'scrypt', (...args: unknown[]) => {
      const callback = args[4] as (error: Error | null, key?: Buffer) => void;
      if (failWith !== undefined && (args[3] as { N: number }).N === 1024) {
        callback(failWith);
        return;
      }
      (original as (...a: unknown[]) => void)(...args);
    });
    failWith = Object.assign(new Error('bad params'), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' });
    assert.equal(await verifyPassword('pw', stored), false);
    failWith = Object.assign(new Error('boom'), { code: 'ERR_OTHER' });
    await assert.rejects(verifyPassword('pw', stored), /boom/);
    failWith = undefined;
    assert.equal(await verifyPassword('pw', stored), true);
  });

  it('warms up the fake hash once and runs a current-parameter scrypt per dummy verification', async () => {
    await warmUpDummyHash();
    await warmUpDummyHash();
    const spy = mock.method(crypto, 'scrypt');
    assert.equal(await verifyDummyPassword('anything'), false);
    assert.equal(spy.mock.callCount(), 1);
  });
});
