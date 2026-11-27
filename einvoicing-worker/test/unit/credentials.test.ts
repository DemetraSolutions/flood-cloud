import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { createCredentialDecryptor, dealerPasswordContext, parsePrivateKey, platformPasswordContext, refuseCredentials } from '../../src/accounts/credentials.ts';
import { Secret } from '../../src/secret.ts';
import { encrypt, generateKeys } from '../helpers/credentials.ts';
import type { StoredCredential } from '../helpers/credentials.ts';

const DEALER = '0123456789abcdef01234567';
const PASSWORD = 'correct horse battery staple';

describe('credential contexts', () => {
  it('rebuild the documented AAD', () => {
    assert.equal(dealerPasswordContext('aruba', DEALER), `einvoicing:aruba:dealer:${DEALER}:password`);
    assert.equal(platformPasswordContext('aruba'), 'einvoicing:aruba:platform:password');
  });
});

describe('parsePrivateKey', () => {
  it('reads a PKCS#8 X25519 private key', () => {
    assert.equal(parsePrivateKey(generateKeys().privatePem).asymmetricKeyType, 'x25519');
  });

  it('refuses garbage, a public key and a key of another type, without echoing the text', () => {
    const keys = generateKeys();
    const publicPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const ed25519 = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    assert.throws(() => parsePrivateKey('not a key'), { message: 'not a PEM private key' });
    assert.throws(() => parsePrivateKey(publicPem), { message: 'not a PEM private key' });
    assert.throws(() => parsePrivateKey(ed25519), { message: 'not an X25519 private key' });
  });
});

describe('createCredentialDecryptor (v2)', () => {
  const keys = generateKeys();
  const decrypt = createCredentialDecryptor(keys.privateKey, keys.keyId);
  const context = dealerPasswordContext('aruba', DEALER);

  it('decrypts what the backend algorithm encrypts, into a Secret', () => {
    const result = decrypt(encrypt(keys, PASSWORD, context), context);
    assert.ok(result.ok);
    assert.ok(result.value instanceof Secret);
    assert.equal(result.value.reveal(), PASSWORD);
    assert.equal(`${result.value}`, '[REDACTED]');
  });

  it('decrypts non-ASCII passwords and two encryptions of one text differ', () => {
    const a = encrypt(keys, 'pässwörd-€', context);
    const b = encrypt(keys, 'pässwörd-€', context);
    assert.notEqual(a.data + a.iv, b.data + b.iv);
    const result = decrypt(a, context);
    assert.ok(result.ok);
    assert.equal(result.value.reveal(), 'pässwörd-€');
  });

  it('refuses another place (AAD and key derivation bound to the context)', () => {
    const stored = encrypt(keys, PASSWORD, context);
    assert.deepEqual(decrypt(stored, dealerPasswordContext('aruba', 'f'.repeat(24))), { ok: false, reason: 'authentication' });
    assert.deepEqual(decrypt(stored, platformPasswordContext('aruba')), { ok: false, reason: 'authentication' });
  });

  it('refuses an unknown version and another key id', () => {
    const stored = encrypt(keys, PASSWORD, context);
    assert.deepEqual(decrypt({ ...stored, v: 1 }, context), { ok: false, reason: 'unsupported_version' });
    assert.deepEqual(decrypt({ ...stored, v: '2' }, context), { ok: false, reason: 'unsupported_version' });
    assert.deepEqual(decrypt({ ...stored, kid: 'other' }, context), { ok: false, reason: 'unknown_key' });
  });

  it('refuses another recipient key (a rotation not yet followed)', () => {
    const other = generateKeys(keys.keyId);
    assert.deepEqual(decrypt(encrypt(other, PASSWORD, context), context), { ok: false, reason: 'authentication' });
  });

  it('refuses a tampered tag, ciphertext, iv or ephemeral key', () => {
    const stored = encrypt(keys, PASSWORD, context);
    const flip = (value: string): string => `${value.startsWith('A') ? 'B' : 'A'}${value.slice(1)}`;
    for (const field of ['tag', 'data', 'iv', 'epk'] as const) {
      assert.deepEqual(decrypt({ ...stored, [field]: flip(stored[field]) }, context), { ok: false, reason: 'authentication' }, field);
    }
  });

  it('refuses malformed values without throwing', () => {
    const stored = encrypt(keys, PASSWORD, context);
    const bad: unknown[] = [null, undefined, 'text', 42];
    for (const value of bad) {
      assert.deepEqual(decrypt(value, context), { ok: false, reason: 'malformed' });
    }
    const mutations: Array<Partial<Record<keyof StoredCredential, unknown>>> = [
      { epk: undefined },
      { epk: 42 },
      { epk: 'AAAA' },
      { iv: stored.iv.slice(2) },
      { tag: `${stored.tag}AA` },
      { data: '' },
      { data: 'not base64url!' },
      { data: `${stored.data}=` },
    ];
    for (const change of mutations) {
      assert.deepEqual(decrypt({ ...stored, ...change }, context), { ok: false, reason: 'malformed' }, JSON.stringify(Object.keys(change)));
    }
  });

  it('treats a degenerate ephemeral key (all zero, a low-order point) as an authentication failure', () => {
    const stored = encrypt(keys, PASSWORD, context);
    assert.deepEqual(decrypt({ ...stored, epk: Buffer.alloc(32).toString('base64url') }, context), { ok: false, reason: 'authentication' });
  });

  it('refuseCredentials refuses everything', () => {
    assert.deepEqual(refuseCredentials(encrypt(keys, PASSWORD, context), context), { ok: false, reason: 'no_key' });
  });
});
