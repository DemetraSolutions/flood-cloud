import type { Document, Filter } from 'mongodb';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import { escapeRegExp } from '../../shared/http/list.ts';
import { nullable, record, refine, string } from '../../shared/validation/schema.ts';
import type { Schema } from '../../shared/validation/schema.ts';
import { isRecord } from '../groups/catalogs/kit.ts';

/** Most languages one text may be written in. */
export const MAX_TEXT_LANGUAGES = 20;

/** Longest name of a department, a brand, an attribute group or an attribute, in characters. */
export const MAX_NAME_LENGTH = 150;

/** Longest description of a department or a brand, in characters. */
export const MAX_DESCRIPTION_LENGTH = 1000;

/** A language code as the schemas accept it: two lower case letters. */
const LANGUAGE_KEY = /^[a-z]{2}$/;

/** A language code as a stored document may hold it (the legacy writes whatever the client sent, so a code with a region is possible). */
const STORED_LANGUAGE_KEY = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/;

/** Control characters are refused in a name. */
const NO_CONTROL = /^[^\u0000-\u001F\u007F]*$/;

/** Control characters other than tab, carriage return and line feed are refused in a description. */
const NO_CONTROL_EXCEPT_LINES = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

/** A text by language: the language code (two letters) and its text. */
export type Texts = Readonly<Record<string, string>>;

/** The texts of a modification: a language set to `null` is removed. */
export type TextsPatch = Readonly<Record<string, string | null>>;

/** The texts by language of a name: at least one language, each text of 1 to {@link MAX_NAME_LENGTH} characters. */
export function nameTexts(): Schema<Record<string, string>, false> {
  return refine(record(string({ min: 1, max: MAX_NAME_LENGTH, trim: true, pattern: NO_CONTROL }), { max: MAX_TEXT_LANGUAGES, key: LANGUAGE_KEY }), (value) => (Object.keys(value).length === 0 ? [''] : []), 'required');
}

/** The texts by language of a name in a modification: any languages, each a text of 1 to {@link MAX_NAME_LENGTH} characters, or `null` to remove that language. */
export function nameTextsPatch(): Schema<Record<string, string | null>, false> {
  return record(nullable(string({ min: 1, max: MAX_NAME_LENGTH, trim: true, pattern: NO_CONTROL })), { max: MAX_TEXT_LANGUAGES, key: LANGUAGE_KEY });
}

/** The texts by language of a description: each text of at most {@link MAX_DESCRIPTION_LENGTH} characters, possibly empty. */
export function descriptionTexts(): Schema<Record<string, string>, false> {
  return record(string({ max: MAX_DESCRIPTION_LENGTH, trim: true, pattern: NO_CONTROL_EXCEPT_LINES }), { max: MAX_TEXT_LANGUAGES, key: LANGUAGE_KEY });
}

/** The texts by language of a description in a modification: any languages, or `null` to remove that language. */
export function descriptionTextsPatch(): Schema<Record<string, string | null>, false> {
  return record(nullable(string({ max: MAX_DESCRIPTION_LENGTH, trim: true, pattern: NO_CONTROL_EXCEPT_LINES })), { max: MAX_TEXT_LANGUAGES, key: LANGUAGE_KEY });
}

/**
 * The texts by language of a stored value, read tolerantly: the entries whose key looks like a language code and whose value is a text; anything else (a name that is a string, a value that
 * is a number) is left out.
 *
 * @param raw The stored value, of any type.
 * @returns The texts, empty when the value holds none.
 */
export function textsOf(raw: unknown): Texts {
  return isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && STORED_LANGUAGE_KEY.test(entry[0]))) : {};
}

/**
 * The stored texts after a modification: the languages of the request are set (or removed when `null`) and the other ones the document has, and any other key it holds, stay.
 *
 * @param stored The stored value, of any type (a value that is not an object is replaced).
 * @param request The languages to set or to remove.
 * @returns The new stored value.
 */
export function mergeTexts(stored: unknown, request: TextsPatch): Document {
  const merged: Document = isRecord(stored) ? { ...stored } : {};
  for (const [language, text] of Object.entries(request)) {
    if (text === null) {
      delete merged[language];
    } else {
      merged[language] = text;
    }
  }
  return merged;
}

/**
 * The problems of the languages of a write: every language the write sets that the group does not have (a language that is already stored with the same text is not judged again, so an old
 * stale language never blocks an unrelated change).
 *
 * @param field Field of the request, for the error.
 * @param request The languages the request sets (`null` values only remove).
 * @param stored The stored value.
 * @param languages The languages of the group.
 * @returns A `field.<language>` `incorrect` detail for each language outside the group.
 */
export function languageIssues(field: string, request: TextsPatch, stored: unknown, languages: ReadonlySet<string>): ErrorDetail[] {
  const current = textsOf(stored);
  return Object.entries(request)
    .filter(([language, text]) => text !== null && !languages.has(language) && current[language] !== text)
    .map(([language]) => ({ field: `${field}.${language}`, issue: 'incorrect' }));
}

/**
 * The language a name is required in: the language of the caller when the group has it, the first language of the group otherwise.
 *
 * @param caller The language of the caller (from his settings).
 * @param languages The languages of the group, in order, at least one.
 */
export function requiredLanguage(caller: string, languages: readonly string[]): string {
  return languages.includes(caller) ? caller : languages[0]!;
}

/**
 * The languages of a group as its `settings.languages` stores them (`it;en`, or a list in a document written by hand): the valid codes in order, without repetitions, `it` when the group lists none.
 *
 * @param raw The stored value, of any type.
 * @returns At least one language.
 */
export function groupLanguagesOf(raw: unknown): string[] {
  const parts = typeof raw === 'string' ? raw.split(';') : Array.isArray(raw) ? (raw as unknown[]) : [];
  const codes = parts.flatMap((part) => (typeof part === 'string' && LANGUAGE_KEY.test(part.trim().toLowerCase()) ? [part.trim().toLowerCase()] : []));
  return codes.length === 0 ? ['it'] : [...new Set(codes)];
}

/**
 * The search by name: the search text, as literal text (every character that a regular expression would read is escaped), is looked for, case-insensitive, in the text of every language of the name.
 *
 * @param text The search text of the client.
 * @returns A filter on the name of the documents.
 */
export function nameSearch(text: string): Filter<Document> {
  return {
    $expr: {
      $anyElementTrue: {
        $map: {
          input: { $objectToArray: { $cond: [{ $eq: [{ $type: '$name' }, 'object'] }, '$name', {}] } },
          as: 'entry',
          in: { $regexMatch: { input: { $cond: [{ $eq: [{ $type: '$$entry.v' }, 'string'] }, '$$entry.v', ''] }, regex: { $literal: escapeRegExp(text) }, options: 'i' } },
        },
      },
    },
  };
}
