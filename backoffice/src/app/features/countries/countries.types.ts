import { ApiError } from '../../core/api/api-error';
import { Country } from '../../core/reference/countries';

/** An area (province) of a country. */
export type CountryArea = Country['areas'][number];

/** A country as the server has it, with the version (`ETag`) to present in `If-Match`. */
export interface VersionedCountry {
  readonly country: Country;
  /** The version read, `null` when the response had none. */
  readonly etag: string | null;
}

/** Body of a country or area write: creation sends both fields, modification only the name. */
export interface CountryBody {
  code?: string;
  name?: string;
}

/** Two upper-case letters (ISO 3166-1 alpha-2 for the countries, the same format for the areas). */
export const COUNTRY_CODE = /^[A-Z]{2}$/;
/** Most characters of a name. */
export const COUNTRY_NAME_MAX = 100;
/**
 * Characters a name cannot have, the same set as the server (`HIDDEN_CHARACTERS`): C0 and C1
 * controls and DEL, the line and paragraph separators (U+2028, U+2029), the bidi controls
 * (U+202A-202E, U+2066-2069), the zero-width and directional marks (U+200B-200F, U+061C), the BOM
 * (U+FEFF) and the invisible operators (U+2060-2064).
 */
export const COUNTRY_NAME_FORBIDDEN =
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B-\u200F\u061C\uFEFF\u2060-\u2064]/;
/** Most ids the server lists in the details of a refused deletion. */
export const IN_USE_LISTED_MAX = 20;

/** Companies and places that still use a country or an area (the details of a `409`). */
export interface InUse {
  readonly companies: number;
  readonly places: number;
  /** The server lists at most {@link IN_USE_LISTED_MAX} ids per kind: the real count may be higher. */
  readonly limited: boolean;
}

/**
 * Reads the `409` of a deletion refused because the country or the area is used: the details are
 * `{ field: "companies.<id>" | "places.<id>", issue: "inUse" }`, one per company or place listed.
 *
 * @param error The caught error.
 * @returns The counts, or `null` when the error is not that refusal.
 */
export function inUseOf(error: unknown): InUse | null {
  if (!(error instanceof ApiError) || error.status !== 409) {
    return null;
  }
  const used = error.details.filter((detail) => detail.issue === 'inUse');
  if (used.length === 0) {
    return null;
  }
  const count = (kind: string): number =>
    used.filter((detail) => detail.field.split('.')[0] === kind).length;
  const companies = count('companies');
  const places = count('places');
  return {
    companies,
    places,
    limited: companies >= IN_USE_LISTED_MAX || places >= IN_USE_LISTED_MAX,
  };
}

/** Router commands of the list of the countries, or of one country. */
export function countryRoute(code?: string): string[] {
  return code === undefined ? ['/settings/countries'] : ['/settings/countries', code];
}
