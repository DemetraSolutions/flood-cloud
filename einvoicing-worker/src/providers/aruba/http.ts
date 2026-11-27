/**
 * One HTTP exchange with Aruba: native `fetch`, an explicit timeout, a cap on the size of the response and a failure that
 * says only what went wrong, never what was sent or received.
 *
 * @module
 */

/** Why an exchange failed. */
export type HttpFailure =
  /** The connection could not be made (DNS, refused, unreachable, certificate): the request never left. */
  | 'connect'
  /** The request left and no (complete) answer came in time. */
  | 'timeout'
  /** The caller's signal fired (the lease was lost or the worker is stopping). */
  | 'aborted'
  /** The connection broke, or the answer could not be read, after the request left. */
  | 'network'
  /** The answer is larger than the cap. */
  | 'tooLarge';

/** A failed exchange. The message is constant: it never carries a URL, a header or a body. */
export class ArubaHttpError extends Error {
  /** What went wrong. */
  readonly code: HttpFailure;

  constructor(code: HttpFailure) {
    super('the request to Aruba failed');
    this.name = 'ArubaHttpError';
    this.code = code;
  }
}

/** What to send. */
export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  /** The whole URL, with every query value already encoded. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Timeout of the whole exchange, response body included. */
  readonly timeoutMs: number;
  /** Largest response body read, in bytes. */
  readonly maxBytes: number;
}

/** What came back. */
export interface HttpResponse {
  readonly status: number;
  /** The body as text (empty when there is none). */
  readonly text: string;
}

/** What {@link exchange} needs. */
export interface HttpEnvironment {
  readonly fetch: typeof fetch;
  /** Aborted when the lease is lost or the worker stops. */
  readonly signal: AbortSignal;
}

/** Error codes of a connection that failed before any byte of the request was sent. */
const CONNECT_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

/** Reads a body up to `maxBytes`; larger is a failure and the stream is cancelled. */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks).toString('utf8');
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ArubaHttpError('tooLarge');
    }
    chunks.push(value);
  }
}

/**
 * Sends a request and reads the answer.
 *
 * @param env `fetch` and the signal of the lease.
 * @param request The request.
 * @returns The status and the body text, whatever the status.
 * @throws {ArubaHttpError} On a connection failure, a timeout, an abort, a broken connection or an oversized body.
 */
export async function exchange(env: HttpEnvironment, request: HttpRequest): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  try {
    const response = await env.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'error',
      signal: AbortSignal.any([env.signal, timeout]),
    });
    return { status: response.status, text: await readBody(response, request.maxBytes) };
  } catch (error) {
    if (error instanceof ArubaHttpError) {
      throw error;
    }
    if (env.signal.aborted) {
      throw new ArubaHttpError('aborted');
    }
    if (timeout.aborted) {
      throw new ArubaHttpError('timeout');
    }
    const code = ((error as { cause?: { code?: unknown } }).cause ?? {}).code;
    throw new ArubaHttpError(typeof code === 'string' && CONNECT_CODES.has(code) ? 'connect' : 'network');
  }
}
