import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares two strings in constant time. Both values are hashed with SHA-256 first, so the
 * comparison runs on equal-length buffers: different lengths neither throw nor leak through timing.
 *
 * @param a First string.
 * @param b Second string.
 * @returns `true` when the strings are identical.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}
