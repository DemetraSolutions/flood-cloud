import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler, Response } from 'express';
import { AppError } from '../../shared/http/errors.ts';
import { sendRevalidatedPage } from '../../shared/http/etag.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { CSV_BOM, csvHeader, csvLines } from './diagnostics.csv.ts';
import type { DevicesCsvQuery, DevicesQuery } from './diagnostics.schemas.ts';
import type { DiagnosticsService } from './diagnostics.service.ts';

/** HTTP handlers of the diagnostics. */
export interface DiagnosticsController {
  devices: RequestHandler;
  devicesCsv: RequestHandler;
}

/** The name of the exported file: `devices-diagnostic_<date>.csv`, as the legacy one. */
export function csvFileName(now: Date): string {
  return `devices-diagnostic_${now.toISOString().slice(0, 10)}.csv`;
}

/** `ERR_STREAM_PREMATURE_CLOSE`: the client went away while the file was being written. */
function isClientGone(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/** Longest an export may take, from the first byte to the last: a client that reads slowly does not keep a stream (and a perimeter resolved long ago) open for ever. */
export const EXPORT_TIMEOUT_MS = 5 * 60_000;

/**
 * Translates HTTP into {@link DiagnosticsService} calls. The CSV is checked (perimeter and size) before the first byte, then streamed batch by batch through `pipeline`, which
 * honours the backpressure of the connection and stops reading the database when the client goes away.
 *
 * At most one export runs at a time for a user (in this process): another is `429 RATE_LIMITED`; the whole export is limited to {@link EXPORT_TIMEOUT_MS}.
 *
 * @param service The service.
 * @param now Clock in epoch milliseconds, for the name of the file.
 * @param exportTimeoutMs Longest an export may take (tests lower it).
 */
export function createDiagnosticsController(service: DiagnosticsService, now: () => number, exportTimeoutMs = EXPORT_TIMEOUT_MS): DiagnosticsController {
  const running = new Set<string>();
  return {
    devices: async (req, res) => {
      const { items, page } = await service.list(res.locals.auth!, inputOf<DevicesQuery>(res, 'query'));
      sendRevalidatedPage(req, res, items, page);
    },
    devicesCsv: async (_req, res) => {
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
    const exported = await service.export(res.locals.auth!, inputOf<DevicesCsvQuery>(res, 'query'));
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
