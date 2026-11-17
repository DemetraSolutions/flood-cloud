import { CervedError } from './cerved-error.ts';

/** Timeout of one request to the provider, with no retry. */
export const REQUEST_TIMEOUT_MS = 8_000;

/** Largest answer the adapter reads: a Cerved profile is a few kilobytes, so anything bigger is not what was asked for. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** The collaborators of every HTTP call of the adapter, all replaceable by a test. */
export interface HttpOptions {
  /** The `fetch` to use; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Timeout of one request (the body included) in milliseconds, {@link REQUEST_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number;
  /** Largest answer body in bytes, {@link MAX_BODY_BYTES} by default. */
  readonly maxBodyBytes?: number;
}

/** A failure of the transport: a timeout, or anything else (connection refused, reset, refused redirect). */
function transportFailure(operation: string, error: unknown): CervedError {
  return new CervedError(operation, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
}

/** Cancels a body stream that is not going to be read; a failure to do so is a failure of the transport. */
async function release(operation: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
  try {
    await body?.cancel();
  } catch (error) {
    throw transportFailure(operation, error);
  }
}

/** Reads a body up to `limit` bytes; the stream is cancelled as soon as it goes beyond. */
async function readCapped(operation: string, response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) {
    await release(operation, response.body);
    throw new CervedError(operation, 'tooLarge');
  }
  if (response.body === null) {
    throw new CervedError(operation, 'malformed');
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
      if (total > limit) {
        await reader.cancel();
        throw new CervedError(operation, 'tooLarge');
      }
      chunks.push(value);
    }
  } catch (error) {
    throw error instanceof CervedError ? error : transportFailure(operation, error);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `GET` of a JSON document from the provider: header `apikey`, one attempt, a deadline for the whole answer, redirects refused, the body read up to a
 * limit. The body of a failed answer is never read or kept.
 *
 * @param options Collaborators.
 * @param operation Name of the operation, for the error.
 * @param url Full URL, already encoded.
 * @param apiKey The key of the account; sent in a header and never anywhere else.
 * @returns The parsed JSON, of any shape: the caller checks it.
 * @throws {CervedError} `timeout`, `network`, `status` (not a 2xx), `tooLarge` or `malformed` (not JSON).
 */
export async function getJson(options: HttpOptions, operation: string, url: string, apiKey: string): Promise<unknown> {
  const send = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await send(url, { method: 'GET', redirect: 'error', headers: { apikey: apiKey, accept: 'application/json' }, signal });
  } catch (error) {
    throw transportFailure(operation, error);
  }
  if (!response.ok) {
    // The answer is already a failure: a stream that cannot be cancelled must not change which one (it is dropped with the response).
    await response.body?.cancel().catch(() => undefined);
    throw new CervedError(operation, 'status', response.status);
  }
  const text = await readCapped(operation, response, options.maxBodyBytes ?? MAX_BODY_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CervedError(operation, 'malformed');
  }
}
