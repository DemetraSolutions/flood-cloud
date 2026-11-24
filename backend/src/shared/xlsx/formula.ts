/**
 * What a spreadsheet may read as the start of a formula (or strip): `=`, `+`, `-`, `@` and their full-width forms `＝ ＋ － ＠`, after any white space (a space, a non-breaking space or any other Unicode space), and a
 * tab or a carriage return, with or without what follows. Apostrophes before all of it are part of the prefix, so the rule stays reversible.
 */
const FORMULA_START = /^'*(?:[\t\r]|\s*[=+\-@＝＋－＠])/;

/**
 * Makes a text safe to be written in a cell: a text that a spreadsheet could read as a formula (it starts with `=`, `+`, `-`, `@` or their full-width forms, possibly after white space, or with a tab or a carriage return, possibly after apostrophes) gets one more
 * leading apostrophe. {@link restoreFormula} is its exact inverse, so a value survives an export followed by an import unchanged.
 *
 * @param value The text of the cell.
 * @returns The text to write.
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * The inverse of {@link neutralizeFormula}: a text that starts with an apostrophe followed (after any more apostrophes) by a formula character loses that first apostrophe.
 *
 * @param value The text read from a cell.
 * @returns The text that was exported.
 */
export function restoreFormula(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}
