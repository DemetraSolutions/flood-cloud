import { createHmac, hkdfSync } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from './errors.ts';
import { canonicalJson } from './etag.ts';

/** How long a finished response is kept for a retry (the TTL index of `idempotencyKeys` removes it afterwards): 24 hours. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a request that never finished (a crash) keeps its key reserved. */
export const IDEMPOTENCY_IN_PROGRESS_MS = 5 * 60 * 1000;

/** MongoDB duplicate key error code. */
const DUPLICATE_KEY = 11000;

/** The `Idempotency-Key` header: a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The response of a request that finished, as it is replayed. */
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
  readonly location: string | null;
  readonly etag: string | null;
}

/** What identifies a request for idempotency: who sent it, to which route, with which key and body. */
export interface IdempotencyRequest {
  /** The user (hexadecimal id): keys are scoped per user. */
  readonly principal: string;
  /** Method and concrete path: keys are scoped per route. */
  readonly route: string;
  /** The key sent by the client, in lower case. */
  readonly key: string;
  /** Keyed fingerprint (HMAC-SHA256, hexadecimal) of the canonical JSON of the body: see {@link IdempotencyStore.fingerprint}. */
  readonly bodyHash: string;
}

/** The result of {@link IdempotencyStore.begin}. */
export type IdempotencyBegin =
  /** First time: the request runs; `id` is handed back to `complete` or `abandon`. */
  | { readonly kind: 'new'; readonly id: ObjectId }
  /** Same key and same body, already answered: the stored response is replayed. */
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  /** Same key, different body. */
  | { readonly kind: 'mismatch' }
  /** Same key and body, the first request is still running. */
  | { readonly kind: 'busy' };

/** The record of the keys in use (`common.idempotencyKeys`): a unique index on principal, route and key makes the first request win. */
export interface IdempotencyStore {
  /**
   * The fingerprint of a body: HMAC-SHA256 of its canonical JSON with a key of the server. Not a plain hash on purpose: a body can carry a secret (the provisional password of the
   * administrator of a new customer), and an unkeyed hash kept in the database would let whoever reads it guess the secret offline.
   */
  fingerprint(body: unknown): string;
  /** Reserves the key for a request, or says what the key already stands for. */
  begin(request: IdempotencyRequest): Promise<IdempotencyBegin>;
  /** Keeps the response of a finished request for 24 hours. */
  complete(id: ObjectId, response: StoredResponse): Promise<void>;
  /** Releases the key of a request that failed, so the client can retry. */
  abandon(id: ObjectId): Promise<void>;
}

interface KeyDocument extends IdempotencyRequest {
  _id: ObjectId;
  state: 'inProgress' | 'done';
  response?: StoredResponse;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * The key of the body fingerprints, derived with HKDF-SHA256 from `VERSION_HMAC_KEY` under its own label, so no new variable is needed and the key is never the one that signs the
 * versions. Records written with the previous (unkeyed SHA-256) fingerprint are never matched again: they expire with their 24 hours.
 *
 * @param versionKey The decoded `VERSION_HMAC_KEY`.
 * @returns 32 bytes.
 */
export function idempotencyBodyKey(versionKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', versionKey, '', 'flood/idempotency-body/v1', 32));
}

/**
 * Builds the store over `common.idempotencyKeys`.
 *
 * @param databases Database accessor.
 * @param bodyKey Key of the body fingerprints ({@link idempotencyBodyKey}).
 * @param now Clock in milliseconds (the system clock by default).
 */
export function createIdempotencyStore(databases: Databases, bodyKey: Buffer, now: () => number = Date.now): IdempotencyStore {
  const keys = () => databases.common().collection<KeyDocument>('idempotencyKeys');
  const begin = async (request: IdempotencyRequest): Promise<IdempotencyBegin> => {
    const at = now();
    const id = new ObjectId();
    try {
      await keys().insertOne({ _id: id, ...request, state: 'inProgress', createdAt: new Date(at), expiresAt: new Date(at + IDEMPOTENCY_IN_PROGRESS_MS) });
      return { kind: 'new', id };
    } catch (error) {
      if ((error as { code?: unknown }).code !== DUPLICATE_KEY) {
        throw error;
      }
    }
    const { principal, route, key } = request;
    const existing = await keys().findOne({ principal, route, key });
    // Gone in the meantime, or past its time and not yet removed by the TTL index: the key is free again.
    if (existing === null || existing.expiresAt.getTime() <= at) {
      if (existing !== null) {
        await keys().deleteOne({ _id: existing._id });
      }
      return begin(request);
    }
    if (existing.bodyHash !== request.bodyHash) {
      return { kind: 'mismatch' };
    }
    return existing.state === 'done' ? { kind: 'replay', response: existing.response as StoredResponse } : { kind: 'busy' };
  };
  return {
    fingerprint: (body) => createHmac('sha256', bodyKey).update(canonicalJson(body)).digest('hex'),
    begin,
    complete: async (id, response) => {
      await keys().updateOne({ _id: id }, { $set: { state: 'done', response, expiresAt: new Date(now() + IDEMPOTENCY_TTL_MS) } });
    },
    abandon: async (id) => {
      await keys().deleteOne({ _id: id });
    },
  };
}

const headerOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Makes a creation idempotent (`doc/API-Guidelines.md` section 6): wraps the handler of a `POST`. The `Idempotency-Key` header (a UUID) is required (`422`, `required` or `format`); the
 * same key with the same body answers again what the first request answered (status, body, `Location`, `ETag`); the same key with another body, or while the first request is still running,
 * is `409`. Keys are scoped per user and per route, and only a successful response is kept: a failure releases the key. It runs after the validation of the body, so what is hashed is a body the route accepts.
 *
 * @param store The record of the keys.
 * @param handler The handler of the route.
 */
export function idempotent(store: IdempotencyStore, handler: RequestHandler): RequestHandler {
  return async (req: Request, res, next) => {
    const raw = req.get('idempotency-key');
    if (raw === undefined) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'Idempotency-Key', issue: 'required' }] });
    }
    if (!UUID.test(raw.trim())) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'Idempotency-Key', issue: 'format' }] });
    }
    const begun = await store.begin({
      principal: res.locals.auth!.userId.toHexString(),
      route: `${req.method} ${req.baseUrl}${req.path}`,
      key: raw.trim().toLowerCase(),
      bodyHash: store.fingerprint(req.body ?? null),
    });
    if (begun.kind === 'replay') {
      const { status, body, location, etag } = begun.response;
      if (location !== null) {
        res.setHeader('Location', location);
      }
      if (etag !== null) {
        res.setHeader('ETag', etag);
      }
      res.status(status).json(body);
      return;
    }
    if (begun.kind === 'mismatch') {
      throw new AppError('CONFLICT', { details: [{ field: 'Idempotency-Key', issue: 'reused' }] });
    }
    if (begun.kind === 'busy') {
      throw new AppError('CONFLICT');
    }
    let captured: StoredResponse | null = null;
    const send = res.json.bind(res) as (body: unknown) => typeof res;
    res.json = (body: unknown) => {
      captured = { status: res.statusCode, body, location: headerOf(res.getHeader('Location')), etag: headerOf(res.getHeader('ETag')) };
      return send(body);
    };
    try {
      await handler(req, res, next);
    } catch (error) {
      await store.abandon(begun.id);
      throw error;
    }
    const answer = captured as StoredResponse | null;
    await (answer !== null && answer.status < 300 ? store.complete(begun.id, answer) : store.abandon(begun.id));
  };
}
