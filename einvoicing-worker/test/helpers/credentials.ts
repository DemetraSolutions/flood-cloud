import { createCipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * The encryption of the backend's `credential-cipher.ts` ("v2"), repeated here for the tests: the worker never imports
 * from `backend/`, and the tests prove its decryption against an independent implementation of the documented
 * algorithm (`doc/Data-Model.md`).
 */

/** A recipient key pair generated for one test run: nothing here is a real key. */
export interface TestKeys {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly privatePem: string;
  readonly keyId: string;
}

/** Generates an X25519 key pair. */
export function generateKeys(keyId = 'test-key-1'): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey, privateKey, privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), keyId };
}

/** The stored form of an encrypted credential. */
export interface StoredCredential {
  v: number;
  kid: string;
  epk: string;
  iv: string;
  tag: string;
  data: string;
}

const raw = (key: KeyObject): Buffer => Buffer.from(key.export({ format: 'jwk' }).x as string, 'base64url');

/** Encrypts `plaintext` for the recipient, bound to `context` (AAD and HKDF info). */
export function encrypt(keys: Pick<TestKeys, 'publicKey' | 'keyId'>, plaintext: string, context: string): StoredCredential {
  const ephemeral = generateKeyPairSync('x25519');
  const epk = raw(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: keys.publicKey });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, raw(keys.publicKey)]), `flood-cloud:credential:v2:${context}`, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 2, kid: keys.keyId, epk: epk.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
}
