/**
 * The analysis of one queue record without sending it: the same preparation the upload job runs (read of the linked
 * invoice, mapping, validation, duplicate check against the sent history, serialization, size check), reduced to a report.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { HUB_PATTERN, parseHub } from '../accounts/hub.ts';
import { prepareInvoice } from '../engine/prepare.ts';
import type { GroupStore } from '../engine/groups.ts';
import { ARUBA_TRANSMITTER } from '../providers/aruba/settings.ts';
import type { DuplicateLookup } from '../validation/duplicates.ts';
import type { ValidationIssue } from '../validation/issue.ts';
import { MAX_REPORT_ISSUES } from './reports.ts';
import type { ReportIssue, ShadowOutcome, ShadowReport } from './reports.ts';

/** The transmitter (`IdTrasmittente`) of a provider. */
export interface Transmitter {
  readonly IdPaese: string;
  readonly IdCodice: string;
}

/**
 * The transmitters by provider: constants of the provider modules, so no adapter (and no credential) is needed to know
 * what the file would carry.
 */
export const SHADOW_TRANSMITTERS: ReadonlyMap<string, Transmitter> = new Map([['aruba', ARUBA_TRANSMITTER]]);

/** What {@link analyseRecord} needs. */
export interface AnalyseOptions {
  /** Transmitter by provider; a record of another provider is skipped. */
  readonly transmitters: ReadonlyMap<string, Transmitter>;
  /** Read access to the original of a credit note: nothing else of the group store. */
  readonly groups: Pick<GroupStore, 'readOriginal'>;
  /** The duplicate lookup of one record against the sent history (read-only). */
  readonly lookupFor: (queueId: ObjectId) => DuplicateLookup;
  /** Worker clock (the sending day is today in Europe/Rome). */
  readonly now: number;
  readonly codeVersion: string;
}

/** The result of {@link analyseRecord}: a report, or why the record was left out. */
export type Analysis =
  | { readonly kind: 'report'; readonly report: ShadowReport }
  | { readonly kind: 'skipped'; readonly reason: 'hub' | 'provider'; readonly hub?: string };

/** Keeps the fields of the issues a report may hold. */
function toReportIssues(issues: readonly ValidationIssue[]): ReportIssue[] {
  return issues.slice(0, MAX_REPORT_ISSUES).map(({ code, path, severity }) => ({ code, path, severity }));
}

function groupIdOf(record: Document): string | null {
  const value: unknown = record['groupId'];
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value) ? value : null;
}

/** The sha-256 and size of a file, or nulls. */
function fingerprint(xml: string | undefined): { xmlBytes: number | null; xmlSha256: string | null } {
  return xml === undefined ? { xmlBytes: null, xmlSha256: null } : { xmlBytes: Buffer.byteLength(xml, 'utf8'), xmlSha256: createHash('sha256').update(xml, 'utf8').digest('hex') };
}

/**
 * Builds the report of a record that kept failing to be analysed (an unexpected error each time).
 *
 * @param record The queue record (an `ObjectId` `_id` is required).
 * @param hub The hub of the record.
 * @param options Code version and clock.
 * @returns A `blocked` report with a single `ANALYSIS_ERROR` issue.
 */
export function failedReport(record: Document, hub: string, options: Pick<AnalyseOptions, 'codeVersion' | 'now'>): ShadowReport {
  const type: unknown = (record['fattura_elettronica'] as Document | undefined)?.['tipo'];
  return {
    queueId: record['_id'] as ObjectId,
    hub,
    groupId: groupIdOf(record),
    documentType: typeof type === 'string' ? type : null,
    number: null,
    date: null,
    outcome: 'blocked',
    issues: [{ code: 'ANALYSIS_ERROR', path: '', severity: 'error' }],
    xmlBytes: null,
    xmlSha256: null,
    codeVersion: options.codeVersion,
    analysedAt: new Date(options.now),
  };
}

/**
 * The hub of a record, when it is usable.
 *
 * @param record A queue record.
 * @returns The hub, or `undefined` when it is absent or malformed.
 */
export function hubOf(record: Document): string | undefined {
  const hub: unknown = ((record['company'] as Document | undefined)?.['fattura_elettronica'] as Document | undefined)?.['hub'];
  return typeof hub === 'string' && HUB_PATTERN.test(hub) ? hub : undefined;
}

/**
 * Runs the preparation of the upload job on a record and reduces the result to a report. It reads (the linked invoice
 * of a credit note, the sent history) and never writes.
 *
 * @param record The whole queue record (its `_id` is an `ObjectId`: the shadow queue reads no other).
 * @param options Transmitters, read ports, clock and code version.
 * @returns The report, or why the record was skipped (no usable hub, a provider without transmitter).
 * @throws Whatever the group read or the duplicate lookup throws (the caller retries later).
 */
export async function analyseRecord(record: Document, options: AnalyseOptions): Promise<Analysis> {
  const id = record['_id'] as ObjectId;
  const hub = hubOf(record);
  if (hub === undefined) {
    return { kind: 'skipped', reason: 'hub' };
  }
  const transmitter = options.transmitters.get(parseHub(hub).provider);
  if (transmitter === undefined) {
    return { kind: 'skipped', reason: 'provider', hub };
  }
  const prepared = await prepareInvoice(record, { transmitter, groups: options.groups, lookup: options.lookupFor(id), now: options.now });
  const rawType: unknown = (record['fattura_elettronica'] as Document | undefined)?.['tipo'];
  const base = { queueId: id, hub, groupId: groupIdOf(record), codeVersion: options.codeVersion, analysedAt: new Date(options.now) };
  if (prepared.ok) {
    const outcome: ShadowOutcome = prepared.warnings.length > 0 ? 'warnings' : 'ok';
    const { number, date, documentType, xml } = prepared.file;
    return { kind: 'report', report: { ...base, documentType, number, date, outcome, issues: toReportIssues(prepared.warnings), ...fingerprint(xml) } };
  }
  const outcome: ShadowOutcome = prepared.issues.some((entry) => entry.code === 'MAPPING') ? 'mappingFailed' : 'blocked';
  const { document } = prepared;
  return {
    kind: 'report',
    report: {
      ...base,
      documentType: document?.documentType ?? (typeof rawType === 'string' ? rawType : null),
      number: document?.number ?? null,
      date: document?.date ?? null,
      outcome,
      issues: toReportIssues(prepared.issues),
      ...fingerprint(prepared.xml),
    },
  };
}
