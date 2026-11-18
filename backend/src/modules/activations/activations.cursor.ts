import { AppError } from '../../shared/http/errors.ts';
import type { LineKey } from './activations.mapper.ts';

/** Version written in every cursor of a statement; a cursor of another version is refused. */
const CURSOR_VERSION = 1;

/**
 * Encodes the position a page of a statement continues from: base64url of `{ ver, g, c, p, i }` (the sort key of the last line: group, company and place name, and the id of the place), nothing else. The names are the
 * ones of the lines, which are cut and stripped of control characters, so a cursor stays small.
 *
 * @param key The key of the last line of the page.
 * @returns The opaque cursor.
 */
export function encodeStatementCursor(key: LineKey): string {
  return Buffer.from(JSON.stringify({ ver: CURSOR_VERSION, g: key.groupName, c: key.companyName, p: key.placeName, i: key.placeId })).toString('base64url');
}

function malformed(): AppError {
  return new AppError('VALIDATION_ERROR', { details: [{ field: 'cursor', issue: 'format' }] });
}

/**
 * Decodes a cursor of a statement.
 *
 * @param raw The cursor of the request.
 * @returns The key of the last line of the previous page.
 * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for anything this server did not issue: bad alphabet, bad JSON, other keys or version, names that are not text, an id that is not 24 hexadecimal characters.
 */
export function decodeStatementCursor(raw: string): LineKey {
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
  const { ver, g, c, p, i } = parsed as Record<string, unknown>;
  if (Object.keys(parsed).sort().join() !== 'c,g,i,p,ver' || ver !== CURSOR_VERSION || typeof g !== 'string' || typeof c !== 'string' || typeof p !== 'string' || typeof i !== 'string' || !/^[0-9a-f]{24}$/.test(i)) {
    throw malformed();
  }
  return { groupName: g, companyName: c, placeName: p, placeId: i };
}

/** The sort key of a line of the detail view: the activation instant (milliseconds), the names of the dealer, the group and the place, and the id of the place. */
export interface DetailKey {
  readonly at: number;
  readonly dealerName: string;
  readonly groupName: string;
  readonly placeName: string;
  readonly placeId: string;
}

/**
 * Encodes the position a page of the detail view continues from: base64url of `{ ver, t, d, g, p, i }` (the sort key of the last line), nothing else.
 *
 * @param key The key of the last line of the page.
 * @returns The opaque cursor.
 */
export function encodeDetailCursor(key: DetailKey): string {
  return Buffer.from(JSON.stringify({ ver: CURSOR_VERSION, t: key.at, d: key.dealerName, g: key.groupName, p: key.placeName, i: key.placeId })).toString('base64url');
}

/**
 * Decodes a cursor of the detail view.
 *
 * @param raw The cursor of the request.
 * @returns The key of the last line of the previous page.
 * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for anything this server did not issue.
 */
export function decodeDetailCursor(raw: string): DetailKey {
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
  const { ver, t, d, g, p, i } = parsed as Record<string, unknown>;
  if (Object.keys(parsed).sort().join() !== 'd,g,i,p,t,ver' || ver !== CURSOR_VERSION || typeof t !== 'number' || !Number.isSafeInteger(t) || typeof d !== 'string' || typeof g !== 'string' || typeof p !== 'string' || typeof i !== 'string' || !/^[0-9a-f]{24}$/.test(i)) {
    throw malformed();
  }
  return { at: t, dealerName: d, groupName: g, placeName: p, placeId: i };
}
