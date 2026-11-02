import { createHash, createHmac } from 'node:crypto';
import { safeEqual } from './compare.ts';
import type { Secret } from './secret.ts';

const LEGACY_HASH = /^[0-9a-f]{128}$/;

/**
 * Computes the legacy password hash: HMAC-SHA512 keyed with the global pepper (UTF-8), message
 * is the password exactly as typed, digest in lowercase hex (128 characters). The password is
 * deliberately NOT normalized: the output must match the legacy system byte for byte (decision D-04).
 *
 * @param password Plain-text password, as received.
 * @param pepper The legacy global pepper.
 * @returns 128 lowercase hex characters.
 */
export function legacyPasswordHash(password: string, pepper: Secret): string {
  return createHmac('sha512', pepper.reveal()).update(password, 'utf8').digest('hex');
}

/**
 * Verifies a password against a legacy hash in constant time.
 *
 * @param password Plain-text password, as received.
 * @param storedHash Legacy hash; anything but 128 lowercase hex characters never matches.
 * @param pepper The legacy global pepper.
 * @returns `true` when the password matches.
 */
export function verifyLegacyPassword(password: string, storedHash: string, pepper: Secret): boolean {
  if (!LEGACY_HASH.test(storedHash)) {
    return false;
  }
  return safeEqual(legacyPasswordHash(password, pepper), storedHash);
}

/**
 * Fingerprint of a legacy hash: its SHA-256 in hex. Stored next to the scrypt hash to detect that
 * the legacy system changed the password afterwards, without storing the legacy hash twice.
 *
 * @param storedHash The legacy hash currently in the legacy user document.
 * @returns 64 lowercase hex characters.
 */
export function legacyHashFingerprint(storedHash: string): string {
  return createHash('sha256').update(storedHash, 'utf8').digest('hex');
}
