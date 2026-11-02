import { createHash, randomBytes } from 'node:crypto';

/**
 * Prefixes of the secrets issued by the server.
 * `fc_at_` backoffice access token, `fc_rt_` backoffice refresh token, `fc_pk_` public API key.
 */
export const SECRET_PREFIXES = ['fc_at_', 'fc_rt_', 'fc_pk_'] as const;

/** One of the allowed {@link SECRET_PREFIXES}. */
export type SecretPrefix = (typeof SECRET_PREFIXES)[number];

/** Number of random bytes behind every issued secret (256 bits). */
const SECRET_BYTES = 32;

/** Length of the base64url body of a secret: 32 bytes encode to 43 characters. */
const BODY_LENGTH = 43;

const BODY = new RegExp(`^[A-Za-z0-9_-]{${BODY_LENGTH}}$`);

/**
 * Generates a new opaque secret: the prefix followed by 256 bits from the CSPRNG in base64url.
 *
 * @param prefix Kind of secret to issue.
 * @returns The secret, `prefix.length + 43` characters long. Show it once, store only {@link hashSecret}.
 * @example
 * generateSecret('fc_at_'); // 'fc_at_5Zr...'
 */
export function generateSecret(prefix: SecretPrefix): string {
  return prefix + randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * Checks that a value has the exact format of a secret with the expected prefix.
 * Never throws and never echoes the value.
 *
 * @param value Untrusted value, typically from an `Authorization` header or a request body.
 * @param expectedPrefix Prefix the value must carry.
 * @returns The value when the format is exact, `null` otherwise.
 */
export function parseSecret(value: unknown, expectedPrefix: SecretPrefix): string | null {
  if (typeof value !== 'string' || !value.startsWith(expectedPrefix)) {
    return null;
  }
  return BODY.test(value.slice(expectedPrefix.length)) ? value : null;
}

/**
 * Hashes a secret with SHA-256 (lowercase hex, 64 characters). This is what is stored and looked up
 * through a unique index. A fast hash is enough because the input has 256 bits of entropy and cannot
 * be guessed or brute-forced (doc/Security-Model.md section 3); slow hashes are for human passwords only.
 *
 * @param value The secret to hash.
 * @returns 64 lowercase hex characters.
 */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
