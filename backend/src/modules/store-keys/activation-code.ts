import { randomBytes } from 'node:crypto';
import { hashSecret } from '../../shared/security/secrets.ts';

/** Crockford base32: the digits and the letters but `I`, `L`, `O` and `U`, which are easy to mistake or to read aloud wrongly. 32 symbols, so a byte masked with 31 is uniform. */
export const ACTIVATION_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Symbols of a code: 16 of 5 bits, 80 bits of entropy. */
export const ACTIVATION_CODE_LENGTH = 16;

/** Symbols of a group of the presented code (`XXXX-XXXX-XXXX-XXXX`). */
const GROUP_LENGTH = 4;

const NORMALIZED = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/**
 * Maps random bytes to the symbols of a code: the low five bits of every byte (256 is a multiple of 32, so every symbol is equally likely).
 *
 * @param bytes Exactly {@link ACTIVATION_CODE_LENGTH} bytes.
 * @returns The normalized code (no dashes).
 */
export function encodeActivationCode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => ACTIVATION_CODE_ALPHABET[byte & 31]).join('');
}

/**
 * Generates an activation code from the CSPRNG: 80 bits, short enough to be typed on the server of a store, valid for a short time and for one exchange only.
 *
 * @returns The normalized form (the one that is hashed) and the form to show (`XXXX-XXXX-XXXX-XXXX`). Show it once, store only {@link hashActivationCode}.
 */
export function generateActivationCode(): { readonly normalized: string; readonly presented: string } {
  const normalized = encodeActivationCode(randomBytes(ACTIVATION_CODE_LENGTH));
  const presented = normalized.match(new RegExp(`.{${String(GROUP_LENGTH)}}`, 'g'))!.join('-');
  return { normalized, presented };
}

/**
 * Normalizes a code typed or pasted by a person: upper case, no dashes or spaces, `O` read as `0` and `I` and `L` as `1`; then the exact format is required. Never throws and never echoes the value.
 *
 * @param value Untrusted value from a request body.
 * @returns The normalized code, or `null` when it is not a code (no query must follow).
 */
export function normalizeActivationCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) {
    return null;
  }
  const normalized = value.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return NORMALIZED.test(normalized) ? normalized : null;
}

/**
 * Hashes a normalized code with SHA-256 (hex), the form stored and looked up through a unique index. A fast hash is enough: 80 bits that live a few hours cannot be brute-forced offline.
 *
 * @param normalized A code from {@link normalizeActivationCode} or {@link generateActivationCode}.
 */
export function hashActivationCode(normalized: string): string {
  return hashSecret(normalized);
}
