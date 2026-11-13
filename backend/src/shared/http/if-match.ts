import type { RequestHandler } from 'express';
import { AppError } from './errors.ts';

/** A strong entity tag of a version: the quoted 43 characters of a base64url SHA-256. */
const STRONG_TAG = /^"([A-Za-z0-9_-]{43})"$/;

/**
 * The strong `ETag` header value of a version (`doc/API-Guidelines.md` section 6).
 *
 * @param version A version from the write service.
 * @returns The quoted tag.
 */
export function entityTag(version: string): string {
  return `"${version}"`;
}

/**
 * Middleware of the writes that need the version the client read: the `If-Match` header must be there and be one strong tag, as this server
 * sends it. A missing header is a `422` with `field: 'If-Match'` and `issue: 'required'`, a header that is not one tag of ours (a list, a weak tag,
 * `*`, anything else) a `422` with `issue: 'format'`; a well-formed tag that does not match the stored version is the `412` of the service. The version goes in `res.locals.ifMatch`.
 *
 * @throws {AppError} `VALIDATION_ERROR` (through Express).
 */
export const requireIfMatch: RequestHandler = (req, res, next) => {
  const header = req.get('if-match');
  if (header === undefined) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'If-Match', issue: 'required' }] });
  }
  const match = STRONG_TAG.exec(header.trim());
  if (match === null) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'If-Match', issue: 'format' }] });
  }
  res.locals.ifMatch = match[1] as string;
  next();
};
