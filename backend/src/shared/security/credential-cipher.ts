import { createCipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Length in bytes of the random IV of AES-GCM (96 bits, the size the mode is designed for). */
const IV_BYTES = 12;

/** Length in bytes of the authentication tag of AES-GCM. */
const TAG_BYTES = 16;

/** Length in bytes of the AES-256 key derived for one credential. */
const KEY_BYTES = 32;

/** Prefix of the HKDF `info`: the format version, then the AAD context. */
const HKDF_INFO_PREFIX = 'flood-cloud:credential:v2:';

/**
 * A credential encrypted at rest with the hybrid scheme "v2": ECDH on X25519 with a fresh ephemeral key, HKDF-SHA-256, AES-256-GCM. Every binary field is base64url.
 * Only the holder of the private key of the recipient (the e-invoicing worker) can decrypt it; this server holds the public key alone. `kid` names the recipient
 * key, so a rotation can tell which private key to use. The ciphertext is bound to the place it was written for through the AAD and the HKDF `info`
 * (see {@link encryptCredential}).
 */
export interface StoredCredential {
  /** Format version. */
  readonly v: 2;
  /** Id of the recipient key (`CREDENTIALS_PUBLIC_KEY_ID`). */
  readonly kid: string;
  /** The ephemeral X25519 public key of this encryption, raw: 32 bytes (the `x` member of its JWK). */
  readonly epk: string;
  /** The random 12-byte IV. */
  readonly iv: string;
  /** The 16-byte authentication tag. */
  readonly tag: string;
  /** The ciphertext. */
  readonly data: string;
}

/** The AAD context of the Aruba password of a dealer's own account. */
export const dealerArubaPasswordContext = (dealerIdHex: string): string => `einvoicing:aruba:dealer:${dealerIdHex}:password`;

/** The AAD context of the Aruba password of the platform's own account. */
export const PLATFORM_ARUBA_PASSWORD_CONTEXT = 'einvoicing:aruba:platform:password';

/** The recipient of the credentials: the X25519 public key they are encrypted for, and its id. */
export interface CredentialRecipient {
  /** The X25519 public key (`CREDENTIALS_PUBLIC_KEY`). */
  readonly key: KeyObject;
  /** Id of the key (`CREDENTIALS_PUBLIC_KEY_ID`), written as `kid` next to every ciphertext. */
  readonly id: string;
}

/** The raw 32 bytes of an X25519 public key: the `x` member of its JWK. */
function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
}

/**
 * Encrypts a credential for the recipient. The server only ever encrypts, it cannot decrypt what it wrote. The algorithm, which the worker repeats from the
 * private key:
 *
 * 1. generate an ephemeral X25519 key pair; `epk` is its public key raw (32 bytes, the JWK `x`);
 * 2. `shared = X25519(ephemeral private, recipient public)`;
 * 3. `key = HKDF-SHA-256(ikm = shared, salt = epk || recipientRaw, info = "flood-cloud:credential:v2:" + context, 32 bytes)`, both raw keys being 32 bytes;
 * 4. AES-256-GCM with a random 12-byte IV, a 16-byte tag and `context` (UTF-8) as AAD.
 *
 * @param recipient The public key and its id.
 * @param plaintext The credential.
 * @param context The place the credential belongs to, authenticated as AAD and mixed into the key: a ciphertext moved to another account no longer decrypts.
 * @returns The stored form.
 */
export function encryptCredential(recipient: CredentialRecipient, plaintext: string, context: string): StoredCredential {
  const ephemeral = generateKeyPairSync('x25519');
  const epk = rawPublicKey(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient.key });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, rawPublicKey(recipient.key)]), `${HKDF_INFO_PREFIX}${context}`, KEY_BYTES));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 2, kid: recipient.id, epk: epk.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
}
