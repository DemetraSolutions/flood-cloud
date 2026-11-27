/**
 * The shadow reports (`einvoicingShadowReports`, common database): one document per queue record and code version, the
 * result of running the whole send pipeline on the record **without sending it**.
 *
 * A report holds the outcome, the issues (`code`, `path`, `severity`: never a message and never a value), the size and the
 * SHA-256 of the XML that would have been sent, and the identity of the document (number and date as they would appear).
 * It never holds the XML nor any buyer or seller datum. A unique index on `{ queueId, codeVersion }` makes the analysis
 * idempotent; a TTL index on `analysedAt` removes a report after 30 days.
 *
 * @module
 */
import type { Collection, ObjectId } from 'mongodb';
import { MAX_TIME_MS } from '../db/timeouts.ts';

/** Name of the collection (in the common database) that holds the reports. */
export const SHADOW_COLLECTION = 'einvoicingShadowReports';

/** Lifetime of a report, in seconds (30 days). */
export const SHADOW_TTL_SECONDS = 30 * 86_400;

/** Most issues kept in one report. */
export const MAX_REPORT_ISSUES = 50;

/** How the analysis of a record ended: it would be sent as is, sent with warnings, refused, or it could not be mapped. */
export const SHADOW_OUTCOMES = ['ok', 'warnings', 'blocked', 'mappingFailed'] as const;

/** One of {@link SHADOW_OUTCOMES}. */
export type ShadowOutcome = (typeof SHADOW_OUTCOMES)[number];

/** An issue as the report keeps it: where and how serious, never the message. */
export interface ReportIssue {
  readonly code: string;
  readonly path: string;
  readonly severity: 'error' | 'warning';
}

/** One report. */
export interface ShadowReport {
  readonly queueId: ObjectId;
  readonly hub: string;
  /** The group of the record (24 hexadecimal characters), `null` when the record has none that is valid. */
  readonly groupId: string | null;
  readonly documentType: string | null;
  /** The number as it would appear in the invoice, `null` when the record could not be mapped. */
  readonly number: string | null;
  /** The invoice date (`YYYY-MM-DD`), `null` when the record could not be mapped. */
  readonly date: string | null;
  readonly outcome: ShadowOutcome;
  readonly issues: readonly ReportIssue[];
  /** Size of the XML in bytes, `null` when none was built. */
  readonly xmlBytes: number | null;
  /** SHA-256 of the XML (hexadecimal), `null` when none was built. */
  readonly xmlSha256: string | null;
  readonly codeVersion: string;
  readonly analysedAt: Date;
}

/** The report collection. */
export interface ShadowReports {
  /** Creates the unique index on `{ queueId, codeVersion }` and the TTL index on `analysedAt` (idempotent). */
  ensureIndexes(): Promise<void>;
  /**
   * Tells which of the records already have a report for the code version.
   *
   * @param queueIds At most a page of record ids.
   * @param codeVersion The code version.
   * @returns The ids (hexadecimal) that have one.
   */
  analysed(queueIds: readonly ObjectId[], codeVersion: string): Promise<Set<string>>;
  /** Stores a report; one that already exists for `{ queueId, codeVersion }` is left untouched. */
  save(report: ShadowReport): Promise<void>;
}

/**
 * Creates the report collection access.
 *
 * @param collection The `einvoicingShadowReports` collection.
 * @returns The access.
 */
export function createShadowReports(collection: Collection<ShadowReport>): ShadowReports {
  return {
    async ensureIndexes() {
      await collection.createIndex({ queueId: 1, codeVersion: 1 }, { name: 'shadow_queue_version', unique: true, maxTimeMS: MAX_TIME_MS });
      await collection.createIndex({ analysedAt: 1 }, { name: 'shadow_ttl', expireAfterSeconds: SHADOW_TTL_SECONDS, maxTimeMS: MAX_TIME_MS });
    },

    async analysed(queueIds, codeVersion) {
      const found = await collection.find({ queueId: { $in: [...queueIds] }, codeVersion }, { projection: { queueId: 1 }, limit: queueIds.length, maxTimeMS: MAX_TIME_MS }).toArray();
      return new Set(found.map((entry) => entry.queueId.toHexString()));
    },

    async save(report) {
      const { queueId, codeVersion, ...rest } = report;
      await collection.updateOne({ queueId, codeVersion }, { $setOnInsert: rest }, { upsert: true, maxTimeMS: MAX_TIME_MS });
    },
  };
}
