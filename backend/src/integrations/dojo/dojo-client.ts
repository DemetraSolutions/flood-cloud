import { createHttpClient, ProviderHttpError } from '../http/index.ts';
import type { HttpClientOptions } from '../http/index.ts';
import { CredentialFormatError } from '../provider-call.ts';

/** The characters of a Dojo key as it travels in an `Authorization` header: printable ASCII, no space. */
const API_KEY = /^[\x21-\x7e]{1,512}$/;

/** Longest text taken from an answer of the provider. */
const MAX_TEXT = 100;

/** Most terminals a list may have: a place has a handful, so a longer list is not what was asked for. */
const MAX_TERMINALS = 500;

/** A terminal of the account, as the provider lists it. */
export interface DojoTerminal {
  /** The identifier of the terminal at the provider (what the device of the place keeps as `posDojoTerminalId`). */
  readonly id: string;
  /** The serial identifier (`properties.tid`) the staff reads on the terminal. */
  readonly tid: string;
  readonly status: string;
}

/** The terminals of Dojo behind an interface of the domain. */
export interface DojoClient {
  /** `false` when the platform has no reseller or software house: the list is then off. */
  readonly available: boolean;
  /**
   * Lists the terminals of the account the key belongs to.
   *
   * @param apiKey The key of the place.
   * @returns The terminals, with the three fields the backoffice shows.
   * @throws {CredentialFormatError} The key cannot travel in a header (the provider is not called).
   * @throws {ProviderHttpError} `network`, `timeout`, `status`, `tooLarge` or `invalidResponse` (the answer is not a list of terminals).
   */
  listTerminals(apiKey: string): Promise<DojoTerminal[]>;
}

/** The collaborators of the HTTP calls of the client that a test replaces. */
export type DojoHttpOptions = Pick<HttpClientOptions, 'fetch' | 'timeoutMs' | 'totalTimeoutMs' | 'maxBodyBytes' | 'now' | 'sleep' | 'random'>;

/** Settings of {@link createDojoClient}. */
export interface DojoClientOptions extends DojoHttpOptions {
  readonly baseUrl: string;
  /** `null` when not configured. */
  readonly resellerId: string | null;
  readonly softwareHouseId: string | null;
  /** The value of the `version` header. */
  readonly apiVersion: string;
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT ? value : null);

/**
 * The list of terminals of an answer: a list, or an object with the list under `items` or `terminals`. Each terminal needs an identifier, a serial identifier and a status, all short texts; anything else
 * (an entry that is not an object, a missing field, a longer text, too long a list) is an answer that is not what was asked for.
 */
function terminalsOf(body: unknown): DojoTerminal[] | null {
  const list = Array.isArray(body) ? body : ((body ?? {}) as Record<string, unknown>)['items'] ?? ((body ?? {}) as Record<string, unknown>)['terminals'];
  if (!Array.isArray(list) || list.length > MAX_TERMINALS) {
    return null;
  }
  const terminals: DojoTerminal[] = [];
  for (const entry of list as unknown[]) {
    const terminal = (entry ?? {}) as Record<string, unknown>;
    const id = textOf(terminal['id']);
    const tid = textOf(((terminal['properties'] ?? {}) as Record<string, unknown>)['tid']);
    const status = textOf(terminal['status']);
    if (id === null || tid === null || status === null) {
      return null;
    }
    terminals.push({ id, tid, status });
  }
  return terminals;
}

/**
 * Builds the Dojo client. The list is one `GET`, so the common client may repeat it once on a transient failure.
 *
 * @param options Base URL, identifiers, version and the collaborators a test replaces.
 * @returns The client.
 */
export function createDojoClient(options: DojoClientOptions): DojoClient {
  const { baseUrl, resellerId, softwareHouseId, apiVersion, ...collaborators } = options;
  const http = createHttpClient({ provider: 'Dojo', baseUrl, ...collaborators });
  return {
    available: resellerId !== null && softwareHouseId !== null,
    listTerminals: async (apiKey) => {
      if (!API_KEY.test(apiKey)) {
        throw new CredentialFormatError();
      }
      const body = await http.getJson({
        operation: 'terminals',
        url: `${baseUrl}/terminals`,
        // The identifiers are not null here: the routes are not mounted for a provider that is off.
        headers: { authorization: `Basic ${apiKey}`, 'reseller-id': resellerId as string, 'software-house-id': softwareHouseId as string, version: apiVersion },
      });
      const terminals = terminalsOf(body);
      if (terminals === null) {
        throw new ProviderHttpError('Dojo', 'terminals', 'invalidResponse');
      }
      return terminals;
    },
  };
}
