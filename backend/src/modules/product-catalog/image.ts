import type { Document } from 'mongodb';
import { legacyLogoDescriptor, logo } from '../companies/company.mapper.ts';
import type { MediaLogo } from '../companies/company.types.ts';
import { isRecord, valueAt } from '../groups/catalogs/kit.ts';

/** Stored path of the image of a department or a brand, chosen from the library of the group. */
export const IMAGE_PATH = 'medias.images.main';

/**
 * The image of a stored department or brand, in the domain form of a logo: the descriptor at `medias.images.main`, or `null` when the document has none. The residue `medias.images.images`
 * the old form left is never read.
 *
 * @param document The stored document.
 */
export function imageOf(document: Document): MediaLogo | null {
  return logo.read(valueAt(document, IMAGE_PATH)) as MediaLogo | null;
}

/** What a write of the image changes. */
export interface ImageWrite {
  /** The `$set` that stores the image (empty when it is removed). */
  readonly set: Document;
  /** The `$unset` that removes it (empty when it is stored). */
  readonly unset: Document;
  /** The `medias` value the document has afterwards. */
  readonly medias: unknown;
}

/**
 * Works out how an image is stored or removed while every other key of `medias` stays: the descriptor goes to `medias.images.main`; when the stored `medias` or `medias.images` is missing or
 * is not an object the smallest container that holds the path is written instead, so the write never fails on a document the legacy left in a strange shape.
 *
 * @param stored The stored `medias`, of any type.
 * @param descriptor The image to store (the domain form, built by the server from an image of the library), or `null` to remove it.
 * @returns The `$set`, the `$unset` and the new `medias`.
 */
export function imageWrite(stored: unknown, descriptor: MediaLogo | null): ImageWrite {
  const images = isRecord(stored) ? stored['images'] : undefined;
  if (descriptor === null) {
    if (!isRecord(images) || !Object.hasOwn(images, 'main')) {
      return { set: {}, unset: {}, medias: stored };
    }
    const { main: _removed, ...rest } = images;
    return { set: {}, unset: { [IMAGE_PATH]: '' }, medias: { ...stored as Document, images: rest } };
  }
  const main = legacyLogoDescriptor(descriptor);
  if (isRecord(images)) {
    return { set: { [IMAGE_PATH]: main }, unset: {}, medias: { ...stored as Document, images: { ...images, main } } };
  }
  if (isRecord(stored)) {
    return { set: { 'medias.images': { main } }, unset: {}, medias: { ...stored, images: { main } } };
  }
  return { set: { medias: { images: { main } } }, unset: {}, medias: { images: { main } } };
}

/**
 * The `medias` of a new document: the container the legacy writes, with the image when there is one.
 *
 * @param descriptor The image to store, or `null` for none.
 */
export function newMedias(descriptor: MediaLogo | null): Document {
  return { images: descriptor === null ? {} : { main: legacyLogoDescriptor(descriptor) } };
}
