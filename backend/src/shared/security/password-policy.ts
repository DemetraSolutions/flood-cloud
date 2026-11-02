/** Minimum password length in code points (decision D-19). */
export const PASSWORD_MIN_LENGTH = 12;
/** Maximum password length in code points (decision D-19). */
export const PASSWORD_MAX_LENGTH = 128;

/** A reason for which a new password is rejected; becomes a detail of the 422 response. */
export type PasswordIssue = 'tooShort' | 'tooLong' | 'sameAsUsername' | 'invalidCharacters';

/** Outcome of {@link checkPasswordPolicy}. */
export type PasswordPolicyResult = { readonly ok: true } | { readonly ok: false; readonly issues: readonly PasswordIssue[] };

/**
 * Checks a new or changed password against the policy of decision D-19: 12 to 128 code points
 * after NFC normalization, no rule on character classes, not equal to the username
 * (case-insensitive, after trim), and well-formed Unicode (no lone surrogates). Existing legacy passwords are not subject to it at login.
 *
 * @param password Candidate password.
 * @param context The username the password is for.
 * @returns `{ ok: true }` or the list of violated rules.
 */
export function checkPasswordPolicy(password: string, context: { readonly username: string }): PasswordPolicyResult {
  const normalized = password.normalize('NFC');
  const length = [...normalized].length;
  const issues: PasswordIssue[] = [];
  if (length < PASSWORD_MIN_LENGTH) {
    issues.push('tooShort');
  }
  if (length > PASSWORD_MAX_LENGTH) {
    issues.push('tooLong');
  }
  const fold = (text: string): string => text.normalize('NFC').trim().toLowerCase();
  if (fold(normalized) === fold(context.username)) {
    issues.push('sameAsUsername');
  }
  if (!password.isWellFormed()) {
    issues.push('invalidCharacters');
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
