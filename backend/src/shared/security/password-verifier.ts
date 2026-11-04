import { safeEqual } from './compare.ts';
import { legacyHashFingerprint, verifyLegacyPassword } from './legacy-password.ts';
import { needsRehash, verifyDummyPassword, verifyPassword, warmUpDummyHash } from './scrypt.ts';
import type { Secret } from './secret.ts';

/** The scrypt credentials of a user, as far as verification is concerned. */
export interface StoredCredentials {
  /** scrypt hash in the format of `hashPassword`. */
  readonly passwordHash: string;
  /** Fingerprint of the legacy hash current when the scrypt hash was made, or `null`. */
  readonly legacyHashFingerprint: string | null;
}

/**
 * A scrypt hash the caller should compute and store once it has decided the login is allowed. The
 * hash itself is not computed here, so a refused login (disabled account, retired role, suspended
 * group) costs one scrypt in total.
 */
export interface RehashRequest {
  /** Fingerprint of the legacy hash to store with the new scrypt hash, or `null`. */
  readonly legacyHashFingerprint: string | null;
}

/** Outcome of {@link verifyUserPassword}. */
export type VerifyResult =
  | { readonly ok: false }
  | {
      readonly ok: true;
      /** The scrypt hash to compute and store (`hashPassword(password)` with this fingerprint), or `null`. */
      readonly rehash: RehashRequest | null;
      /** Whether a scrypt ran during the verification; if not, a refusing caller must run {@link verifyDummyPassword} to keep the cost uniform. */
      readonly usedScrypt: boolean;
    };

/**
 * Verifies a login password while the legacy system coexists (decision D-04). Pure: it decides, it
 * does not persist and it does not compute the new scrypt hash; when `rehash` is not `null` the
 * caller computes it with `hashPassword` and writes it, after its own checks have passed.
 *
 * 1. Credentials exist and scrypt is authoritative: their fingerprint is `null` (the legacy hash is
 *    ignored, since a null fingerprint only exists when coexistence is off), or the legacy hash is
 *    absent (the legacy removed it; the user is not locked out), or the fingerprint matches the
 *    current legacy hash. Only scrypt is verified; on success a rehash is requested when the
 *    parameters are outdated, keeping the stored fingerprint.
 * 2. Credentials exist with a fingerprint that differs from the current legacy hash (the legacy
 *    changed the password), or there are no credentials: verify with the legacy hash; on success,
 *    request a scrypt hash with the fingerprint of the current legacy hash.
 * 3. No usable hash: failure.
 *
 * @param input The password, the legacy hash (or `null`), the stored credentials (or `null`) and the pepper.
 * @returns Failure, or success with the optional rehash request.
 */
export async function verifyUserPassword(input: {
  readonly password: string;
  readonly legacyHash: string | null;
  readonly credentials: StoredCredentials | null;
  readonly pepper: Secret;
}): Promise<VerifyResult> {
  const { password, legacyHash, credentials, pepper } = input;
  const currentFingerprint = legacyHash === null ? null : legacyHashFingerprint(legacyHash);

  if (credentials !== null && scryptIsAuthoritative(credentials.legacyHashFingerprint, currentFingerprint)) {
    if (!(await verifyPassword(password, credentials.passwordHash))) {
      return { ok: false };
    }
    return { ok: true, rehash: needsRehash(credentials.passwordHash) ? { legacyHashFingerprint: credentials.legacyHashFingerprint } : null, usedScrypt: true };
  }

  if (legacyHash === null || !verifyLegacyPassword(password, legacyHash, pepper)) {
    // No scrypt ran on this path: run a fake one so the response time does not reveal the account state.
    await verifyDummyPassword(password);
    return { ok: false };
  }
  return { ok: true, rehash: { legacyHashFingerprint: currentFingerprint }, usedScrypt: false };
}

/**
 * Tells whether the scrypt hash alone decides: the stored fingerprint is `null` (coexistence was off
 * when it was written, so the legacy cannot change passwords any more), the legacy hash is gone, or
 * the fingerprint still matches the current legacy hash.
 */
function scryptIsAuthoritative(stored: string | null, current: string | null): boolean {
  return stored === null || current === null || safeEqual(stored, current);
}

export { verifyDummyPassword };

/**
 * Precomputes the fake hash used for constant-time failures. Call it once at startup, before the
 * server starts listening. Idempotent.
 *
 * @returns Resolves when the fake hash is ready.
 */
export async function warmUpPasswordVerifier(): Promise<void> {
  await warmUpDummyHash();
}
