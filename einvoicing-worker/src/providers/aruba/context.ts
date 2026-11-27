/**
 * What the Aruba operations share, and the authorized request they all make.
 *
 * @module
 */
import type { Limiters } from '../../limits/limiters.ts';
import type { Logger } from '../../logger.ts';
import type { ArubaHttpError, HttpFailure, HttpResponse } from './http.ts';
import { exchange } from './http.ts';
import type { Sessions } from './session.ts';
import type { ArubaHosts } from './settings.ts';

/** Collaborators of the upload, status and search operations. */
export interface ArubaContext {
  readonly hosts: ArubaHosts;
  readonly fetch: typeof fetch;
  readonly sessions: Sessions;
  readonly limiters: Limiters;
  readonly logger: Logger;
  readonly clock: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Timeout of the upload request and of every other request, in milliseconds. */
  readonly timeouts: { readonly upload: number; readonly request: number };
}

/** What to ask of Aruba's web services. */
export interface CallRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  /** A JSON body (sent with its content type), for a `POST`. */
  readonly json?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** What came of an authorized request. */
export type Call =
  /** Aruba answered (any status except `401`). */
  | { readonly kind: 'response'; readonly response: HttpResponse }
  /** No token (or Aruba refused it with `401`): who must wait, for how long and why. */
  | { readonly kind: 'wait'; readonly scope: 'ip' | 'account'; readonly afterMs: number; readonly code: string }
  /** The exchange failed: see {@link HttpFailure}. */
  | { readonly kind: 'failed'; readonly failure: HttpFailure };

const UNAUTHORIZED_WAIT_MS = 60_000;

/**
 * Makes a request to the web services with the hub's token. A `401` drops the access token (the refresh token is kept) and
 * asks the account to wait a minute; the next call renews the token.
 *
 * @param ctx Collaborators.
 * @param hub The hub whose token is used.
 * @param signal Aborted when the lease is lost or the worker stops.
 * @param request The request.
 * @returns The answer, who must wait, or how the exchange failed. Never throws a transport error.
 * @throws {FencedError} When a newer lease epoch owns the sign-in limiter.
 */
export async function authorizedCall(ctx: ArubaContext, hub: string, signal: AbortSignal, request: CallRequest): Promise<Call> {
  const authorization = await ctx.sessions.authorize(hub, signal);
  if (authorization.kind === 'wait') {
    return authorization;
  }
  try {
    const response = await exchange(
      { fetch: ctx.fetch, signal },
      {
        method: request.method,
        url: request.url,
        headers: {
          authorization: `Bearer ${authorization.token.reveal()}`,
          accept: 'application/json',
          ...(request.json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.json === undefined ? {} : { body: request.json }),
        timeoutMs: request.timeoutMs,
        maxBytes: request.maxBytes,
      },
    );
    if (response.status === 401) {
      ctx.sessions.dropAccessToken(hub);
      return { kind: 'wait', scope: 'account', afterMs: UNAUTHORIZED_WAIT_MS, code: 'HTTP_401' };
    }
    return { kind: 'response', response };
  } catch (error) {
    return { kind: 'failed', failure: (error as ArubaHttpError).code };
  }
}
