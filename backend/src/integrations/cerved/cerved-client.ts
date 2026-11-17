import type { Secret } from '../../shared/security/secret.ts';
import { CervedError } from './cerved-error.ts';
import { getJson } from './http.ts';
import type { HttpOptions } from './http.ts';

/** Longest text taken from an answer of the provider. */
const MAX_TEXT = 300;

/** Longest e-mail address (RFC 5321). */
const MAX_EMAIL = 254;

/** The identifier the provider gives to a subject: letters, digits, dashes and underscores. */
const SUBJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the provider says about a company, with every text trimmed and an absent or empty one `null`. */
export interface CervedCompany {
  /** The identifier of the subject at the provider, `null` when the answer has none usable (the profile cannot then be asked). */
  readonly subjectId: string | null;
  /** Always equal to the VAT number that was searched. */
  readonly vatNumber: string;
  readonly name: string | null;
  readonly fiscalCode: string | null;
  readonly street: string | null;
  readonly postcode: string | null;
  readonly city: string | null;
  /** As the provider gives it (the province code in the usual case): the caller decides whether it is one. */
  readonly province: string | null;
}

/** The company data of Cerved, behind an interface of the domain: nothing of the provider (URLs, field names, the key) shows through it. */
export interface CervedClient {
  /** `false` when there is no key: the other methods then throw `configuration`. */
  readonly available: boolean;
  /**
   * Searches a company by its VAT number. Of the subjects the provider returns, only the one whose VAT number is **exactly** the requested one counts.
   *
   * @param vatNumber Eleven digits.
   * @returns The company, or `null` when the provider has none with that VAT number.
   * @throws {CervedError} `configuration`, `timeout`, `network`, `status`, `tooLarge` or `malformed` (the answer is not an object with a list of companies).
   */
  findCompanyByVat(vatNumber: string): Promise<CervedCompany | null>;
  /**
   * Reads the certified e-mail address (PEC) of a subject from its profile.
   *
   * @param subjectId The `subjectId` of a {@link CervedCompany}.
   * @returns The address, or `null` when the profile has none.
   * @throws {CervedError} `configuration`, `timeout`, `network`, `status`, `tooLarge` or `malformed`.
   */
  findPec(subjectId: string): Promise<string | null>;
}

/** Settings of {@link createCervedClient}. */
export interface CervedClientOptions extends HttpOptions {
  /** The key of the account, `null` when not configured. */
  readonly apiKey: Secret | null;
  /** Base URL, validated by the configuration (`CERVED_BASE_URL`), without trailing slash. */
  readonly baseUrl: string;
}

/** A plain object, or `null`. */
function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A trimmed text of at most {@link MAX_TEXT} characters, `null` when the value is not a text or is empty. */
function textOf(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
  return text === '' ? null : text;
}

/** The subject identifier of an answer: a text or a safe integer, only of the allowed characters. */
function subjectIdOf(value: unknown): string | null {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : textOf(value);
  return id !== null && SUBJECT_ID.test(id) ? id : null;
}

/**
 * Builds the Cerved client. The URLs are made with `URLSearchParams`, so a value can never add a parameter or a path.
 *
 * @param options Key, base URL and the collaborators a test replaces.
 */
export function createCervedClient(options: CervedClientOptions): CervedClient {
  const { apiKey, baseUrl, ...http } = options;
  const keyed = (): string => {
    if (apiKey === null) {
      throw new CervedError('request', 'configuration');
    }
    return apiKey.reveal();
  };
  return {
    available: apiKey !== null,

    findCompanyByVat: async (vatNumber) => {
      const key = keyed();
      const body = objectOf(await getJson(http, 'search', `${baseUrl}/cervedApi/v1/entitySearch/live?${new URLSearchParams({ testoricerca: vatNumber }).toString()}`, key));
      const companies = body?.['companies'];
      if (!Array.isArray(companies)) {
        throw new CervedError('search', 'malformed');
      }
      for (const entry of companies) {
        const data = objectOf(objectOf(entry)?.['dati_anagrafici']);
        if (data !== null && textOf(data['partita_iva']) === vatNumber) {
          const address = objectOf(data['indirizzo']);
          return {
            subjectId: subjectIdOf(data['id_soggetto']),
            vatNumber,
            name: textOf(data['denominazione']),
            fiscalCode: textOf(data['codice_fiscale']),
            street: textOf(address?.['descrizione']),
            postcode: textOf(address?.['cap']),
            city: textOf(address?.['descrizione_comune']),
            province: textOf(address?.['provincia']),
          };
        }
      }
      return null;
    },

    findPec: async (subjectId) => {
      const key = keyed();
      const body = objectOf(await getJson(http, 'profile', `${baseUrl}/cervedApi/v1/entityProfile/live?${new URLSearchParams({ id_soggetto: subjectId }).toString()}`, key));
      const emails = objectOf(objectOf(body?.['dati_anagrafici'])?.['pec'])?.['email'];
      const first = Array.isArray(emails) ? textOf(emails[0]) : null;
      return first !== null && first.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+$/.test(first) ? first : null;
    },
  };
}
