/**
 * Character-set handling for the string types of the FatturaPA schemas.
 *
 * The XSD string types allow only two repertoires: `String...LatinType` accepts the Unicode blocks Basic Latin and
 * Latin-1 Supplement, `String...Type` (codes, numbers, references) only Basic Latin; all of them are
 * `normalizedString`, so tab, CR and LF are forbidden. Free text from the point of sale (product names, notes,
 * addresses) can hold anything, so it is cleaned here before it enters the model:
 *
 * 1. NFC normalization, whitespace of every kind collapsed to one space, edges trimmed;
 * 2. common typographic characters replaced by ASCII equivalents (curly quotes, dashes, ellipsis, euro sign);
 * 3. in Basic Latin fields accented letters are transliterated (`à` to `a`); in Latin fields the accents stay;
 * 4. any character still outside the repertoire (emoji, control characters, other scripts) becomes `?` and the
 *    result is flagged `replaced`, so the validator can warn without blocking the invoice;
 * 5. the text is cut at the maximum length of the field (flagged `truncated`).
 *
 * After step 4 every character is a single UTF-16 unit (at most U+00FF), so the cut can never split a surrogate pair.
 * Punctuation, apostrophes, hyphens and `&` are kept (the XML writer escapes them).
 *
 * @module
 */

/** Repertoire of a field: `basic` is Basic Latin only, `latin` is Basic Latin plus Latin-1 Supplement. */
export type Charset = 'basic' | 'latin';

/** Result of cleaning a text. */
export interface CleanText {
  /** The cleaned text (possibly empty). */
  readonly value: string;
  /** At least one character had no representation and became `?`. */
  readonly replaced: boolean;
  /** The text was cut at the maximum length. */
  readonly truncated: boolean;
}

/** Typographic characters replaced by their ASCII equivalent (an empty string removes an invisible character). */
const TYPOGRAPHIC: Readonly<Record<string, string>> = Object.freeze({
  '‘': "'",
  '’': "'",
  '‚': ',',
  '‛': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '•': '-',
  '…': '...',
  '€': 'EUR',
  '​': '',
  '‌': '',
  '‍': '',
  '⁠': '',
});

/** Letters with no canonical decomposition that still have a conventional ASCII spelling. */
const LETTERS: Readonly<Record<string, string>> = Object.freeze({
  'ß': 'ss',
  'Æ': 'AE',
  'æ': 'ae',
  'Ø': 'O',
  'ø': 'o',
  'Ð': 'D',
  'ð': 'd',
  'Þ': 'TH',
  'þ': 'th',
  'Œ': 'OE',
  'œ': 'oe',
  'Ł': 'L',
  'ł': 'l',
  'Đ': 'D',
  'đ': 'd',
});

/** Whether a code point belongs to the repertoire (NBSP never reaches this check: whitespace is collapsed first). */
function isAllowed(codePoint: number, charset: Charset): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  return charset === 'latin' && codePoint >= 0xa1 && codePoint <= 0xff;
}

function allAllowed(text: string, charset: Charset): boolean {
  for (const character of text) {
    if (!isAllowed(character.codePointAt(0) as number, charset)) {
      return false;
    }
  }
  return true;
}

/** ASCII spelling of one character: its letters without diacritics, or the empty string when there is none. */
function transliterate(character: string): string {
  return LETTERS[character] ?? character.normalize('NFD').replace(/\p{M}/gu, '');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Cleans a free text for a field of the given repertoire (see the module description for the steps).
 *
 * @param input The raw text.
 * @param charset Repertoire of the destination field.
 * @param maxLength Maximum length in characters (default: no limit).
 * @returns The cleaned text and whether it lost information (`replaced`, `truncated`).
 * @example
 * cleanText('Caffè “speciale” – 2€', 'basic', 40).value; // 'Caffe "speciale" - 2EUR'
 */
export function cleanText(input: string, charset: Charset, maxLength = Number.POSITIVE_INFINITY): CleanText {
  let replaced = false;
  let result = '';
  for (const character of collapseWhitespace(input.normalize('NFC'))) {
    const mapped = TYPOGRAPHIC[character];
    if (mapped !== undefined) {
      result += mapped;
    } else if (isAllowed(character.codePointAt(0) as number, charset)) {
      result += character;
    } else {
      const ascii = transliterate(character);
      if (ascii !== '' && allAllowed(ascii, charset)) {
        result += ascii;
      } else {
        result += '?';
        replaced = true;
      }
    }
  }
  result = collapseWhitespace(result);
  const truncated = result.length > maxLength;
  return { value: truncated ? result.slice(0, maxLength).trimEnd() : result, replaced, truncated };
}

/**
 * Splits a cleaned text in blocks of at most `maxLength` characters, cutting at a space when there is one in the
 * block (a word longer than the block is cut in the middle). No character is lost except the cutting spaces.
 *
 * @param text A text already cleaned with {@link cleanText} (single spaces, no edge spaces).
 * @param maxLength Maximum length of a block (at least 1).
 * @returns The blocks, in order; an empty array for an empty text.
 */
export function splitText(text: string, maxLength: number): string[] {
  const blocks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf(' ', maxLength);
    if (cut <= 0) {
      cut = maxLength;
    }
    blocks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') {
    blocks.push(rest);
  }
  return blocks;
}

/**
 * Validates an identifier-like value (invoice number, fiscal code, reference): such a value is never altered, since
 * changing it would change the identity of the datum. Surrounding whitespace is ignored.
 *
 * @param input The raw value.
 * @param maxLength Maximum length in characters.
 * @returns The trimmed value, or `null` when it is empty, too long or has a character outside printable Basic Latin.
 */
export function identifier(input: string, maxLength: number): string | null {
  const value = input.trim();
  if (value === '' || value.length > maxLength || !allAllowed(value, 'basic')) {
    return null;
  }
  return value;
}
