/** The longest name a statement keeps (names are cut and stripped of control characters, so a cursor made of three of them stays small). */
export const MAX_NAME_LENGTH = 100;

/**
 * A text for a statement: only text, control characters turned into spaces, trimmed and cut.
 *
 * @param value Any stored value.
 * @param max The longest result.
 * @returns The cleaned text, `''` when the value is not a text.
 */
export function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim().slice(0, max) : '';
}

/** A name for a statement: {@link cleanText} cut at {@link MAX_NAME_LENGTH}. */
export function cleanName(value: unknown): string {
  return cleanText(value, MAX_NAME_LENGTH);
}
