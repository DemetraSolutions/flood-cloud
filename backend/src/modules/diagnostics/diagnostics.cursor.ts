import { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { DeviceAfter } from '../../shared/security/scope/mirror-devices.ts';

/** Version written in every cursor of the device table; a cursor of another version is refused. */
const CURSOR_VERSION = 1;

/**
 * Encodes the position a page of device rows continues from: base64url of `{ ver, p, i }` (the id of the place and the position of the device in it), nothing else.
 *
 * @param after The last device of the page.
 * @returns The opaque cursor.
 */
export function encodeDeviceCursor(after: DeviceAfter): string {
  return Buffer.from(JSON.stringify({ ver: CURSOR_VERSION, p: after.placeId.toHexString(), i: after.index })).toString('base64url');
}

function malformed(): AppError {
  return new AppError('VALIDATION_ERROR', { details: [{ field: 'cursor', issue: 'format' }] });
}

/**
 * Decodes a cursor of the device table.
 *
 * @param raw The cursor of the request.
 * @returns The position.
 * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for anything this server did not issue: bad alphabet, bad JSON, other keys or version, an id that is not 24 hexadecimal characters, a position that is not a non-negative integer.
 */
export function decodeDeviceCursor(raw: string): DeviceAfter {
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
  const { ver, p, i } = parsed as Record<string, unknown>;
  if (Object.keys(parsed).sort().join() !== 'i,p,ver' || ver !== CURSOR_VERSION || typeof p !== 'string' || !/^[0-9a-f]{24}$/.test(p) || typeof i !== 'number' || !Number.isSafeInteger(i) || i < 0) {
    throw malformed();
  }
  return { placeId: ObjectId.createFromHexString(p), index: i };
}
