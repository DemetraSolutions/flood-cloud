import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { PLATFORM_ARUBA_PASSWORD_CONTEXT, dealerArubaPasswordContext, encryptCredential } from '../../src/shared/security/credential-cipher.ts';
import type { CredentialRecipient, StoredCredential } from '../../src/shared/security/credential-cipher.ts';

/** A recipient key pair made here, never a stored key: the private half plays the worker. */
const pair = generateKeyPairSync('x25519');
const recipient: CredentialRecipient = { key: pair.publicKey, id: 'test-1' };

/** What the reader of the credential (the worker) does, with `node:crypto` alone. */
function decrypt(stored: StoredCredential, privateKey: KeyObject, context: string): string {
  const epkRaw = Buffer.from(stored.epk, 'base64url');
  const ephemeral = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: stored.epk }, format: 'jwk' });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const recipientRaw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x!, 'base64url');
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epkRaw, recipientRaw]), `flood-cloud:credential:v2:${context}`, 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(stored.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64url')), decipher.final()]).toString('utf8');
}

describe('the credential cipher', () => {
  it('names the contexts of the two kinds of account', () => {
    assert.equal(dealerArubaPasswordContext('0123456789abcdef01234567'), 'einvoicing:aruba:dealer:0123456789abcdef01234567:password');
    assert.equal(PLATFORM_ARUBA_PASSWORD_CONTEXT, 'einvoicing:aruba:platform:password');
  });

  it('stores version 2, the key id and base64url fields of the right size, and decrypts back with the private key', () => {
    const password = 'pässword with spaces & 日本語';
    const stored = encryptCredential(recipient, password, PLATFORM_ARUBA_PASSWORD_CONTEXT);
    assert.deepEqual(Object.keys(stored).sort(), ['data', 'epk', 'iv', 'kid', 'tag', 'v']);
    assert.equal(stored.v, 2);
    assert.equal(stored.kid, 'test-1');
    assert.equal(Buffer.from(stored.epk, 'base64url').length, 32);
    assert.equal(Buffer.from(stored.iv, 'base64url').length, 12);
    assert.equal(Buffer.from(stored.tag, 'base64url').length, 16);
    for (const field of [stored.epk, stored.iv, stored.tag, stored.data]) {
      assert.match(field, /^[A-Za-z0-9_-]+$/);
    }
    assert.equal(decrypt(stored, pair.privateKey, PLATFORM_ARUBA_PASSWORD_CONTEXT), password);
    assert.equal(JSON.stringify(stored).includes(password), false);
  });

  it('uses a fresh ephemeral key, IV and ciphertext every time, and never the recipient key itself', () => {
    const all = Array.from({ length: 30 }, () => encryptCredential(recipient, 'same', 'ctx'));
    for (const field of ['epk', 'iv', 'data', 'tag'] as const) {
      assert.equal(new Set(all.map((stored) => stored[field])).size, 30, field);
    }
    const recipientRaw = pair.publicKey.export({ format: 'jwk' }).x;
    assert.ok(all.every((stored) => stored.epk !== recipientRaw));
    assert.ok(all.every((stored) => decrypt(stored, pair.privateKey, 'ctx') === 'same'));
  });

  it('binds the ciphertext to its context, to the recipient key and to every field', () => {
    const context = dealerArubaPasswordContext('a'.repeat(24));
    const stored = encryptCredential(recipient, 'secret', context);
    assert.throws(() => decrypt(stored, pair.privateKey, dealerArubaPasswordContext('b'.repeat(24))));
    assert.throws(() => decrypt(stored, pair.privateKey, PLATFORM_ARUBA_PASSWORD_CONTEXT));
    assert.throws(() => decrypt(stored, generateKeyPairSync('x25519').privateKey, context));
    const other = encryptCredential(recipient, 'secret', context);
    for (const field of ['epk', 'iv', 'tag', 'data'] as const) {
      assert.throws(() => decrypt({ ...stored, [field]: other[field] }, pair.privateKey, context), field);
    }
    const flipped = Buffer.from(stored.data, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    assert.throws(() => decrypt({ ...stored, data: flipped.toString('base64url') }, pair.privateKey, context));
  });
});
