import { createHash } from 'node:crypto';
import multer from 'multer';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../../shared/http/errors.ts';
import { idempotencyKeyOf } from '../../shared/http/idempotency.ts';
import { createGate } from '../media/gate.ts';
import type { Gate } from '../media/gate.ts';
import { ZIP_MAGIC } from '../../shared/xlsx/zip.ts';

/** Largest file accepted: 10 MB (the limit of the XLSX reader). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Name of the only form field of the import. */
export const IMPORT_FIELD = 'file';

/** The gate of the process: the import holds up to 10 MB in memory and the CPU while the workbook is read, so one runs at a time and two wait. */
const processGate = createGate(1, 2);

/** What a multer error becomes: `413` for the size, `422` for a field or a part that must not be there, `400` for a body that is not valid multipart. */
function mapUploadError(error: unknown): AppError {
  if (!(error instanceof multer.MulterError)) {
    return new AppError('BAD_REQUEST');
  }
  if (error.code === 'LIMIT_FILE_SIZE') {
    return new AppError('PAYLOAD_TOO_LARGE');
  }
  return new AppError('VALIDATION_ERROR', {
    details: [error.code === 'LIMIT_UNEXPECTED_FILE' ? { field: IMPORT_FIELD, issue: 'unknown' } : { field: '(body)', issue: 'unknown' }],
  });
}

/**
 * The body handler of the import (the route's `multipart`): a `multipart/form-data` request with exactly one file in the field `file` and nothing else, up to {@link MAX_IMPORT_BYTES}, held in memory (never
 * written to disk). Before a byte of the body is read the `Idempotency-Key` is checked (`422`); a request that is not multipart is `415`; more than one file, a text field, another part or a file in another field
 * is `422`; a larger file is `413`; a body that is not valid multipart is `400`.
 *
 * The request holds a slot of the gate (`503` with `Retry-After` when the queue is full) from before the body is read until the response is over.
 *
 * @param gate The gate; the one of the process by default.
 * @returns The handler; on success `req.file` is the file (or `undefined` when the request had no file part: {@link acceptWorkbook} refuses it).
 */
export function workbookUpload(gate: Gate = processGate): RequestHandler {
  const parser = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 0, parts: 2, headerPairs: 20, fieldNameSize: 100 },
  }).single(IMPORT_FIELD);
  return async (req, res, next) => {
    idempotencyKeyOf(req);
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

/**
 * Checks the file the upload read and gives the request the body that the idempotency fingerprints: the SHA-256 of the file, so the same key with the same file replays the answer and the same key with another file
 * is a conflict. A missing file is `422` (`file`/`required`); a file that does not start with the ZIP signature `PK\x03\x04` is `415` (an XLSX is a ZIP archive, whatever its name or its declared type).
 *
 * @returns The middleware, to run after {@link workbookUpload}.
 */
export function acceptWorkbook(): RequestHandler {
  return (req: Request, _res, next) => {
    const file = req.file;
    if (file === undefined) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: IMPORT_FIELD, issue: 'required' }] });
    }
    if (file.buffer.length < ZIP_MAGIC.length || !file.buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE');
    }
    req.body = { sha256: createHash('sha256').update(file.buffer).digest('hex') };
    next();
  };
}
