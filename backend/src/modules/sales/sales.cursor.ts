import { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';

/** Version written in every cursor of the sales table; a cursor of another version is refused. */
const CURSOR_VERSION = 1;

/** Where a page of the sales table continues from: after the sale with this date and this id, in the order of the table (the newest first). */
export interface SalesCursor {
  readonly date: Date;
  readonly id: ObjectId;
}

/**
 * Encodes the position a page continues from: base64url of `{ ver, d, i }` (the date as epoch milliseconds and the id of the last sale of the page), nothing else.
 *
 * @param last The last sale of the page.
 * @returns The opaque cursor.
 */
export function encodeSalesCursor(last: SalesCursor): string {
  return Buffer.from(JSON.stringify({ ver: CURSOR_VERSION, d: last.date.getTime(), i: last.id.toHexString() })).toString('base64url');
}

function malformed(): AppError {
  return new AppError('VALIDATION_ERROR', { details: [{ field: 'cursor', issue: 'format' }] });
}

/**
 * Decodes a cursor of the sales table.
 *
 * @param raw The cursor of the request.
 * @returns The position the next page continues after.
 * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for anything this server did not issue: bad alphabet, bad JSON, other keys or version, a date that is not a safe epoch, an id that is not 24 lowercase hexadecimal characters.
 */
export function decodeSalesCursor(raw: string): SalesCursor {
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
  const { ver, d, i } = parsed as Record<string, unknown>;
  if (Object.keys(parsed).sort().join() !== 'd,i,ver' || ver !== CURSOR_VERSION || typeof d !== 'number' || !Number.isSafeInteger(d) || Number.isNaN(new Date(d).getTime()) || typeof i !== 'string' || !/^[0-9a-f]{24}$/.test(i)) {
    throw malformed();
  }
  return { date: new Date(d), id: ObjectId.createFromHexString(i) };
}
