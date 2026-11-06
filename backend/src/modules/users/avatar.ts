import { createHash } from 'node:crypto';

/** Largest picture accepted, in bytes of decoded data. */
export const AVATAR_MAX_BYTES = 200 * 1024;

/** Length of the base64 text of the largest picture (padding included). */
const MAX_BASE64_LENGTH = Math.ceil(AVATAR_MAX_BYTES / 3) * 4;

/** The image types accepted, by the media type the data URL declares. */
type ImageType = 'png' | 'jpeg' | 'webp';

const PREFIX = /^data:image\/(png|jpeg|webp);base64,/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Detects the type of an image from its first bytes (never from what the data URL says). */
function typeOfBytes(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** The outcome of {@link checkAvatar}. */
export type AvatarCheck = { readonly ok: true } | { readonly ok: false; readonly issue: 'format' | 'maximum' };

/**
 * Checks the picture of a user: a data URL of a PNG, JPEG or WebP image (never SVG or anything else) in canonical base64 whose decoded content is
 * at most {@link AVATAR_MAX_BYTES} bytes and whose real type, read from the magic bytes of the content, is the one the prefix declares.
 *
 * @param value The data URL as sent.
 * @returns `ok`, or the reason: `maximum` for a picture that is too big, `format` for anything else.
 */
export function checkAvatar(value: string): AvatarCheck {
  const prefix = PREFIX.exec(value);
  if (prefix === null) {
    return { ok: false, issue: 'format' };
  }
  const payload = value.slice(prefix[0].length);
  if (payload.length > MAX_BASE64_LENGTH) {
    return { ok: false, issue: 'maximum' };
  }
  if (payload === '' || payload.length % 4 !== 0 || !BASE64.test(payload)) {
    return { ok: false, issue: 'format' };
  }
  const bytes = Buffer.from(payload, 'base64');
  // Canonical: decoding and encoding again gives the same text, so no stray bits or alternative spellings hide in it.
  if (bytes.toString('base64') !== payload) {
    return { ok: false, issue: 'format' };
  }
  if (bytes.length > AVATAR_MAX_BYTES) {
    return { ok: false, issue: 'maximum' };
  }
  return typeOfBytes(bytes) === prefix[1] ? { ok: true } : { ok: false, issue: 'format' };
}

/**
 * Whether a stored picture may be shown: a data URL of a PNG, JPEG or WebP image in base64 whose first bytes are of the declared type. The legacy
 * platform stored whatever its clients sent (no type, no size), so a stored value is checked before it leaves the backend: never an SVG, a
 * `javascript:` URL or another kind of content. The size is not checked, so that the larger pictures of the legacy still show.
 *
 * @param value The stored value.
 * @returns `true` when the value can be returned as the picture of the user.
 */
export function isDisplayableAvatar(value: string): boolean {
  const prefix = PREFIX.exec(value);
  if (prefix === null) {
    return false;
  }
  const payload = value.slice(prefix[0].length);
  if (payload.length % 4 !== 0 || !BASE64.test(payload)) {
    return false;
  }
  // Sixteen characters are the twelve bytes the longest signature (WebP) needs.
  return typeOfBytes(Buffer.from(payload.slice(0, 16), 'base64')) === prefix[1];
}

/**
 * A short fingerprint of a picture, for the activity log: it shows that the picture changed without storing it.
 *
 * @param avatar The data URL.
 * @returns The first 16 hexadecimal characters of its SHA-256.
 */
export function avatarFingerprint(avatar: string): string {
  return createHash('sha256').update(avatar).digest('hex').slice(0, 16);
}
