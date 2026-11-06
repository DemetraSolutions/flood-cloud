import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { sendData } from './envelope.ts';

/** `Cache-Control` of a revalidated resource: the browser may keep a copy for the signed-in user only and must ask the server before every use. */
export const REVALIDATE_CACHE_CONTROL = 'private, no-cache';

/**
 * Serializes a JSON value with the keys of every object in alphabetical order, so that two values with
 * the same content give the same text whatever the order they were built in.
 *
 * @param value A JSON-like value (no `undefined` inside arrays, no cycles).
 * @returns Its canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The weak entity tag of a response payload: SHA-256 of its canonical JSON in base64url. Weak because it
 * says the content is equivalent, not that the bytes are identical (compression may change them).
 *
 * @param data The payload, already in its public representation.
 * @returns The tag, for example `W/"3f2a…"`.
 */
export function etagOf(data: unknown): string {
  return `W/"${createHash('sha256').update(canonicalJson(data)).digest('base64url')}"`;
}

/** The `If-None-Match` header matches a tag with the weak comparison: `*`, or one of the listed tags, `W/` ignored. */
function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  return header.trim() === '*' || header.split(',').some((candidate) => opaque(candidate) === opaque(etag));
}

/**
 * Sends a `{ data }` envelope with an `ETag` and `Cache-Control: private, no-cache` (revalidation is
 * mandatory; the default of the API is `no-store`, which this resource deliberately relaxes). When the request
 * carries a matching `If-None-Match` the answer is `304 Not Modified` with no body. Only the resources that
 * are cached by the backoffice use this; every other response stays without `ETag`.
 *
 * @param req Express request.
 * @param res Express response.
 * @param data Payload; it must already be mapped to its public representation.
 */
export function sendRevalidated(req: Request, res: Response, data: unknown): void {
  const etag = etagOf(data);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
  if (matches(req.get('if-none-match'), etag)) {
    res.status(304).end();
    return;
  }
  sendData(res, data);
}
