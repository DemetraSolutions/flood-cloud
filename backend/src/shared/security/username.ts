/**
 * Canonical form of a username for rate limiting and, in the login area, for looking the user up:
 * Unicode NFKC, trimmed, lower case.
 *
 * Constraint for the login (area 3): the user lookup MUST use this same normalization, otherwise an
 * attacker could vary the spelling to dodge the per-username counter. A username that is not a
 * string must be refused with `422 VALIDATION_ERROR` before any verification.
 *
 * @param value The username as sent by the client.
 * @returns The normalized username (possibly empty).
 * @example
 * normalizeUsername('  ＭＡＲＩＯ '); // 'mario'
 */
export function normalizeUsername(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
