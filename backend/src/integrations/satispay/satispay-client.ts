import { createHttpClient, ProviderHttpError } from '../http/index.ts';
import type { HttpClientOptions } from '../http/index.ts';

/** Path of the activation of a key on the authentication service of Satispay. */
const AUTHENTICATION_KEYS_PATH = '/g_business/v1/authentication_keys';

/** Longest key id taken from an answer. */
const MAX_KEY_ID = 200;

/** The activation of a point of sale on Satispay, behind an interface of the domain. */
export interface SatispayClient {
  /** `false` when the platform has no Satispay host or no public key: the activation is then off. */
  readonly available: boolean;
  /**
   * Exchanges an activation code for the key id of the point of sale, announcing the public key of the platform. One attempt only: the code is single use, so a repeated call after a lost answer would
   * burn it, and the caller never retries.
   *
   * @param activationCode The code the shop owner generated in Satispay (already checked for its form).
   * @returns The key id.
   * @throws {ProviderHttpError} `network`, `timeout`, `status` (a code the provider refused is a `4xx` here), `tooLarge` or `invalidResponse` (no key id in the answer).
   */
  activate(activationCode: string): Promise<string>;
}

/** The collaborators of the HTTP calls of the client that a test replaces. */
export type SatispayHttpOptions = Pick<HttpClientOptions, 'fetch' | 'timeoutMs' | 'totalTimeoutMs' | 'maxBodyBytes' | 'now' | 'sleep' | 'random'>;

/** Settings of {@link createSatispayClient}. */
export interface SatispayClientOptions extends SatispayHttpOptions {
  /** One of the two hosts of Satispay (checked by the configuration); `null` when not configured. */
  readonly authBaseUrl: string | null;
  /** The public key of the platform in PEM form; `null` when not configured. */
  readonly publicKey: string | null;
}

/**
 * Builds the Satispay client.
 *
 * @param options Host, public key and the collaborators a test replaces.
 * @returns The client.
 */
export function createSatispayClient(options: SatispayClientOptions): SatispayClient {
  const { authBaseUrl, publicKey, ...collaborators } = options;
  // Without a host there is nothing to call; the placeholder is never used (`available` is false and the service stops first).
  const http = createHttpClient({ provider: 'Satispay', baseUrl: authBaseUrl ?? 'https://unconfigured.invalid', retries: 0, ...collaborators });
  return {
    available: authBaseUrl !== null && publicKey !== null,
    activate: async (activationCode) => {
      const body = (await http.postJson({ operation: 'activation', url: `${authBaseUrl}${AUTHENTICATION_KEYS_PATH}`, body: { public_key: publicKey, token: activationCode } })) as { key_id?: unknown } | null;
      const keyId = body?.key_id;
      if (typeof keyId !== 'string' || keyId === '' || keyId.length > MAX_KEY_ID) {
        throw new ProviderHttpError('Satispay', 'activation', 'invalidResponse');
      }
      return keyId;
    },
  };
}
