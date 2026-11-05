const MAX_LENGTH = 2048;
const LOGIN_PATH = /^\/login(?:[/?#]|$)/;
// A single leading slash (not "//" or "/\", which browsers read as another host), no
// backslashes and no control characters.
const INTERNAL_PATH = /^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/;

/**
 * Validates the `returnUrl` carried through the login page: only a relative path of this
 * application is accepted, so the login can never redirect to another site (open redirect).
 *
 * @param value Candidate value (typically a query parameter).
 * @returns The same path when it is safe, otherwise `null`.
 */
export function safeReturnUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > MAX_LENGTH ||
    !INTERNAL_PATH.test(value) ||
    LOGIN_PATH.test(value)
  ) {
    return null;
  }
  return value;
}
