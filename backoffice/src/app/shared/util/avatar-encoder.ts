import { DOCUMENT } from '@angular/common';
import { inject, Service } from '@angular/core';

/** Largest avatar the backend accepts (bytes of the decoded image). */
export const AVATAR_MAX_BYTES = 200 * 1024;

/**
 * Largest file read for an avatar (bytes). Checked before decoding, so that a huge file is never
 * loaded into memory: the user is asked for a smaller image instead.
 */
export const AVATAR_SOURCE_MAX_BYTES = 10 * 1024 * 1024;

/** Image types the backend accepts for an avatar. */
export const AVATAR_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];

/** Longest side, in pixels, tried for the avatar (smaller ones follow when it does not fit). */
const SIDES = [256, 192, 128, 96] as const;

/** Encodings tried at each size, best first: WebP at falling quality, then PNG. */
const ATTEMPTS: readonly (readonly [string, number | undefined])[] = [
  ['image/webp', 0.9],
  ['image/webp', 0.75],
  ['image/webp', 0.6],
  ['image/png', undefined],
];

/** Why an image cannot become an avatar. */
export type AvatarProblem = 'type' | 'file' | 'read' | 'size';

/** Error of {@link AvatarEncoder.encode}; `problem` selects the message to show. */
export class AvatarError extends Error {
  constructor(readonly problem: AvatarProblem) {
    super(`Avatar cannot be encoded: ${problem}`);
    this.name = 'AvatarError';
  }
}

/**
 * Size in bytes of the image a data URL carries (base64 payload decoded).
 *
 * @param dataUrl A `data:<type>;base64,<payload>` URL.
 */
export function dataUrlBytes(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

/**
 * Turns an image chosen by the user into an avatar data URL: it is scaled down on a canvas
 * (longest side 256 px, as the legacy backoffice did with 250) and encoded as WebP or, where the
 * browser cannot encode WebP, as PNG, at the best quality that stays under
 * {@link AVATAR_MAX_BYTES}. The backend checks the result again.
 */
@Service()
export class AvatarEncoder {
  private readonly document = inject(DOCUMENT);

  /**
   * @param file The chosen file.
   * @returns The data URL of the avatar.
   * @throws {AvatarError} `type` (not PNG, JPEG or WebP), `file` (file over
   *   {@link AVATAR_SOURCE_MAX_BYTES}, not read), `read` (cannot be decoded) or `size` (does not
   *   fit even when small).
   */
  async encode(file: File): Promise<string> {
    if (!AVATAR_TYPES.includes(file.type)) {
      throw new AvatarError('type');
    }
    if (file.size > AVATAR_SOURCE_MAX_BYTES) {
      throw new AvatarError('file');
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new AvatarError('read');
    }
    try {
      const canvas = this.document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context === null) {
        throw new AvatarError('read');
      }
      for (const side of SIDES) {
        const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const [type, quality] of ATTEMPTS) {
          const url = canvas.toDataURL(type, quality);
          if (url.startsWith(`data:${type};`) && dataUrlBytes(url) <= AVATAR_MAX_BYTES) {
            return url;
          }
        }
      }
      throw new AvatarError('size');
    } finally {
      bitmap.close();
    }
  }
}
