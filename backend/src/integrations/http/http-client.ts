import { setTimeout as delay } from 'node:timers/promises';
import { ProviderHttpError } from './http-error.ts';

/** Timeout of one attempt, the body included. */
export const ATTEMPT_TIMEOUT_MS = 8_000;

/** Deadline of the whole call, with its retry. */
export const TOTAL_TIMEOUT_MS = 20_000;

/** Largest answer the client reads: the answers of the providers are small documents, so anything bigger is not what was asked for. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Most retries of a call, whatever the option asks. */
export const MAX_RETRIES = 1;

/** The statuses worth a second try of a `GET`: the provider or a proxy in front of it is not ready. */
export const RETRYABLE_STATUSES: readonly number[] = Object.freeze([502, 503, 504]);

/** Pause before a retry: this much, plus a random part of the same size (jitter). */
export const RETRY_BASE_DELAY_MS = 200;

/** The collaborators and limits of {@link createHttpClient}; every one but `provider` and `baseUrl` is there for a test or a provider with other needs. */
export interface HttpClientOptions {
  /** Name of the provider, for the errors and the logs of the caller. */
  readonly provider: string;
  /** The configured base URL: every URL of the client must have its origin, and so must the URL the answer comes from. */
  readonly baseUrl: string;
  /** The `fetch` to use; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Timeout of one attempt (the body included) in milliseconds, {@link ATTEMPT_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number;
  /** Deadline of the whole call in milliseconds, {@link TOTAL_TIMEOUT_MS} by default. */
  readonly totalTimeoutMs?: number;
  /** Largest answer body in bytes, {@link MAX_BODY_BYTES} by default. */
  readonly maxBodyBytes?: number;
  /** Retries of an idempotent `GET` (0 or {@link MAX_RETRIES}, which is the default); a `POST` is never retried. */
  readonly retries?: 0 | 1;
  /** Clock in epoch milliseconds, `Date.now` by default. */
  readonly now?: () => number;
  /** Pause for this many milliseconds, a real timer by default. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Random number in `[0, 1)`, `Math.random` by default (jitter only, never a secret). */
  readonly random?: () => number;
}

/** One call of the client. */
export interface HttpRequest {
  /** What the caller is doing, for the error. */
  readonly operation: string;
  /** Full URL, already encoded, with the origin of the base URL. */
  readonly url: string;
  /** Request headers (a key or a token goes here and nowhere else). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A `POST` of a JSON document. */
export interface HttpPostRequest extends HttpRequest {
  /** The document to send; serialized by the client. */
  readonly body: unknown;
}

/** A client for the JSON API of one provider. */
export interface HttpClient {
  /**
   * `GET` of a JSON document. Retried once, with jitter, on a network error, a timeout or a `502`, `503` or `504` (unless `retries` is 0 and while the total deadline allows it).
   *
   * @param request The call.
   * @returns The parsed JSON, of any shape: the caller checks it.
   * @throws {ProviderHttpError} `network`, `timeout`, `status`, `tooLarge` or `invalidResponse`.
   */
  getJson(request: HttpRequest): Promise<unknown>;
  /**
   * `POST` of a JSON document. One attempt only: a `POST` is not idempotent (an activation, a token request), so it is never retried.
   *
   * @param request The call and its body.
   * @returns The parsed JSON, of any shape: the caller checks it.
   * @throws {ProviderHttpError} `network`, `timeout`, `status`, `tooLarge` or `invalidResponse`.
   */
  postJson(request: HttpPostRequest): Promise<unknown>;
}

/** The media types that declare JSON: `application/json` and the `+json` family, parameters ignored. */
function isJson(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
}

/** The origin of a URL, `null` when the text is not a URL (the error that would say so repeats the text, which may hold a key). */
function originOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).origin : null;
}

