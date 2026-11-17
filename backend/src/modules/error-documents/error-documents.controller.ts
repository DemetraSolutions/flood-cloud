import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler, Response } from 'express';
import { AppError } from '../../shared/http/errors.ts';
import { sendRevalidatedPage } from '../../shared/http/etag.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { EXPORT_TIMEOUT_MS } from '../diagnostics/diagnostics.controller.ts';
import { CSV_BOM, csvHeader, csvLines } from './error-documents.csv.ts';
import type { ErrorDocumentsCsvQuery, ErrorDocumentsQuery } from './error-documents.schemas.ts';
import type { ErrorDocumentsService } from './error-documents.service.ts';

/** HTTP handlers of the documents in error. */
export interface ErrorDocumentsController {
  list: RequestHandler;
  csv: RequestHandler;
}

/** The name of the exported file: `error-documents_<date>.csv`. */
export function csvFileName(now: Date): string {
  return `error-documents_${now.toISOString().slice(0, 10)}.csv`;
}

/** `ERR_STREAM_PREMATURE_CLOSE`: the client went away while the file was being written. */
function isClientGone(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/**
 * Translates HTTP into {@link ErrorDocumentsService} calls. The CSV is checked (perimeter and size) before the first byte, then streamed batch by batch through `pipeline`, which honours
 * the backpressure of the connection and stops reading the database when the client goes away. At most one export runs at a time for a user (in this process): another is `429 RATE_LIMITED`;
 * the whole export is limited to the same time as the diagnostics one.
 *
 * @param service The service.
 * @param now Clock in epoch milliseconds, for the name of the file.
 * @param exportTimeoutMs Longest an export may take (tests lower it).
 */
export function createErrorDocumentsController(service: ErrorDocumentsService, now: () => number, exportTimeoutMs = EXPORT_TIMEOUT_MS): ErrorDocumentsController {
  const running = new Set<string>();
  return {
    list: async (req, res) => {
      const { items, page } = await service.list(res.locals.auth!, inputOf<ErrorDocumentsQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    csv: async (_req, res) => {
      const user = res.locals.auth!.userId.toHexString();
      if (running.has(user)) {
        throw new AppError('RATE_LIMITED');
      }
      running.add(user);
      try {
        await sendCsv(res);
      } finally {
        running.delete(user);
      }
    },
  };

  async function sendCsv(res: Response): Promise<void> {
    const exported = await service.export(res.locals.auth!, inputOf<ErrorDocumentsCsvQuery>(res, 'query'));
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFileName(new Date(now()))}"`);
    res.setHeader('Cache-Control', 'no-store');
    const lines = async function* (): AsyncGenerator<string> {
      yield `${CSV_BOM}${csvHeader()}`;
      for await (const batch of exported.batches()) {
        yield csvLines(batch);
      }
    };
    try {
      await pipeline(Readable.from(lines()), res, { signal: AbortSignal.timeout(exportTimeoutMs) });
    } catch (error) {
      if (!isClientGone(error)) {
        throw error;
      }
    }
  }
}
