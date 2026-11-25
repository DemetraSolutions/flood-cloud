import type { Databases } from '../../db/databases.ts';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ActivityEntry } from '../../shared/activity-log/activity-log.ts';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { DataAction } from '../../shared/activity-log/catalog.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import { createCatalogLock } from '../../shared/locks/catalog-lock.ts';
import type { CatalogLock } from '../../shared/locks/catalog-lock.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { xlsxChunks } from '../../shared/xlsx/writer.ts';
import type { SheetCounts } from '../catalog-xlsx/catalog-xlsx.import.ts';
import { ImportRefusal } from '../catalog-xlsx/catalog-xlsx.errors.ts';
import type { ReferenceMode } from '../catalog-xlsx/catalog-xlsx.export.ts';
import type { WorkbookService } from '../catalog-xlsx/catalog-xlsx.controller.ts';
import type { RecordRowError } from './records-xlsx.errors.ts';
import { parseRecordWorkbook } from './records-xlsx.sheet.ts';
import type { ParsedRecordSheet, RecordSheet } from './records-xlsx.sheet.ts';

/** Most rows one export holds: more is `413`. */
export const MAX_EXPORT_RECORDS = 20_000;

/** Longest an import may run, in milliseconds: well below the lifetime MongoDB gives a transaction (60 seconds). */
export const MAX_RECORDS_IMPORT_MS = 15_000;

/** Rows read at a time while the workbook is written. */
export const RECORDS_EXPORT_BATCH = 100;

/** What an import did (or, with `dryRun`, would do) and the problems it found. */
export interface RecordsReport {
  readonly counts: SheetCounts;
  readonly errors: readonly RecordRowError[];
  readonly errorCount: number;
}

/** What an import of one sheet is run with. */
export interface RecordsImportInput<Graph> {
  /** The services of the domain over the session of the transaction. */
  readonly graph: Graph;
  readonly principal: AuthPrincipal;
  readonly access: GroupAccess;
  readonly client: ClientContext;
  readonly sheet: ParsedRecordSheet;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** The time, in epoch milliseconds, after which the import is stopped. */
  readonly deadline: number;
}

/** What makes the workbook of a domain different from another one: the sheet, the names, the reads of the export and the rows of the import. */
export interface RecordsDomain<Graph> {
  /** The only sheet of the workbook. */
  readonly sheet: RecordSheet;
  /** The key of the counts in the answer of the import (`contacts`, `cards`). */
  readonly kind: string;
  /** The start of the names of the files (`contacts` for `contacts-model.xlsx` and `contacts_2026-11-25.xlsx`). */
  readonly fileBase: string;
  /** The prefix of the key of the lock of the group (`CONTACTS_LOCK:`). */
  readonly lockPrefix: string;
  /** The entries of the activity log: the actions, the type of the resource and the name of the count of the rows written in the metadata of the export. */
  readonly audit: { readonly exported: DataAction; readonly imported: DataAction; readonly resource: string; readonly exportedKey: string };
  /** How many rows the export has, counted up to `cap + 1`. */
  count(principal: AuthPrincipal, access: GroupAccess, cap: number): Promise<number>;
  /** The rows of the export, read as the generator is consumed: the cells in the order of the columns of the sheet. */
  rows(principal: AuthPrincipal, access: GroupAccess, mode: ReferenceMode): AsyncGenerator<string[]>;
  /** What the import does before it opens the transaction (the unique index of the cards), when it does anything. */
  prepare?(principal: AuthPrincipal, access: GroupAccess): Promise<void>;
  /** The services of the domain over a database accessor (the one of the transaction), writing their log entries to `log`. */
  graphOver(databases: Databases, log: ActivityLog): Graph;
  /** Applies the rows of the sheet through the services of the graph. */
  apply(input: RecordsImportInput<Graph>): Promise<RecordsReport>;
}

/** The collaborators of the workbook of a domain. */
export interface RecordsXlsxDeps {
  readonly databases: Databases;
  readonly activityLog: ActivityLog;
  readonly logger: Logger;
  readonly now: () => number;
  /** The lock of the group (tests replace it); by default one in `common.settings` with the prefix of the domain, shared by every instance of the server. */
  readonly lock?: CatalogLock;
  /** Limits (tests lower them). */
  readonly limits?: { readonly maxImportMs?: number; readonly maxRows?: number; readonly maxExport?: number };
}

/** Thrown inside the transaction to abort it: the file has problems, or the request is a dry run. It carries the report out. */
class Rollback extends Error {
  readonly report: RecordsReport;

  constructor(report: RecordsReport) {
    super('rollback');
    this.report = report;
  }
}

/**
 * An activity log that keeps the entries the services of an import make (exactly as the routes write them) instead of writing them: the import writes them after the commit, with the same request id, so a transaction
 * that is aborted (a file with problems, a dry run) leaves no trace of changes that never happened.
 */
function bufferedLog(): { readonly log: ActivityLog; readonly entries: ActivityEntry[] } {
  const entries: ActivityEntry[] = [];
  return { log: { record: async (entry) => void entries.push(entry) }, entries };
}

