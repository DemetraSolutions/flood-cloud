/**
 * Internal MIME type table of the static server.
 * @module
 */
import { extname } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/**
 * Returns the Content-Type for a file name.
 *
 * @param fileName File name or path.
 * @returns The MIME type, or `application/octet-stream` for unknown extensions.
 */
export function mimeType(fileName: string): string {
  return TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}
