import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RequestHandler, Response } from 'express';
import type { ObjectId } from 'mongodb';
import { clientContextOf } from '../../shared/http/client-context.ts';
import { sendData } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { inputOf } from '../../shared/validation/middleware.ts';
import { EXPORT_TIMEOUT_MS } from '../diagnostics/diagnostics.controller.ts';
import { CSV_BOM, csvEntries, csvHeader } from './activations.csv.ts';
import type { DetailCsvQuery, DetailQuery, MonthParams, StatementCsvQuery, StatementParams, StatementQuery, SummaryQuery, YearParams } from './activations.schemas.ts';
import type { Line } from './activations.types.ts';
import type { ActivationsService } from './activations.service.ts';

/** HTTP handlers of the activations. */
export interface ActivationsController {
  summary: RequestHandler;
  statement: RequestHandler;
  statementCsv: RequestHandler;
  detail: RequestHandler;
  detailCsv: RequestHandler;
  freezeBase: RequestHandler;
  unfreezeBase: RequestHandler;
  closeMonth: RequestHandler;
  reopenMonth: RequestHandler;
}

/** The name of the exported file: `attivazioni_<month>_<section>_<dealer>.csv` (the dealer by id, never by name: a name is free text). */
export function csvFileName(month: string, section: string, dealer: ObjectId | 'none'): string {
  return `attivazioni_${month}_${section}_${dealer === 'none' ? 'none' : dealer.toHexString()}.csv`;
}

/** The name of the exported detail: `attivazioni-dettaglio_<from>_<to>.csv`. */
export function detailFileName(from: string, to: string): string {
  return `attivazioni-dettaglio_${from}_${to}.csv`;
}

/** `ERR_STREAM_PREMATURE_CLOSE`: the client went away while the file was being written. */
function isClientGone(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/**
 * Translates HTTP into {@link ActivationsService} calls. The CSV is checked (perimeter and size) before the first byte, then streamed through `pipeline`, which honours the backpressure of the connection. At most one export
 * runs at a time for a user (in this process): another is `429 RATE_LIMITED`; the whole export is limited to the time of the other exports.
 *
 * @param service The service.
 * @param exportTimeoutMs Longest an export may take (tests lower it).
 */
export function createActivationsController(service: ActivationsService, exportTimeoutMs = EXPORT_TIMEOUT_MS): ActivationsController {
  const running = new Set<string>();
  return {
    summary: async (_req, res) => {
      const { rows, ...rest } = await service.summary(res.locals.auth!, inputOf<SummaryQuery>(res, 'query'));
      // The rows are the data; the totals and the renewal base are siblings of it.
      res.status(200).json({ data: rows, ...rest });
    },
    statement: async (_req, res) => {
      const { page, lines, totals, ...rest } = await service.statementPage(res.locals.auth!, inputOf<StatementParams>(res, 'params').dealerId, inputOf<StatementQuery>(res, 'query'));
      // The lines are the data; the totals (of the whole section, with `amountCents` and `projection12Cents` for both sections) and the prices are siblings of it.
      const view = 'instalmentCents' in totals ? { ...totals, amountCents: totals.instalmentCents, projection12Cents: totals.annualCents } : totals;
      res.status(200).json({ data: lines, page: { limit: page.limit, next: page.next }, totals: view, ...rest });
    },
    statementCsv: (_req, res) => exclusive(res, async () => {
      const { dealerId } = inputOf<StatementParams>(res, 'params');
      const query = inputOf<StatementCsvQuery>(res, 'query');
      const statement = await service.statement(res.locals.auth!, dealerId, query);
      await sendCsv(res, csvFileName(query.month, query.section, dealerId), statement.lines.map((line) => ({ dealerName: statement.dealer.name, line })));
    }),
    detail: async (_req, res) => {
      const { page, lines, ...rest } = await service.detailPage(res.locals.auth!, inputOf<DetailQuery>(res, 'query'));
      res.status(200).json({ data: lines, page: { limit: page.limit, next: page.next }, ...rest });
    },
    detailCsv: (_req, res) => exclusive(res, async () => {
      const query = inputOf<DetailCsvQuery>(res, 'query');
      const detail = await service.detail(res.locals.auth!, query);
      await sendCsv(res, detailFileName(query.from, query.to), detail.entries.map((entry) => ({ dealerName: entry.dealer.name, line: entry.line })));
    }),
    freezeBase: async (req, res) => {
      sendData(res, await service.freezeBase(res.locals.auth!, inputOf<YearParams>(res, 'params'), clientContextOf(req, res)));
    },
    unfreezeBase: async (req, res) => {
      await service.unfreezeBase(res.locals.auth!, inputOf<YearParams>(res, 'params'), clientContextOf(req, res));
      res.status(204).end();
    },
    closeMonth: async (req, res) => {
      sendData(res, await service.closeMonth(res.locals.auth!, inputOf<MonthParams>(res, 'params'), clientContextOf(req, res)));
    },
    reopenMonth: async (req, res) => {
      await service.reopenMonth(res.locals.auth!, inputOf<MonthParams>(res, 'params'), clientContextOf(req, res));
      res.status(204).end();
    },
  };

  /** Runs an export if the user has none running (in this process): another is `429`. */
  async function exclusive(res: Response, work: () => Promise<void>): Promise<void> {
    const user = res.locals.auth!.userId.toHexString();
    if (running.has(user)) {
      throw new AppError('RATE_LIMITED');
    }
    running.add(user);
    try {
      await work();
    } finally {
      running.delete(user);
    }
  }

  async function sendCsv(res: Response, fileName: string, entries: readonly { readonly dealerName: string; readonly line: Line }[]): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    const chunks = function* (): Generator<string> {
      yield `${CSV_BOM}${csvHeader()}`;
      for (let start = 0; start < entries.length; start += 500) {
        yield csvEntries(entries.slice(start, start + 500));
      }
    };
    try {
      await pipeline(Readable.from(chunks()), res, { signal: AbortSignal.timeout(exportTimeoutMs) });
    } catch (error) {
      if (!isClientGone(error)) {
        throw error;
      }
    }
  }
}
