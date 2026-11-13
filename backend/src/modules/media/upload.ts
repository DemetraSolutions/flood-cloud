import multer from 'multer';
import type { RequestHandler } from 'express';
import { AppError } from '../../shared/http/errors.ts';
import { MAX_RUNNING_UPLOADS, MAX_WAITING_UPLOADS, createGate } from './gate.ts';
import type { Gate } from './gate.ts';

/** The gate of the process: the uploads inside it (a body of up to 10 MB in memory, then the decoding) are few, and the ones waiting are bounded too. */
const processGate = createGate(MAX_RUNNING_UPLOADS, MAX_WAITING_UPLOADS);

/** Largest image accepted: 10 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Name of the only form field of the upload. */
export const IMAGE_FIELD = 'file';

/** What a multer error becomes: `413` for the size, `422` for a field or a part that must not be there, `400` for a body that is not valid multipart. */
function mapUploadError(error: unknown): AppError {
  if (!(error instanceof multer.MulterError)) {
    return new AppError('BAD_REQUEST');
  }
  if (error.code === 'LIMIT_FILE_SIZE') {
    return new AppError('PAYLOAD_TOO_LARGE');
  }
  return new AppError('VALIDATION_ERROR', {
    details: [error.code === 'LIMIT_UNEXPECTED_FILE' ? { field: IMAGE_FIELD, issue: 'unknown' } : { field: '(body)', issue: 'unknown' }],
  });
}

/**
 * The body handler of the image upload (the route's `multipart`): a `multipart/form-data` request with exactly one file in the field `file` and nothing else, up
 * to {@link MAX_IMAGE_BYTES}, held in memory (never written to disk). A request that is not multipart is `415`; more than one file, a text field, a second part or
 * a file in another field is `422`; a larger file is `413`; a body that is not valid multipart is `400`. When the storage is not available the answer is `503`
 * before a byte of the body is read.
 *
 * The whole request holds a slot of the gate (`503` with `Retry-After` when the queue is full), taken before the body is read and given back when the response is over.
 *
 * @param available Tells whether the media storage is configured.
 * @param gate The gate; the one of the process by default.
 * @returns The handler; on success `req.file` is the file (or `undefined` when the request had no file part).
 */
export function imageUpload(available: () => boolean, gate: Gate = processGate): RequestHandler {
  const parser = multer({
    storage: multer.memoryStorage(),
    // Browsers send the file name as UTF-8.
    defParamCharset: 'utf8',
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 2, headerPairs: 20, fieldNameSize: 100 },
  }).single(IMAGE_FIELD);
  return async (req, res, next) => {
    if (!available()) {
      throw new AppError('SERVICE_UNAVAILABLE');
    }
    if (req.is('multipart/form-data') !== 'multipart/form-data') {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE');
    }
    const release = await gate.enter();
    if (res.closed) {
      // The client went away while it waited: nothing to read, nothing to answer.
      release();
      return;
    }
    res.once('close', release);
    parser(req, res, (error?: unknown) => next(error === undefined ? undefined : mapUploadError(error)));
  };
}
