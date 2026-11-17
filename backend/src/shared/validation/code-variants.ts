/**
 * The spellings of a two-letter code that a legacy document may hold: the code as given, in lower case, and the two mixed cases (`IT`, `it`, `It`, `iT`), without repetitions. A lookup that matches all of
 * them with `$in` is deterministic and needs no regular expression, so a country or a province that a legacy client stored in another case is still found, counted and guarded.
 *
 * @param code A code of two letters A to Z in upper case.
 * @returns The distinct spellings, the upper-case one first.
 */
export function codeVariants(code: string): string[] {
  const upper = code.toUpperCase();
  const lower = upper.toLowerCase();
  return [...new Set([upper, lower, upper.slice(0, 1) + lower.slice(1), lower.slice(0, 1) + upper.slice(1)])];
}
