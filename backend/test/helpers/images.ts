import sharp from 'sharp';

/** A solid RGBA image of a format, generated at test time. */
export async function image(format: 'jpeg' | 'png' | 'webp', width = 64, height = 32, options: { alpha?: boolean } = {}): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: options.alpha === true ? 0.5 : 1 } } });
  return format === 'jpeg' ? base.jpeg().toBuffer() : format === 'png' ? base.png().toBuffer() : base.webp().toBuffer();
}

/** A JPEG whose pixels are 80 wide by 40 high and whose EXIF orientation (6) asks to turn it a quarter turn: upright it is 40 wide by 80 high. Carries EXIF text a strip must remove. */
export async function rotatedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 80, height: 40, channels: 3, background: { r: 10, g: 200, b: 10 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Copyright: 'secret-copyright' } })
    .toBuffer();
}

/** A PNG with a width and a height whose product is above 40 megapixels: tiny to store (a flat color), refused by the pixel limit. */
export async function hugePng(): Promise<Buffer> {
  return sharp({ create: { width: 7000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png({ compressionLevel: 9 }).toBuffer();
}

/** An animated WebP of two frames. */
export async function animatedWebp(): Promise<Buffer> {
  const frame = (color: number): Buffer => Buffer.alloc(16 * 16 * 3, color);
  return sharp(Buffer.concat([frame(10), frame(200)]), { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
}

/** A GIF: only its signature and a one-pixel body, enough for the magic bytes (refused before it is decoded). */
export const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** An SVG with a script. */
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** A file that starts with the PNG signature and goes on with HTML: a polyglot that is not a decodable image. */
export const PNG_POLYGLOT = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<html><script>alert(1)</script></html>')]);

/** The size and the format of an encoded image. */
export async function describeImage(bytes: Buffer): Promise<{ width: number; height: number; format: string; hasExif: boolean; hasAlpha: boolean; orientation: number | undefined }> {
  const meta = await sharp(bytes).metadata();
  return { width: meta.width, height: meta.height, format: meta.format, hasExif: meta.exif !== undefined, hasAlpha: meta.hasAlpha === true, orientation: meta.orientation } as never;
}
