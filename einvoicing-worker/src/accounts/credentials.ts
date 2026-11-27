/**
 * Decryption of the provider credentials stored by the backend (format "v2", `doc/Data-Model.md`).
 *
 * The backend encrypts with the public key only; this module holds the private one. The algorithm mirrors the
 * backend's (it is repeated here, never imported): `shared = X25519(own private, ephemeral public)`,
 * `key = HKDF-SHA-256(shared, salt = epk || own public, info = "flood-cloud:credential:v2:" + context, 32)`,
 * AES-256-GCM with the context as AAD. The context (the place the credential lives in) is rebuilt by the caller from
 * where the document was read, never taken from a stored field, so a ciphertext moved to another account fails.
 *
 * @module
 */
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { Secret } from '../secret.ts';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO_PREFIX = 'flood-cloud:credential:v2:';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The only format version understood. */
export const SUPPORTED_VERSION = 2;

/** Why a credential could not be used. Codes only: never data. */
export type DecryptFailure = 'no_key' | 'unsupported_version' | 'unknown_key' | 'malformed' | 'authentication';

/** Outcome of {@link CredentialDecryptor}. */
export type DecryptResult = { readonly ok: true; readonly value: Secret } | { readonly ok: false; readonly reason: DecryptFailure };

/** Decrypts a stored credential for the place it was written for. */
export type CredentialDecryptor = (stored: unknown, context: string) => DecryptResult;

/** The AAD context of the Aruba password of a dealer's own account. */
export const dealerPasswordContext = (provider: string, dealerIdHex: string): string => `einvoicing:${provider}:dealer:${dealerIdHex}:password`;

/** The AAD context of the password of the platform's own account. */
export const platformPasswordContext = (provider: string): string => `einvoicing:${provider}:platform:password`;

/**
 * Parses the private key.
 *
 * @param pem PEM, PKCS#8, an X25519 private key.
 * @returns The key object.
 * @throws {Error} When the text is not a PEM private key, or the key is of another type (a public key is refused).
 * The message never contains the text.
 */
export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'x25519') {
    throw new Error('not an X25519 private key');
  }
  return key;
}

/** Decodes a base64url field of an exact length, or `undefined`. */
function field(value: unknown, bytes: number | null): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL.test(value)) {
    return undefined;
  }
  const raw = Buffer.from(value, 'base64url');
  return raw.length > 0 && (bytes === null || raw.length === bytes) && raw.toString('base64url') === value ? raw : undefined;
}

/**
 * Builds a decryptor bound to a private key.
 *
 * @param privateKey The X25519 private key (from {@link parsePrivateKey}).
 * @param keyId The id of that key: a credential with another `kid` is refused.
 * @returns The decryptor. It never throws: every failure is a {@link DecryptFailure} code.
 */
export function createCredentialDecryptor(privateKey: KeyObject, keyId: string): CredentialDecryptor {
  const own = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  return (stored, context) => {
    const doc = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : undefined;
    if (doc === undefined) {
      return { ok: false, reason: 'malformed' };
    }
    if (doc['v'] !== SUPPORTED_VERSION) {
      return { ok: false, reason: 'unsupported_version' };
    }
    if (doc['kid'] !== keyId) {
      return { ok: false, reason: 'unknown_key' };
    }
    const epk = field(doc['epk'], KEY_BYTES);
    const iv = field(doc['iv'], IV_BYTES);
    const tag = field(doc['tag'], TAG_BYTES);
    const data = field(doc['data'], null);
    if (epk === undefined || iv === undefined || tag === undefined || data === undefined) {
      return { ok: false, reason: 'malformed' };
    }
    try {
      const ephemeral = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: epk.toString('base64url') }, format: 'jwk' });
      const shared = diffieHellman({ privateKey, publicKey: ephemeral });
      const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, own]), `${HKDF_INFO_PREFIX}${context}`, KEY_BYTES));
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]);
      return { ok: true, value: new Secret(plain.toString('utf8')) };
    } catch {
      return { ok: false, reason: 'authentication' };
    }
  };
}

/** The decryptor used when no private key is configured (only possible with no hub enabled): refuses everything. */
export const refuseCredentials: CredentialDecryptor = () => ({ ok: false, reason: 'no_key' });