/**
 * Builds the service of the workbook of a domain with the same flow as the one of the catalog (`doc/Tasks.md` step C6): the model is the empty sheet; the export streams the rows with a size check before the first byte
 * and an entry in the log with the counts only; the import takes the lock of the group, reads the file, applies every row through the services of the domain inside **one transaction** (all or nothing, a dry run applies
 * and aborts), and after the commit writes the entries of the services and its own summary (never a value of the file).
 *
 * @param domain What differs from one workbook to another.
 * @param deps The collaborators.
 */
export function createRecordsXlsxService<Graph>(domain: RecordsDomain<Graph>, deps: RecordsXlsxDeps): WorkbookService {
  const { databases, activityLog, now } = deps;
  const maxImportMs = deps.limits?.maxImportMs ?? MAX_RECORDS_IMPORT_MS;
  const maxExport = deps.limits?.maxExport ?? MAX_EXPORT_RECORDS;
  const lock = deps.lock ?? createCatalogLock({ databases, logger: deps.logger, prefix: domain.lockPrefix });
  const headers = domain.sheet.columns.map((column) => column.header);
  const log = (entry: Omit<ActivityEntry, 'category' | 'actor'>, principal: AuthPrincipal): Promise<void> => activityLog.record({ category: 'data', actor: actorOf(principal), ...entry });
  const fileName = (suffix: string): string => `${domain.fileBase}${suffix}`;

  return {
    template: async () => ({ chunks: xlsxChunks([{ name: domain.sheet.name, columns: headers, rows: [] }]), fileName: fileName('-model.xlsx') }),

    export: async (principal, access, mode, client) => {
      if ((await domain.count(principal, access, maxExport)) > maxExport) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: `The export has more than ${String(maxExport)} rows` });
      }
      let written = 0;
      const rows = (async function* () {
        for await (const row of domain.rows(principal, access, mode)) {
          written += 1;
          yield row;
        }
      })();
      const chunks = (async function* () {
        let complete = false;
        try {
          yield* xlsxChunks([{ name: domain.sheet.name, columns: headers, rows }]);
          complete = true;
        } finally {
          // The entry says what was written, whether or not the client read it all.
          await log(
            {
              action: domain.audit.exported,
              outcome: complete ? 'success' : 'failure',
              groupId: access.groupId,
              resource: { type: domain.audit.resource },
              requestId: client.requestId,
              ...(client.ip === null ? {} : { ip: client.ip }),
              metadata: { references: mode, [domain.audit.exportedKey]: written },
            },
            principal,
          );
        }
      })();
      return { chunks, fileName: fileName(`_${new Date(now()).toISOString().slice(0, 10)}.xlsx`) };
    },

    import: async (principal, access, file, dryRun, client) => {
      const record = (outcome: 'success' | 'failure', metadata: Record<string, string | number | boolean>): Promise<void> =>
        log({ action: domain.audit.imported, outcome, groupId: access.groupId, resource: { type: domain.audit.resource }, requestId: client.requestId, ...(client.ip === null ? {} : { ip: client.ip }), metadata: { dryRun, ...metadata } }, principal);
      // Taken before anything is read or written, by a dry run too; given back whatever happens.
      const held = await lock.acquire(access.groupId).catch(async (error: unknown) => {
        await record('failure', { reason: 'error' });
        throw error;
      });
      if (held === null) {
        await record('failure', { reason: 'busy' });
        throw new AppError('CONFLICT', { message: 'An import of this group is already running', details: [{ field: 'group', issue: 'busy' }] });
      }
      try {
        let sheet: ParsedRecordSheet;
        try {
          sheet = parseRecordWorkbook(file, domain.sheet, deps.limits?.maxRows);
        } catch (error) {
          await record('failure', { reason: 'file' });
          throw error;
        }
        await domain.prepare?.(principal, access);
        const deadline = now() + maxImportMs;
        let committed: { readonly report: RecordsReport; readonly entries: readonly ActivityEntry[] } | null = null;
        let report: RecordsReport;
        try {
          committed = await inGroupTransaction(principal, access, databases, async (session) => {
            // A new buffer for every attempt: the driver runs the work again on a transient error.
            const buffer = bufferedLog();
            const result = await domain.apply({ graph: domain.graphOver(sessionDatabases(databases, session, access.groupId), buffer.log), principal, access, client, sheet, now, deadline });
            if (result.errorCount > 0 || dryRun) {
              throw new Rollback(result);
            }
            return { report: result, entries: buffer.entries };
          });
          report = committed.report;
        } catch (error) {
          if (!(error instanceof Rollback)) {
            await record('failure', { reason: error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE' ? 'tooSlow' : 'error' });
            throw error;
          }
          report = error.report;
        }
        if (report.errorCount > 0) {
          await record('failure', { reason: 'rows', errors: report.errorCount });
          throw new ImportRefusal(report.errors, report.errorCount);
        }
        // After the commit: the changes of the services, then the summary. The import is valid whatever happens to the log, which never rejects (a failed write goes to the logger).
        try {
          for (const entry of committed?.entries ?? []) {
            await activityLog.record(entry);
          }
          await record('success', { ...report.counts });
        } catch (error) {
          deps.logger.error('the activity entries of a committed import could not be written', { groupId: access.groupId.toHexString(), requestId: client.requestId, error });
        }
        return { dryRun, sheets: { [domain.kind]: report.counts } };
      } finally {
        await held.release();
      }
    },
  };
}
