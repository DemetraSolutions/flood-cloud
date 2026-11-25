import { requestWithRetry } from './http.ts';
import type { HttpOptions } from './http.ts';
import { OAUTH_TOKEN_URL, signAssertion } from './service-account.ts';
import type { ServiceAccount } from './service-account.ts';
import { StorageError } from './storage-error.ts';

/** URL of the metadata server of Google Cloud (GKE Workload Identity), from which a token is read. */
export const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** The token is renewed this long before it expires (at most half of its life, so a short-lived token is still cached). */
const RENEW_MARGIN_MS = 60_000;

/** Gives the access token the storage calls send as `Authorization: Bearer`. */
export interface TokenProvider {
  /**
   * @returns A valid access token. It is a credential: never log it.
   * @throws {StorageError} `auth`, `timeout`, `network` or `status` when none can be had.
   */
  token(): Promise<string>;
  /** Forgets the cached token (the storage refused it): the next call fetches a new one. */
  invalidate(): void;
}

/** A token as the endpoints give it. */
interface Fetched {
  readonly token: string;
  readonly expiresInSeconds: number;
}

/** Time source in epoch milliseconds. */
export type Clock = () => number;

/**
 * Keeps a token until 60 seconds before it expires. Callers that arrive while a token is being fetched share that one fetch (one in flight at a time),
 * and a failed fetch is not remembered: the next caller tries again.
 */
function cached(fetchToken: () => Promise<Fetched>, now: Clock): TokenProvider {
  let current: { readonly token: string; readonly validUntil: number } | null = null;
  let inFlight: Promise<string> | null = null;
  return {
    token: () => {
      if (current !== null && now() < current.validUntil) {
        return Promise.resolve(current.token);
      }
      inFlight ??= fetchToken()
        .then((fetched) => {
          const life = fetched.expiresInSeconds * 1000;
          current = { token: fetched.token, validUntil: now() + Math.max(life - RENEW_MARGIN_MS, life / 2) };
          return fetched.token;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    invalidate: () => {
      current = null;
    },
  };
}

/** Reads `access_token` and `expires_in` from the JSON answer of a token endpoint. */
async function readToken(response: Response): Promise<Fetched> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new StorageError('token', 'auth', response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new StorageError('token', 'malformed');
  }
  const { access_token: token, expires_in: expiresIn } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof token !== 'string' || token === '' || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new StorageError('token', 'malformed');
  }
  return { token, expiresInSeconds: expiresIn };
}

/** Options of the token providers. The URLs are fixed constants in production; only a test overrides them, never the environment. */
export interface TokenOptions extends HttpOptions {
  /** Clock in epoch milliseconds; `Date.now` by default. */
  readonly now?: Clock;
  /** Where the token is read (metadata) or exchanged (service account); the real endpoints by default. */
  readonly url?: string;
}

/**
 * Tokens from the metadata server of Google Cloud, which is how a pod with Workload Identity authenticates: a `GET` with `Metadata-Flavor: Google`.
 *
 * @param options Collaborators.
 */
export function createMetadataTokenProvider(options: TokenOptions = {}): TokenProvider {
  return cached(async () => {
    const { response } = await requestWithRetry(options, 'token', options.url ?? METADATA_TOKEN_URL, { method: 'GET', headers: { 'Metadata-Flavor': 'Google' } });
    return readToken(response);
  }, options.now ?? Date.now);
}

/**
 * Tokens from a service account: a signed JWT exchanged, only at {@link OAUTH_TOKEN_URL}, for an access token.
 *
 * @param account The account read from the credentials file.
 * @param options Collaborators.
 */
export function createServiceAccountTokenProvider(account: ServiceAccount, options: TokenOptions = {}): TokenProvider {
  const now = options.now ?? Date.now;
  return cached(async () => {
    const assertion = signAssertion(account, Math.floor(now() / 1000));
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
    const { response } = await requestWithRetry(options, 'token', options.url ?? OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return readToken(response);
  }, now);
}
