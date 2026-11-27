/**
 * Small helpers to read what Aruba says without trusting it.
 *
 * @module
 */

/** A decoded JSON document, or the fact that the text is not JSON. */
export type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * Parses JSON text.
 *
 * @param text The body of a response.
 * @returns The value, or `{ ok: false }` for anything that is not JSON (the parser's message, which can echo the body, is dropped).
 */
export function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Narrows to a plain object.
 *
 * @param value Anything.
 * @returns Whether it is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Text from something Aruba sent, safe to store and to show: control characters become spaces, ends are trimmed, length is capped.
 *
 * @param value Anything; only strings and numbers give text, the rest gives `''`.
 * @param max Most characters kept.
 * @returns The cleaned text.
 */
export function cleanText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
}
