import { randomUUID } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import { userName } from './backoffice.ts';
import type { Backoffice } from './backoffice.ts';

/** A response with its JSON body read. */
export interface Reply<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/** What a failed response says: status, code and details. */
export interface Failure {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
}

/** The creations of companies, places and groups (and the duplication of a place) need an `Idempotency-Key`: a request of the tests gets a fresh one unless it brings its own. */
const IDEMPOTENT = /\/(?:companies|places|groups|email-templates|product-departments|product-brands|product-attribute-groups|product-categories)(?:\/[0-9a-f]{24}\/duplicate)?$/;
function withKey(method: string, path: string, headers: Record<string, string> | undefined): Record<string, string> | undefined {
  return method === 'POST' && IDEMPOTENT.test(path) && !Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'idempotency-key') ? { ...headers, 'idempotency-key': randomUUID() } : headers;
}

/**
 * Acting as the users of the seeded cluster: one login per user, then plain requests.
 *
 * @param office The running backoffice.
 */
export function actors(office: Backoffice) {
  const tokens = new Map<string, string>();
  const tokenOf = async (actor: ObjectId): Promise<string> => {
    const key = actor.toHexString();
    if (!tokens.has(key)) {
      tokens.set(key, (await office.tokens(userName(actor))).accessToken);
    }
    return tokens.get(key)!;
  };
  /** A request as `actor`, with its JSON body read (`undefined` for an empty one). */
  const call = async (actor: ObjectId, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<any>> => {
    const response = await office.call(method, path, await tokenOf(actor), body, withKey(method, path, headers));
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
  };
  /** The error part of a reply. */
  const failure = (reply: Reply<any>): Failure => ({ status: reply.status, code: reply.body?.error?.code, details: reply.body?.error?.details });
  return { tokenOf, call, failure };
}

/** The `fetch` of a request as a user with a given access token, body read. */
export async function send(office: Backoffice, method: string, path: string, accessToken: string | undefined, body?: unknown): Promise<Reply<any>> {
  const response = await office.call(method, path, accessToken, body);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
}
