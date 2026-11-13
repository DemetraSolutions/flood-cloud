/** The formats an upload may have, with the extension and the media type the server gives them (never the ones the client declares). */
export const IMAGE_FORMATS = Object.freeze({
  jpeg: Object.freeze({ extension: 'jpg', mimetype: 'image/jpeg' }),
  png: Object.freeze({ extension: 'png', mimetype: 'image/png' }),
  webp: Object.freeze({ extension: 'webp', mimetype: 'image/webp' }),
} as const);

/** A format an upload may have. */
export type ImageFormat = keyof typeof IMAGE_FORMATS;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Tells the format of an image from its first bytes, and nothing else: the media type and the file name the client sent are never looked at.
 * JPEG is `FF D8 FF`, PNG the eight-byte signature, WebP `RIFF`, four bytes of size and `WEBP`.
 *
 * @param bytes The uploaded file.
 * @returns The format, or `null` for anything else (SVG, GIF, HTML, a document…).
 */
export function detectImageFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** The name without its extension (what follows the last dot). */
function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/** Longest slug of a file name. */
export const MAX_SLUG_LENGTH = 60;

/** Longest `title` and `alt`, in characters. */
export const MAX_TITLE_LENGTH = 150;

/**
 * The part of the stored file name that comes from the client: the original name without the extension, reduced to lower case letters and digits joined by
 * dashes (accents removed), at most {@link MAX_SLUG_LENGTH} characters, `image` when nothing is left.
 *
 * @param name The decoded original name.
 * @returns The slug.
 */
export function slugOf(name: string): string {
  const slug = withoutExtension(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join('-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === undefined || slug === '' ? 'image' : slug;
}

/**
 * The `title` and the `alt` of a new image: the original name without the extension, trimmed, without control characters, format characters (bidirectional overrides, zero-width), line and paragraph separators and the characters `<`, `>` and `"` (the legacy clients build HTML with these texts), at most {@link MAX_TITLE_LENGTH}
 * characters; the slug when nothing is left.
 *
 * @param name The decoded original name.
 * @param slug The slug of the same name.
 * @returns The title.
 */
export function titleOf(name: string, slug: string): string {
  const title = [...withoutExtension(name).replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\u2028\u2029<>"]/gu, '').trim()].slice(0, MAX_TITLE_LENGTH).join('').trim();
  return title === '' ? slug : title;
}
