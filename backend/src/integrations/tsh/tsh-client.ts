import { createHash, randomUUID } from 'node:crypto';
import type { TshCategory } from '../../shared/integrations/ports.ts';
import { createHttpClient, ProviderHttpError } from '../http/index.ts';
import type { HttpClient, HttpClientOptions } from '../http/index.ts';

/** Path of the nonce on the authentication service. */
const NONCES_PATH = '/api/v3/nonces';

/** Path of the access token on the authentication service. */
const TOKENS_PATH = '/api/v3/tokens';

/** The identifier of a property of the hotel system: the form the place stores (letters, digits, dashes and underscores). It goes in a path segment. */
const PROPERTY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A nonce: a printable text without spaces. */
const NONCE = /^[\x21-\x7e]{1,256}$/;

/** An access token as it travels in a header: the characters of a bearer token (a JWT included), of a sensible length. Anything else is not sent. */
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,4096}$/;

/** Most categories an answer may list. */
const MAX_CATEGORIES = 500;

/** The application name and version the provider's integration expects on every call. */
const APP_HEADERS = { 'x-app-name': 'TS320', 'x-app-version': '1.0.0' } as const;

/** The credentials of a property: the ones the place stores. */
export interface TshCredentials {
  readonly id: string;
  readonly secret: string;
  readonly propertyId: string;
  /** `true`: the test environment of the provider. */
  readonly testMode: boolean;
}

/** The categories of charge of TS Hospitality behind an interface of the domain. */
export interface TshClient {
  /** `false` when the platform has no hosts for the provider: the synchronization is then off. */
  readonly available: boolean;
  /** `true` when the platform also has the hosts of the test environment (a place in test mode needs them). */
  readonly testAvailable: boolean;
  /**
   * Lists the categories of charge of a property: asks for a nonce, derives the digest of the credentials, exchanges it for an access token and reads the categories with it. The nonce and the token live for this
   * call only: they are not kept and never logged. The authentication calls are `POST`s and are never repeated; the read is a `GET` and may be repeated once.
   *
   * @param credentials The credentials of the place.
   * @returns The categories (`id`, `name`).
   * @throws {Error} The property identifier is not in the form of the field (the port checks it first, so this is a programming error).
   * @throws {ProviderHttpError} `network`, `timeout`, `status` (`401` or `403` for credentials the provider refused), `tooLarge` or `invalidResponse` (a nonce, a token or a list that is not in the form expected).
   */
  listChargeCategories(credentials: TshCredentials): Promise<TshCategory[]>;
}

/** The collaborators of the HTTP calls of the client that a test replaces. */
export type TshHttpOptions = Pick<HttpClientOptions, 'fetch' | 'timeoutMs' | 'totalTimeoutMs' | 'maxBodyBytes' | 'now' | 'sleep' | 'random'>;

/** Settings of {@link createTshClient}. */
export interface TshClientOptions extends TshHttpOptions {
  /** The hosts of the production environment; `null` when not configured. */
  readonly authBaseUrl: string | null;
  readonly apiBaseUrl: string | null;
  /** The hosts of the test environment; `null` when not configured. */
  readonly testAuthBaseUrl: string | null;
  readonly testApiBaseUrl: string | null;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The digest of the credentials for a nonce: `sha256(lowercase(sha256(lowercase(id) + secret)) + nonce)`, in hexadecimal. */
export function tshDigest(id: string, secret: string, nonce: string): string {
  return sha256(sha256(id.toLowerCase() + secret).toLowerCase() + nonce);
}

/** The text of a value that is a non-empty text or a safe integer, `null` for anything else. */
function idText(value: unknown, max: number): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && text.trim() !== '' && text.length <= max ? text : null;
}

/**
 * The categories of an answer: a list, or an object with the list under `chargeCategories`, `categories` or `items`. Each needs an identifier and a name; one that has not, a list that is too long or
 * anything else is an answer that is not what was asked for.
 */
function categoriesOf(body: unknown): TshCategory[] | null {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const list = Array.isArray(body) ? body : (record['chargeCategories'] ?? record['categories'] ?? record['items']);
  if (!Array.isArray(list) || list.length > MAX_CATEGORIES) {
    return null;
  }
  const categories: TshCategory[] = [];
  for (const entry of list as unknown[]) {
    const category = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const id = idText(category['id'], 64);
    const name = idText(category['name'] ?? category['description'], 200);
    if (id === null || name === null) {
      return null;
    }
    categories.push({ id, name: name.trim() });
  }
  return categories;
}

/**
 * Builds the TS Hospitality client. The nonce, the token and the list use the hosts of the environment the place asks for.
 *
 * @param options The hosts of both environments and the collaborators a test replaces.
 * @returns The client.
 */
export function createTshClient(options: TshClientOptions): TshClient {
  const { authBaseUrl, apiBaseUrl, testAuthBaseUrl, testApiBaseUrl, ...collaborators } = options;
  // A host that is not configured gets a placeholder that is never called: `available` and `testAvailable` stop the service first.
  const placeholder = 'https://unconfigured.invalid';
  const clientOf = (provider: string, baseUrl: string | null): HttpClient => createHttpClient({ provider, baseUrl: baseUrl ?? placeholder, ...collaborators });
  const production = { auth: clientOf('TSH', authBaseUrl), api: clientOf('TSH', apiBaseUrl), authBase: authBaseUrl, apiBase: apiBaseUrl };
  const test = { auth: clientOf('TSH', testAuthBaseUrl), api: clientOf('TSH', testApiBaseUrl), authBase: testAuthBaseUrl, apiBase: testApiBaseUrl };
  return {
    available: authBaseUrl !== null && apiBaseUrl !== null,
    testAvailable: testAuthBaseUrl !== null && testApiBaseUrl !== null,
    listChargeCategories: async (credentials) => {
      if (!PROPERTY_ID.test(credentials.propertyId)) {
        throw new Error('The property identifier is not in the form of the field');
      }
      const hosts = credentials.testMode ? test : production;
      const correlation = { 'x-correlation-id': randomUUID() };
      const headers = { ...APP_HEADERS, ...correlation };
      const nonceBody = (await hosts.auth.postJson({ operation: 'nonce', url: `${hosts.authBase}${NONCES_PATH}`, headers, body: { id: credentials.id } })) as { nonce?: unknown } | null;
      const nonce = nonceBody?.nonce;
      if (typeof nonce !== 'string' || !NONCE.test(nonce)) {
        throw new ProviderHttpError('TSH', 'nonce', 'invalidResponse');
      }
      const digest = tshDigest(credentials.id, credentials.secret, nonce);
      const tokenBody = (await hosts.auth.postJson({ operation: 'token', url: `${hosts.authBase}${TOKENS_PATH}`, headers, body: { id: credentials.id, digest } })) as { accessToken?: unknown } | null;
      const token = tokenBody?.accessToken;
      if (typeof token !== 'string' || !TOKEN.test(token)) {
        throw new ProviderHttpError('TSH', 'token', 'invalidResponse');
      }
      const answer = await hosts.api.getJson({
        operation: 'categories',
        url: `${hosts.apiBase}/api/pms/${encodeURIComponent(credentials.propertyId)}/charge-categories`,
        headers: { ...headers, authorization: `Bearer ${token}` },
      });
      const categories = categoriesOf(answer);
      if (categories === null) {
        throw new ProviderHttpError('TSH', 'categories', 'invalidResponse');
      }
      return categories;
    },
  };
}
