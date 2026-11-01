import compression from 'compression';
import type { RequestHandler } from 'express';

/** Minimum response size, in bytes, that gets compressed. */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * Creates the global response compression middleware.
 *
 * @returns Express middleware compressing responses of at least {@link COMPRESSION_THRESHOLD_BYTES}.
 */
export function compressionMiddleware(): RequestHandler {
  return compression({ threshold: COMPRESSION_THRESHOLD_BYTES });
}
