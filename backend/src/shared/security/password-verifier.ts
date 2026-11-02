import { safeEqual } from './compare.ts';
import { legacyHashFingerprint, verifyLegacyPassword } from './legacy-password.ts';
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword, warmUpDummyHash } from './scrypt.ts';
import type { Secret } from './secret.ts';

/** The scrypt credentials of a user, as far as verification is concerned. */
export interface StoredCredentials {
  /** scrypt hash in the format of {@link hashPassword}. */
  readonly passwordHash: string;
  /** Fingerprint of the legacy hash current when the scrypt hash was made, or `null`. */
  readonly legacyHashFingerprint: string | null;
}

/** Values to persist after a successful verification; never contains the password. */
export interface CredentialsUpdate {
  readonly passwordHash: string;
  readonly legacyHashFingerprint: string | null;
}

/** Outcome of {@link verifyUserPassword}. */
export type VerifyResult =
  | { readonly ok: false }
  | { readonly ok: true; readonly credentialsUpdate: CredentialsUpdate | null };

/**
 * Verifies a login password while the legacy system coexists (decision D-04). Pure: it decides, it
 * does not persist; the caller writes `credentialsUpdate` when it is not `null`.
 *
 * 1. Credentials exist and scrypt is authoritative: their fingerprint is `null` (the legacy hash is
 *    ignored, since a null fingerprint only exists when coexistence is off), or the legacy hash is
 *    absent (the legacy removed it; the user is not locked out), or the fingerprint matches the
 *    current legacy hash. Only scrypt is verified; on success a rehash is requested when the
 *    parameters are outdated, keeping the stored fingerprint.
 * 2. Credentials exist with a fingerprint that differs from the current legacy hash (the legacy
 *    changed the password), or there are no credentials: verify with the legacy hash; on success,
 *    return a fresh scrypt hash and the fingerprint of the current legacy hash.
 * 3. No usable hash: failure.
 *
 * @param input The password, the legacy hash (or `null`), the stored credentials (or `null`) and the pepper.
 * @returns Failure, or success with the optional update to persist.
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
    if (!needsRehash(credentials.passwordHash)) {
      return { ok: true, credentialsUpdate: null };
    }
    return {
      ok: true,
      credentialsUpdate: {
        passwordHash: await hashPassword(password),
        legacyHashFingerprint: credentials.legacyHashFingerprint,
      },
    };
  }

  if (legacyHash === null || !verifyLegacyPassword(password, legacyHash, pepper)) {
    // No scrypt ran on this path: run a fake one so the response time does not reveal the account state.
    await verifyDummyPassword(password);
    return { ok: false };
  }
  return {
    ok: true,
    credentialsUpdate: { passwordHash: await hashPassword(password), legacyHashFingerprint: currentFingerprint },
  };
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
