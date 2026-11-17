import { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';

/** Version written in every cursor of the error documents table; a cursor of another version is refused. */
const CURSOR_VERSION = 1;

/**
 * Encodes the position a page continues from: base64url of `{ ver, i }` (the id of the last document of the page), nothing else.
 *
 * @param id The `_id` of the last document of the page.
 * @returns The opaque cursor.
 */
export function encodeErrorDocumentCursor(id: ObjectId): string {
  return Buffer.from(JSON.stringify({ ver: CURSOR_VERSION, i: id.toHexString() })).toString('base64url');
}

function malformed(): AppError {
  return new AppError('VALIDATION_ERROR', { details: [{ field: 'cursor', issue: 'format' }] });
}

/**
 * Decodes a cursor of the error documents table.
 *
 * @param raw The cursor of the request.
 * @returns The id the next page continues after.
 * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for anything this server did not issue: bad alphabet, bad JSON, other keys or version, an id that is not 24 lowercase hexadecimal characters.
 */
export function decodeErrorDocumentCursor(raw: string): ObjectId {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw malformed();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw malformed();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformed();
  }
  const { ver, i } = parsed as Record<string, unknown>;
  if (Object.keys(parsed).sort().join() !== 'i,ver' || ver !== CURSOR_VERSION || typeof i !== 'string' || !/^[0-9a-f]{24}$/.test(i)) {
    throw malformed();
  }
  return ObjectId.createFromHexString(i);
}
