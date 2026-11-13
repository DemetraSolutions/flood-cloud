import sharp from 'sharp';
import { AppError } from '../../shared/http/errors.ts';
import type { ImageFormat } from './image-format.ts';
import { IMAGE_SIZES, IMAGE_SIZE_NAMES } from './image.types.ts';
import type { ImageSize } from './image.types.ts';

/** Most pixels (width times height) an uploaded image may have: 40 megapixels. A larger one is refused before it is decoded. */
export const MAX_INPUT_PIXELS = 40_000_000;

/** Longest side, in pixels, an uploaded image may have: the limit of WebP, and a ceiling on very tall or very wide images whose outputs would be huge. */
export const MAX_SIDE = 16_383;

/** Seconds one pipeline may run before it is stopped. */
export const PIPELINE_TIMEOUT_SECONDS = 10;

// One libvips thread per job and no cache of intermediate results: the process serves many groups and may have fewer CPUs than cores it sees.
sharp.concurrency(1);
sharp.cache(false);

/** Quality of the JPEG and WebP outputs. */
export const OUTPUT_QUALITY = 80;

/** The five sizes of an image, each already encoded in the format of the upload. */
export type ProcessedImage = Readonly<Record<ImageSize, Buffer>>;

/** The error of an image that cannot be used: `422` on the `file` field. */
const unusable = (): AppError => new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'incorrect' }] });

/** Options of every decode: libvips refuses an image with more pixels than the limit; the failure level of sharp stays at its default, the strictest (a warning is an error). */
const DECODE = { limitInputPixels: MAX_INPUT_PIXELS } as const;

/**
 * Turns an uploaded image into its five sizes. The image is decoded **once**: turned upright by its EXIF orientation, stripped of every metadata (EXIF,
 * location, ICC, comments) and cut to the `xl` width as raw pixels, from which the five sizes are made. Each size is resized to its width without enlarging and encoded in the
 * same format as the input: JPEG at quality 80, WebP at quality 80, PNG at compression level 9 (transparency is kept). Every pipeline has a timeout; the number of
 * images processed at the same time is bounded by the gate in front of the upload.
 *
 * @param input The bytes of the upload.
 * @param format The format found by the magic bytes.
 * @returns The five encoded sizes.
 * @throws {AppError} `VALIDATION_ERROR` on `file`/`incorrect` for an image that cannot be decoded, that is damaged (any warning of the decoder counts), that has more than {@link MAX_INPUT_PIXELS} pixels or a side longer than {@link MAX_SIDE}, that is animated (a WebP with more than one frame) or that takes more than {@link PIPELINE_TIMEOUT_SECONDS} seconds.
 */
export async function processImage(input: Buffer, format: ImageFormat): Promise<ProcessedImage> {
  try {
    const { width, height, pages } = await sharp(input, DECODE).metadata();
    if (width === undefined || height === undefined || width * height > MAX_INPUT_PIXELS || Math.max(width, height) > MAX_SIDE || (pages ?? 1) > 1) {
      throw unusable();
    }
    const timeout = { seconds: PIPELINE_TIMEOUT_SECONDS };
    const { data, info } = await sharp(input, DECODE)
      .rotate()
      .resize({ width: IMAGE_SIZES.xl, withoutEnlargement: true })
      .raw()
      .timeout(timeout)
      .toBuffer({ resolveWithObject: true });
    const sizes: Partial<Record<ImageSize, Buffer>> = {};
    for (const size of IMAGE_SIZE_NAMES) {
      const resized = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).resize({ width: IMAGE_SIZES[size], withoutEnlargement: true }).timeout(timeout);
      const encoded = format === 'jpeg' ? resized.jpeg({ quality: OUTPUT_QUALITY, mozjpeg: false }) : format === 'png' ? resized.png({ compressionLevel: 9 }) : resized.webp({ quality: OUTPUT_QUALITY });
      sizes[size] = await encoded.toBuffer();
    }
    return sizes as ProcessedImage;
  } catch (error) {
    throw error instanceof AppError ? error : unusable();
  }
}
