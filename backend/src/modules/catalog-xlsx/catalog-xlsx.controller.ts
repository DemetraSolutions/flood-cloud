import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler, Response } from 'express';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { MAX_REPORTED_ERRORS, ImportRefusal } from './catalog-xlsx.errors.ts';
import type { CatalogXlsxService, WorkbookFile } from './catalog-xlsx.service.ts';
import type { ExportQuery, ImportQuery } from './catalog-xlsx.schemas.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { XLSX_CONTENT_TYPE } from '../../shared/xlsx/writer.ts';

/** HTTP handlers of the workbook routes. */
export interface CatalogXlsxController {
  template: RequestHandler;
  export: RequestHandler;
  import: RequestHandler;
}

/** Longest a download may take, from the first byte to the last. */
export const EXPORT_TIMEOUT_MS = 5 * 60_000;

/** `ERR_STREAM_PREMATURE_CLOSE`: the client went away while the file was being written. */
function isClientGone(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/** Streams a workbook: the headers first, then the bytes as they are made, with backpressure. */
async function sendWorkbook(res: Response, file: WorkbookFile, timeoutMs: number): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    await pipeline(Readable.from(file.chunks), res, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (!isClientGone(error)) {
      throw error;
    }
  }
}

/**
 * Translates HTTP into {@link CatalogXlsxService} calls. At most one export runs at a time for a user (in this process): another is `429`. The one import at a time of a group is kept by the service (`409`) and by the gate of the upload. A workbook with problems is
 * answered `422` with the list of the problems (`error.rows`: sheet, row, column, code, message), the count and whether there are more than the ones listed.
 *
 * @param service The service.
 * @param exportTimeoutMs Longest a download may take (tests lower it).
 */
export function createCatalogXlsxController(service: CatalogXlsxService, exportTimeoutMs = EXPORT_TIMEOUT_MS): CatalogXlsxController {
  const exporting = new Set<string>();
  return {
    template: async (_req, res) => {
      await sendWorkbook(res, await service.template(res.locals.auth!, res.locals.groupAccess!), exportTimeoutMs);
    },
    export: async (req, res) => {
      const user = res.locals.auth!.userId.toHexString();
      if (exporting.has(user)) {
        throw new AppError('RATE_LIMITED');
      }
      exporting.add(user);
      try {
        const query = inputOf<ExportQuery>(res, 'query');
        await sendWorkbook(res, await service.export(res.locals.auth!, res.locals.groupAccess!, query.references ?? 'ids', clientContextOf(req, res)), exportTimeoutMs);
      } finally {
        exporting.delete(user);
      }
    },
    import: async (req, res) => {
      try {
        // The route ran `acceptWorkbook`: there is a file.
        const outcome = await service.import(res.locals.auth!, res.locals.groupAccess!, req.file!.buffer, inputOf<ImportQuery>(res, 'query').dryRun ?? false, clientContextOf(req, res));
        sendData(res, outcome);
      } catch (error) {
        if (!(error instanceof ImportRefusal)) {
          throw error;
        }
        // The envelope of every `422` (`code`, `message`, `details` of `{ field, issue }`, here `Sheet!row!column` and the code of the problem) extended with the full list: `rows`, `errorCount`, `moreErrors`.
        res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: error.message,
            details: error.errors.map((row) => ({ field: `${row.sheet}${row.row === null ? '' : `!${String(row.row)}`}${row.column === null ? '' : `!${row.column}`}`, issue: row.code })),
            rows: error.errors,
            errorCount: error.errorCount,
            moreErrors: error.errorCount > Math.min(error.errors.length, MAX_REPORTED_ERRORS),
          },
        });
      }
    },
  };
}