/**
 * Builds the HTTP client of one provider. Every call is: one attempt with its own timeout (the body included) inside a total deadline, redirects refused, an origin that is the
 * configured one (the URL sent and the one answered from), a successful answer that declares JSON and is read up to a limit, and the body of a failed answer never read.
 *
 * @param options The provider, the base URL and the collaborators a test replaces.
 * @returns The client.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const { provider, baseUrl } = options;
  const send = options.fetch ?? fetch;
  const attemptTimeout = options.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const totalTimeout = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const retries = options.retries ?? MAX_RETRIES;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const random = options.random ?? Math.random;
  const origin = new URL(baseUrl).origin;

  /** A failure of the transport: a timeout, or anything else (connection refused, reset, refused redirect). */
  const transportFailure = (operation: string, error: unknown): ProviderHttpError =>
    new ProviderHttpError(provider, operation, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');

  /** Cancels a body stream that is not going to be read; a failure to do so is a failure of the transport. */
  const release = async (operation: string, body: ReadableStream<Uint8Array> | null): Promise<void> => {
    try {
      await body?.cancel();
    } catch (error) {
      throw transportFailure(operation, error);
    }
  };

  /** Reads a body up to the limit; the stream is cancelled as soon as it goes beyond. */
  const readCapped = async (operation: string, response: Response): Promise<string> => {
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBody) {
      await release(operation, response.body);
      throw new ProviderHttpError(provider, operation, 'tooLarge');
    }
    if (response.body === null) {
      throw new ProviderHttpError(provider, operation, 'invalidResponse');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > maxBody) {
          await reader.cancel();
          throw new ProviderHttpError(provider, operation, 'tooLarge');
        }
        chunks.push(value);
      }
    } catch (error) {
      throw error instanceof ProviderHttpError ? error : transportFailure(operation, error);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  /** One attempt: the request, the checks on the answer, the body. */
  const attempt = async (method: 'GET' | 'POST', request: HttpRequest, body: string | undefined, deadline: AbortSignal): Promise<unknown> => {
    const { operation, url } = request;
    const signal = AbortSignal.any([AbortSignal.timeout(attemptTimeout), deadline]);
    const headers: Record<string, string> = { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...request.headers };
    let response: Response;
    try {
      response = await send(url, { method, redirect: 'error', headers, signal, ...(body === undefined ? {} : { body }) });
    } catch (error) {
      throw transportFailure(operation, error);
    }
    if (!response.ok) {
      // The answer is already a failure: a stream that cannot be cancelled must not change which one (it is dropped with the response).
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderHttpError(provider, operation, 'status', response.status);
    }
    if (response.url !== '' && originOf(response.url) !== origin) {
      await release(operation, response.body);
      throw new ProviderHttpError(provider, operation, 'invalidResponse');
    }
    if (!isJson(response.headers.get('content-type'))) {
      await release(operation, response.body);
      throw new ProviderHttpError(provider, operation, 'invalidResponse');
    }
    const text = await readCapped(operation, response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderHttpError(provider, operation, 'invalidResponse');
    }
  };

  /** Whether a failed attempt of a `GET` deserves another one. */
  const retryable = (error: ProviderHttpError): boolean =>
    error.reason === 'network' || error.reason === 'timeout' || (error.reason === 'status' && RETRYABLE_STATUSES.includes(error.status as number));

  const call = async (method: 'GET' | 'POST', request: HttpRequest, body?: string): Promise<unknown> => {
    if (originOf(request.url) !== origin) {
      throw new ProviderHttpError(provider, request.operation, 'invalidResponse');
    }
    const started = now();
    const deadline = AbortSignal.timeout(totalTimeout);
    const maxRetries = method === 'GET' ? retries : 0;
    let tried = 0;
    for (;;) {
      try {
        return await attempt(method, request, body, deadline);
      } catch (error) {
        const pause = RETRY_BASE_DELAY_MS * (1 + random());
        // Every failure of an attempt is a ProviderHttpError: nothing else is thrown inside it.
        if (tried >= maxRetries || !retryable(error as ProviderHttpError) || now() - started + pause >= totalTimeout) {
          throw error;
        }
        tried += 1;
        await sleep(pause);
      }
    }
  };

  return {
    getJson: (request) => call('GET', request),
    postJson: (request) => call('POST', request, JSON.stringify(request.body)),
  };
}
