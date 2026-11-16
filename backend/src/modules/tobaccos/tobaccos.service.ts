import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { xlsxErrorToAppError } from '../../shared/xlsx/errors.ts';
import { AppError } from '../../shared/http/errors.ts';
import { DEFAULT_XLSX_LIMITS } from '../../shared/xlsx/limits.ts';
import type { XlsxLimits } from '../../shared/xlsx/limits.ts';
import { readXlsx } from '../../shared/xlsx/reader.ts';
import { TOBACCOS_LIST } from './tobaccos.list.ts';
import { toTobaccoRow } from './tobaccos.mapper.ts';
import type { TobaccoRow } from './tobaccos.mapper.ts';
import type { TobaccosRepository } from './tobaccos.repository.ts';
import type { TobaccosQuery } from './tobaccos.schemas.ts';
import { MAX_BARCODE_PAIRS, MAX_TOBACCOS, parseTobaccoSheet } from './tobaccos.sheet.ts';

/**
 * The limits of the reader for this file, far tighter than the general ones (the list has at most {@link MAX_TOBACCOS} products and 29 columns): a file of the national list is under a megabyte,
 * and the event loop is blocked while it is read, so nothing that cannot be a price list is read for longer than a fraction of a second.
 */
export const IMPORT_LIMITS: Partial<XlsxLimits> = Object.freeze({
  maxRows: MAX_TOBACCOS + 5000,
  maxColumns: 9 + MAX_BARCODE_PAIRS * 2,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
  maxCellTextTotal: 20 * 1024 * 1024,
  maxCellChars: DEFAULT_XLSX_LIMITS.maxCellChars,
});

/** A page of the price list. */
export interface TobaccosPage {
  readonly items: TobaccoRow[];
  readonly page: PageInfo;
}

/** What an import reports: the counts and how long it took. */
export interface ImportResult {
  /** Products of the new list. */
  readonly inserted: number;
  /** Products of the list that was replaced. */
  readonly previous: number;
  /** Milliseconds from the start of the import (the file already received) to the end of the replacement. */
  readonly elapsedMs: number;
}

/** Business rules of the national tobacco price list. */
export interface TobaccosService {
  /**
   * A page of the list.
   *
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor this server did not issue for this sort.
   */
  list(query: TobaccosQuery): Promise<TobaccosPage>;
  /**
   * Replaces the whole list with the products of an official XLSX file. The file is read and **every** row is checked first; only when the whole file is valid the list is replaced, in one transaction.
   *
   * @param principal The authenticated caller.
   * @param file The file, already known to be a ZIP (magic bytes) and within the size limit.
   * @param client Request context, for the activity log.
   * @returns The counts and the elapsed time.
   * @throws {AppError} `VALIDATION_ERROR` (422): the file is not a workbook the reader accepts (`file`/`incorrect`), has no product, has too many, or has rows that are not valid (one detail per problem, with the row and the field).
   */
  importList(principal: AuthPrincipal, file: Buffer, client: ClientContext): Promise<ImportResult>;
}

/** Dependencies of {@link createTobaccosService}. */
export interface TobaccosDeps {
  readonly repository: TobaccosRepository;
  readonly activityLog: ActivityLog;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

/**
 * Builds the price list service.
 *
 * @param deps Repository, activity log and clock.
 */
export function createTobaccosService(deps: TobaccosDeps): TobaccosService {
  const { repository, activityLog, now } = deps;
  return {
    list: async (query) => {
      const { items, page } = await repository.list(listParamsOf(query, TOBACCOS_LIST), query.category ?? null);
      return { items: items.map(toTobaccoRow), page };
    },

    importList: async (principal, file, client) => {
      const started = now();
      const refuse = async (error: AppError, reason: 'file' | 'rows'): Promise<never> => {
        // A refused file leaves a trace too (the reason only, never a content): replacing the list of the platform is a sensitive operation.
        await activityLog.record({
          category: 'data',
          action: 'tobaccos.imported',
          outcome: 'failure',
          actor: actorOf(principal),
          resource: { type: 'tobaccos' },
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
          metadata: { reason },
        });
        throw error;
      };
      let rows;
      try {
        rows = readXlsx(file, IMPORT_LIMITS).rows;
      } catch (error) {
        const refusal = xlsxErrorToAppError(error);
        return refusal === null ? Promise.reject(error as Error) : refuse(refusal, 'file');
      }
      let documents;
      try {
        documents = parseTobaccoSheet(rows);
      } catch (error) {
        return refuse(error as AppError, 'rows');
      }
      const { previous } = await repository.replaceAll(documents);
      const result: ImportResult = { inserted: documents.length, previous, elapsedMs: now() - started };
      // Counts only: no product, no price and no name of the file ever reaches the log.
      await activityLog.record({
        category: 'data',
        action: 'tobaccos.imported',
        outcome: 'success',
        actor: actorOf(principal),
        resource: { type: 'tobaccos' },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
        metadata: { inserted: result.inserted, previous: result.previous },
      });
      return result;
    },
  };
}
