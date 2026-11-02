import { legacyHashFingerprint, legacyPasswordHash } from './legacy-password.ts';
import { checkPasswordPolicy } from './password-policy.ts';
import type { PasswordIssue } from './password-policy.ts';
import { hashPassword } from './scrypt.ts';
import type { Secret } from './secret.ts';

/** Outcome of {@link buildPasswordChange}. */
export type PasswordChange =
  | { readonly ok: false; readonly issues: readonly PasswordIssue[] }
  | {
      readonly ok: true;
      /** New scrypt hash. */
      readonly passwordHash: string;
      /** New legacy hash to write into the legacy user document, or `null` when coexistence is off. */
      readonly legacyHash: string | null;
      /** Fingerprint of `legacyHash`, or `null` when coexistence is off. */
      readonly legacyHashFingerprint: string | null;
    };

/**
 * Prepares everything to persist when a password is set or changed: applies the password policy
 * (D-19), computes the scrypt hash and, while the legacy system coexists (D-04), also the legacy
 * hash so that the old system keeps accepting the new password. Pure: it does not persist.
 *
 * @param password New plain-text password.
 * @param options The username (policy), the legacy pepper and whether the legacy system coexists.
 * @returns The violated policy rules, or the hashes to store.
 */
export async function buildPasswordChange(
  password: string,
  options: { readonly username: string; readonly pepper: Secret; readonly legacyCoexistence: boolean },
): Promise<PasswordChange> {
  const policy = checkPasswordPolicy(password, { username: options.username });
  if (!policy.ok) {
    return { ok: false, issues: policy.issues };
  }
  const passwordHash = await hashPassword(password);
  if (!options.legacyCoexistence) {
    return { ok: true, passwordHash, legacyHash: null, legacyHashFingerprint: null };
  }
  const legacyHash = legacyPasswordHash(password, options.pepper);
  return { ok: true, passwordHash, legacyHash, legacyHashFingerprint: legacyHashFingerprint(legacyHash) };
}
