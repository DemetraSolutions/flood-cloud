import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { sendData, sendPage } from './envelope.ts';
import type { PageInfo } from './envelope.ts';

/** `Cache-Control` of a revalidated resource: never stored by the browser; the backoffice keeps its own in-memory copy and revalidates it with `If-None-Match`. */
export const REVALIDATE_CACHE_CONTROL = 'no-store';

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
 * Sends a `{ data }` envelope with an `ETag` and `Cache-Control: no-store` (nothing is kept by the browser; the client revalidates its own in-memory copy, revalidation is
 * mandatory; the default of the API is `no-store`, which this resource deliberately relaxes). When the request
 * carries a matching `If-None-Match` the answer is `304 Not Modified` with no body. Only the resources that
 * are cached by the backoffice use this; every other response stays without `ETag`.
 *
 * @param req Express request.
 * @param res Express response.
 * @param data Payload; it must already be mapped to its public representation.
 */
export function sendRevalidated(req: Request, res: Response, data: unknown): void {
  sendRevalidatedWith(req, res, data, etagOf(data));
}

/**
 * Like {@link sendRevalidated}, with the tag the caller chose (the strong version of a stored document, for the resources that have one) instead of the content tag.
 *
 * @param req Express request.
 * @param res Express response.
 * @param data Payload; it must already be mapped to its public representation.
 * @param etag The complete tag, quotes (and `W/`) included.
 */
export function sendRevalidatedWith(req: Request, res: Response, data: unknown, etag: string): void {
  if (!revalidate(req, res, etag)) {
    sendData(res, data);
  }
}

/**
 * Sends a list envelope `{ data, page }` with an `ETag` and `Cache-Control: no-store`, like
 * {@link sendRevalidated}. The tag is computed on the whole body (items and pagination), so it follows the
 * page the caller asked for; the items are already filtered to the perimeter of the caller, therefore two
 * callers with different perimeters never share a tag. A matching `If-None-Match` gives `304` with no body.
 * Only the compact reference lists that the backoffice caches use this.
 *
 * @param req Express request.
 * @param res Express response.
 * @param items Items of the page, already mapped to their public representation.
 * @param page Pagination metadata.
 */
export function sendRevalidatedPage(req: Request, res: Response, items: readonly unknown[], page: PageInfo): void {
  if (!revalidate(req, res, etagOf({ data: items, page: { limit: page.limit, next: page.next } }))) {
    sendPage(res, items, page);
  }
}

/** Sets `ETag` and `Cache-Control`; answers `304` and returns `true` when `If-None-Match` matches, otherwise returns `false`. */
function revalidate(req: Request, res: Response, etag: string): boolean {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
  if (matches(req.get('if-none-match'), etag)) {
    res.status(304).end();
    return true;
  }
  return false;
}
