/** The widths, in pixels, of the five sizes every image is stored in (the legacy names and widths). */
export const IMAGE_SIZES = Object.freeze({ xs: 100, s: 250, m: 500, l: 800, xl: 1200 } as const);

/** The name of one of the five sizes. */
export type ImageSize = keyof typeof IMAGE_SIZES;

/** The sizes in the order they are produced. */
export const IMAGE_SIZE_NAMES: readonly ImageSize[] = Object.freeze(Object.keys(IMAGE_SIZES) as ImageSize[]);

/** The URLs of the five sizes of an image, built on the files host of the group. */
export type ImageUrls = Readonly<Record<ImageSize, string>>;

/** An image of the group as the API shows it. Tolerant of legacy documents: what a stored document lacks reads as `''` or `null`. */
export interface Image {
  readonly id: string;
  /** Legacy `name`: the name the file was uploaded with, without the extension. */
  readonly name: string;
  readonly title: string;
  readonly alt: string;
  /** The company the image belongs to; `null` for an image of the whole group (every legacy image, and the ones PSA, D and SA upload without a company). */
  readonly companyId: string | null;
  readonly extension: string;
  readonly mimetype: string | null;
  /** ISO 8601 instant of the upload, `null` when the document has none. */
  readonly createdAt: string | null;
  /** `null` when the group has no valid `https` files host or the document has no file name. */
  readonly urls: ImageUrls | null;
}

/** An uploaded file as multer holds it: the bytes and the name the client gave, both untrusted. */
export interface UploadedFile {
  readonly buffer: Buffer;
  /** The `originalname` of multer (the parser reads the name as UTF-8). */
  readonly originalName: string;
}
