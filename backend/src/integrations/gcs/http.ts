import { StorageError } from './storage-error.ts';

/** Timeout of one request to the provider. */
export const REQUEST_TIMEOUT_MS = 15_000;

/** Most attempts of one operation (the first one included). */
export const MAX_ATTEMPTS = 3;

/** Base of the exponential backoff between attempts. */
const BACKOFF_BASE_MS = 250;

/** Ceiling of the backoff. */
const BACKOFF_MAX_MS = 2_000;

/** The collaborators of every HTTP call of the adapter, all replaceable by a test. */
export interface HttpOptions {
  /** The `fetch` to use; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Timeout of one request in milliseconds, {@link REQUEST_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number;
  /** Waits between two attempts; a real timer by default. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Random number in `[0, 1)` for the jitter; `Math.random` by default. */
  readonly random?: () => number;
}

/** A response and the number of attempts it took. */
export interface Attempted {
  readonly response: Response;
  /** The attempt that gave this response, from 1. A value above 1 means an earlier attempt may have reached the server. */
  readonly attempts: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A status worth another attempt: the provider is overloaded or failing, not refusing the request. */
const isTransient = (status: number): boolean => status === 429 || status >= 500;

/**
 * Sends a request with a timeout and retries it, with exponential backoff and jitter, when the connection fails, the request times out or the
 * provider answers `429` or `5xx`, up to {@link MAX_ATTEMPTS} attempts. Any other answer (`4xx` included) is returned to the caller, who maps it. The
 * caller must only use it for operations that are safe to repeat (the uploads are, thanks to `ifGenerationMatch=0`). Redirects are never followed (an error), and a `signal` in `init` is the
 * deadline of the whole operation: when it fires the call is not retried.
 *
 * @param options Collaborators.
 * @param operation Name of the operation, for the error.
 * @param url Full URL.
 * @param init Request; the body must be repeatable (a `Buffer` or a string), never a stream.
 * @returns The response that was not transient, with the attempt that gave it.
 * @throws {StorageError} `timeout`, `network` or `status` when the last attempt also failed.
 */
export async function requestWithRetry(options: HttpOptions, operation: string, url: string, init: RequestInit): Promise<Attempted> {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const outer = init.signal ?? undefined;
  /** One attempt: the response when it is not transient, otherwise the error that describes the failure. */
  const attemptOnce = async (attempt: number): Promise<Attempted | StorageError> => {
    try {
      const response = await send(url, { ...init, redirect: 'error', signal: outer === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) });
      if (!isTransient(response.status)) {
        return { response, attempts: attempt };
      }
      // The body of a failed answer is never read or logged.
      await response.body?.cancel();
      return new StorageError(operation, 'status', response.status);
    } catch (error) {
      return new StorageError(operation, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
    }
  };
  let attempt = 1;
  let result = await attemptOnce(attempt);
  while (result instanceof StorageError) {
    if (attempt >= MAX_ATTEMPTS || outer?.aborted === true) {
      throw result;
    }
    await sleep(Math.round(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)) * (0.5 + random() * 0.5)));
    attempt += 1;
    result = await attemptOnce(attempt);
  }
  return result;
}
