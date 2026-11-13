import { Double, ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { numberOf } from '../companies/company.mapper.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { IMAGE_SIZE_NAMES } from './image.types.ts';
import type { Image, ImageUrls } from './image.types.ts';

const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/** The directory every image document has, and the descriptor of a logo. */
export const IMAGE_DIRNAME = '/media/image';

/**
 * The files host of a group when it can be trusted to build a URL: an `https` URL without credentials, query or fragment. Anything else (a legacy value that
 * is empty, is `http`, is not a URL…) gives `null`, and the images then have no URLs.
 *
 * @param stored The `filesHost` of the group document, of any type.
 * @returns The host without a trailing slash, or `null`.
 */
export function filesHostOf(stored: unknown): string | null {
  if (typeof stored !== 'string') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(stored);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * The URLs of the five sizes of an image: `<filesHost>/<groupHex>/media/image/<size>/<basename>`, the basename encoded.
 *
 * @param filesHost The trusted files host of the group, or `null`.
 * @param groupHex The group id in hexadecimal.
 * @param basename The stored file name.
 * @returns The URLs, `null` without a host or without a file name.
 */
export function imageUrls(filesHost: string | null, groupHex: string, basename: unknown): ImageUrls | null {
  if (filesHost === null || typeof basename !== 'string' || basename === '') {
    return null;
  }
  return Object.fromEntries(IMAGE_SIZE_NAMES.map((size) => [size, `${filesHost}/${groupHex}${IMAGE_DIRNAME}/${size}/${encodeURIComponent(basename)}`])) as unknown as ImageUrls;
}

/**
 * Maps a stored `files` document to the image of the API. Tolerant: a document that lacks a field (the legacy has no schema) gives `''` or `null` for it, never an error.
 *
 * @param document The stored document (default read types).
 * @param filesHost The trusted files host of the group, or `null`.
 * @param groupHex The group id in hexadecimal.
 */
export function toImage(document: Document, filesHost: string | null, groupHex: string): Image {
  const name = stringOr(document['name'], '');
  const inserted: unknown = document['insertDate'];
  return {
    id: document['_id'] instanceof ObjectId ? document['_id'].toHexString() : '',
    name,
    title: stringOr(document['title'], name),
    alt: stringOr(document['alt'], ''),
    companyId: document['companyId'] instanceof ObjectId ? document['companyId'].toHexString() : null,
    extension: stringOr(document['extension'], ''),
    mimetype: typeof document['mimetype'] === 'string' ? document['mimetype'] : null,
    createdAt: inserted instanceof Date && !Number.isNaN(inserted.getTime()) ? inserted.toISOString() : null,
    urls: imageUrls(filesHost, groupHex, document['basename']),
  };
}

/** A file name that is safe to put in a URL path without encoding: one segment, no separator, no `?`, `#` or `%`, no control character, not hidden. */
const SIMPLE_BASENAME = /^(?!\.)[^/\\?#%\u0000-\u001f\u007f]{1,255}$/;

/** An extension: letters and digits. */
const SIMPLE_EXTENSION = /^[A-Za-z0-9]{1,10}$/;

/** A media type of an image. */
const IMAGE_MIMETYPE = /^image\/[A-Za-z0-9][A-Za-z0-9.+-]{0,60}$/;

/**
 * The descriptor of a stored image as a company logo holds it, in the domain form. The legacy lets any user change `basename`, `dirname` and `mimetype` of a `files`
 * document, and the clients that read a logo build `<filesHost>/<group><dirname>/<size>/<basename>` without encoding, so none of that is trusted: the directory is always
 * {@link IMAGE_DIRNAME} (never read from the document), the file name must be a simple one, the extension letters and digits and the media type an `image/*`. The creation time must be
 * there too. `filename` is the name, `title` and `alt` fall back to it.
 *
 * @param document The stored `files` document.
 * @returns The descriptor, or `null` when the document lacks what a logo needs or holds something that is not acceptable.
 */
export function toLogoSource(document: Document): MediaLogo | null {
  const { basename, extension, mimetype } = document as Record<string, unknown>;
  const created = numberOf(document['filectime']);
  if (
    !(document['_id'] instanceof ObjectId) ||
    typeof basename !== 'string' ||
    !SIMPLE_BASENAME.test(basename) ||
    basename.includes('..') ||
    typeof extension !== 'string' ||
    !SIMPLE_EXTENSION.test(extension) ||
    typeof mimetype !== 'string' ||
    !IMAGE_MIMETYPE.test(mimetype) ||
    created === null
  ) {
    return null;
  }
  const name = stringOr(document['name'], basename);
  return {
    _id: document['_id'].toHexString(),
    basename,
    extension,
    filename: name,
    mimetype,
    title: stringOr(document['title'], name),
    alt: stringOr(document['alt'], ''),
    dirname: IMAGE_DIRNAME,
    type: 'image',
    filectime: created,
  };
}

/**
 * The document a new image is stored as, with the keys, the order and the types of the legacy (`doc/Data-Model.md`): `filectime` is the creation time in milliseconds
 * as a double (the legacy writes a JS number that does not fit an int32). Two keys are added after `updateDate`: `createdBy` and `companyId` (the legacy ignores them).
 *
 * @param fields What the upload knows.
 * @returns The document to insert.
 */
export function newFileDocument(fields: {
  readonly id: ObjectId;
  readonly groupId: ObjectId;
  readonly basename: string;
  readonly title: string;
  readonly extension: string;
  readonly mimetype: string;
  readonly now: Date;
  /** The user who uploaded it. */
  readonly createdBy: ObjectId;
  /** The company the image belongs to, `null` for the whole group. */
  readonly companyId: ObjectId | null;
}): Document {
  return {
    _id: fields.id,
    groupId: fields.groupId,
    basename: fields.basename,
    name: fields.title,
    extension: fields.extension,
    dirname: IMAGE_DIRNAME,
    type: 'image',
    mimetype: fields.mimetype,
    filectime: new Double(fields.now.getTime()),
    alt: fields.title,
    title: fields.title,
    trash: false,
    insertDate: fields.now,
    updateDate: fields.now,
    createdBy: fields.createdBy,
    companyId: fields.companyId,
  };
}
