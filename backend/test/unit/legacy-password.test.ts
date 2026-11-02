import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { legacyHashFingerprint, legacyPasswordHash, verifyLegacyPassword } from '../../src/shared/security/legacy-password.ts';
import { Secret } from '../../src/shared/security/secret.ts';

const pepper = new Secret('test-pepper-not-real');
// HMAC-SHA512(key = "test-pepper-not-real", message = "Password123!"), computed independently once.
const KNOWN = createHmac('sha512', 'test-pepper-not-real').update('Password123!').digest('hex');

describe('legacy password hash', () => {
  it('is HMAC-SHA512 in lowercase hex, 128 characters', () => {
    const hash = legacyPasswordHash('Password123!', pepper);
    assert.match(hash, /^[0-9a-f]{128}$/);
    assert.equal(hash, KNOWN);
    assert.equal(
      hash,
      '05b02829ebfda1ee648e6a94452e3f553c2fbf9656a9e0cc7fa39445f4eddaa45c99d1977d049be2b21c4c993461aa071152fe61154c8ea704052c97fd779cb3',
    );
  });

  it('matches a literal vector for a non-ASCII password', () => {
    assert.equal(
      legacyPasswordHash('p\u00e4ssw\u00f6rd-\u65e5\u672c', pepper),
      '1d7e47e4584d3fe2c12574cb5fe69c75786a8f116d8259584e83d5217338a4f032640dee4dd5cbdc157ed971f5c4388970c9143a02c32dd1baa7ffc945f72988',
    );
  });

  it('matches the RFC 4231 style known vector shape (key and message as UTF-8)', () => {
    const rfc = legacyPasswordHash('what do ya want for nothing?', new Secret('Jefe'));
    assert.equal(
      rfc,
      '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737',
    );
  });

  it('does not normalize: NFD does not verify an NFC hash', () => {
    const nfc = 'café-über';
    const nfd = nfc.normalize('NFD');
    const hash = legacyPasswordHash(nfc, pepper);
    assert.equal(verifyLegacyPassword(nfc, hash, pepper), true);
    assert.equal(verifyLegacyPassword(nfd, hash, pepper), false);
    assert.equal(hash, createHmac('sha512', 'test-pepper-not-real').update(Buffer.from(nfc, 'utf8')).digest('hex'));
  });

  it('verifies, and rejects wrong passwords, other peppers and malformed hashes', () => {
    const hash = legacyPasswordHash('Password123!', pepper);
    assert.equal(verifyLegacyPassword('Password123!', hash, pepper), true);
    assert.equal(verifyLegacyPassword('password123!', hash, pepper), false);
    assert.equal(verifyLegacyPassword('Password123!', hash, new Secret('other-pepper')), false);
    for (const bad of ['', 'abc', hash.toUpperCase(), hash.slice(1), `${hash}0`, `${hash.slice(0, 127)}g`]) {
      assert.equal(verifyLegacyPassword('Password123!', bad, pepper), false);
    }
  });

  it('fingerprints with SHA-256 hex', () => {
    assert.equal(legacyHashFingerprint('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
