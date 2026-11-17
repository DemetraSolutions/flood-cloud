import { HIDDEN_CHARACTERS, object, optional, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';

/** Body limit of the writes: a code and a name. */
export const COUNTRIES_BODY_LIMIT = '2kb';

/** Longest name of a country or of a province, in characters. */
export const MAX_COUNTRY_NAME = 100;

/** Two letters: checked before they are turned into capitals, so no letter that grows when uppercased (`ß`) can be a code. */
const TWO_LETTERS = /^[A-Za-z]{2}$/;

/** A code of a country or of a province: two letters A to Z, trimmed and made uppercase (`it ` is `IT`). */
function code(): Schema<string, false> {
  return transform(string({ min: 2, max: 2, trim: true, pattern: TWO_LETTERS }), (value) => value.toUpperCase(), 'format');
}

/** A name: trimmed, 1 to 100 characters, without control characters (C0, C1), line separators, bidirectional overrides, zero-width characters or BOM (`format`), which can disguise a name. */
const name = () => refine(string({ min: 1, max: MAX_COUNTRY_NAME, trim: true }), (value) => (HIDDEN_CHARACTERS.test(value) ? [''] : []), 'format');

/** Body of `POST /v1/countries` and of `POST /v1/countries/{countryCode}/areas`: the code and the name. Nothing else is accepted. */
export const createCodedBody = object({ code: code(), name: name() });

/** Validated body of a creation. */
export type CreateCodedBody = Infer<typeof createCodedBody>;

/**
 * Body of the `PATCH` of a country and of a province: the name. The code is never changeable: a `code` is refused with `immutable` (whatever it holds), any other key with `unknown`.
 */
export const renameBody = object({ name: name(), code: optional(refine(string({ max: 64, normalize: false }), () => [''], 'immutable')) });

/** Validated body of a rename. */
export type RenameBody = Infer<typeof renameBody>;

/** Path parameters of the routes on one country. */
export const countryParams = object({ countryCode: code() }, { allowUnknown: true });

/** Path parameters of the routes on one province. */
export const areaParams = object({ countryCode: code(), areaCode: code() }, { allowUnknown: true });

/** Validated path parameters of a country. */
export type CountryParams = Infer<typeof countryParams>;

/** Validated path parameters of a province. */
export type AreaParams = Infer<typeof areaParams>;
