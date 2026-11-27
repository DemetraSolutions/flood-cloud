import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import { readNumberingSetup } from '../../shared/security/scope/group-mirror.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import type { NumberingCompany, NumberingPlace, NumberingSeries } from './numbering.resolve.ts';

/** The series a counter is kept for: the numbered ones and the progressive of the electronic invoice sending (one per company and year across every type and sectional). */
export type CounterSeries = NumberingSeries | '_sendProgressive';

/** What of a company and of its point of sale the numbering depends on. */
export interface NumberingSetup {
  readonly company: NumberingCompany & { readonly lastInvoiceNumber: unknown };
  readonly place: NumberingPlace & { readonly timezone: unknown };
}

/** The key of a counter. */
export interface CounterKey {
  readonly companyId: ObjectId;
  readonly series: CounterSeries;
  /** The sectional, `''` for none. */
  readonly prefixSuffix: string;
  readonly year: number;
}

/** The counters of the numbering and the documents they are aligned with, as the numbering service sees them. Every read and write is scoped to the group of the verified access. */
export interface NumberingRepository {
  /** The company and the point of sale, read from the copies of the group in the common database; `null` when either is not of the group, or the place is not of the company. */
  readSetup(principal: ScopeHolder, access: GroupAccess, companyId: ObjectId, placeId: ObjectId): Promise<NumberingSetup | null>;
  /** The highest `number` of the documents of a company with a type and a sectional (`''` also stands for none stored) dated in `[start, end)`; `null` when there is none. */
  maxNumber(principal: ScopeHolder, access: GroupAccess, query: { readonly companyId: ObjectId; readonly type: NumberingSeries; readonly prefixSuffix: string; readonly start: Date; readonly end: Date }): Promise<number | null>;
  /** The highest `fattura_elettronica.progressivo_invio` of the documents of a company, of any type and sectional, dated in `[start, end)`; `null` when there is none. */
  maxSendProgressive(principal: ScopeHolder, access: GroupAccess, query: { readonly companyId: ObjectId; readonly start: Date; readonly end: Date }): Promise<number | null>;
  /**
   * Whether the company has numbered, with no sectional, before the year of the query: a counter of the same series of another year, or a document of the same type dated before the start of the year. The last invoice number issued outside Flood is a base
   * only for the first year a company numbers, never for the years that follow.
   */
  hasEarlierNumbering(principal: ScopeHolder, access: GroupAccess, query: { readonly companyId: ObjectId; readonly series: NumberingSeries; readonly year: number; readonly start: Date }): Promise<boolean>;
  /**
   * Moves a counter forward in one atomic update: `last` becomes `max(last, floor) + 1` (the counter is created when it is not there) and the new value is returned. Two transactions that move the same counter write the same document, so one of them is
   * a write conflict and runs again on the state the other committed: the numbers are never repeated.
   */
  advance(principal: ScopeHolder, access: GroupAccess, key: CounterKey, floor: number, now: Date): Promise<number>;
}

/** A stored number as the whole number it stands for. */
const wholeNumber = (raw: unknown): number => Math.max(0, Math.floor(raw as number));

/**
 * Builds the repository over a database accessor: the real one, or the one bound to the session of a transaction (`sessionDatabases`) so every read and write is part of it. The documents are only read, never written.
 *
 * @param databases Database accessor.
 */
export function createNumberingRepository(databases: Databases): NumberingRepository {
  return {
    readSetup: async (principal, access, companyId, placeId) => {
      const { company, place } = await bounded(() => readNumberingSetup(principal, access, databases, companyId, placeId));
      if (company === null || place === null || !(place['companyId'] instanceof ObjectId) || !place['companyId'].equals(companyId)) {
        return null;
      }
      const settings = company['settings'] as { readonly global?: { readonly lastInvoiceNumber?: unknown } } | undefined;
      return { company: { invoicesPS: company['invoicesPS'], invoicesPSValues: company['invoicesPSValues'], lastInvoiceNumber: settings?.global?.lastInvoiceNumber }, place: { invoicePS: place['invoicePS'], timezone: place['timezone'] } };
    },

    maxNumber: async (principal, access, query) => {
      const found = await bounded(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('documents')
          .find(
            { companyId: query.companyId, type: query.type, prefixSuffix: query.prefixSuffix === '' ? { $in: ['', null] } : query.prefixSuffix, number: { $type: 'number' }, date: { $gte: query.start, $lt: query.end } },
            { projection: { _id: 0, number: 1 }, sort: { number: -1 }, limit: 1, maxTimeMS: LIST_MAX_TIME_MS },
          )
          .toArray(),
      );
      return found.length === 0 ? null : wholeNumber(found[0]!['number']);
    },

    hasEarlierNumbering: async (principal, access, query) => {
      const db = groupDatabaseFor(principal, access, databases);
      const counters = await bounded(() =>
        db
          .collection('document_counters')
          .find({ companyId: query.companyId, series: query.series, prefixSuffix: '', year: { $ne: query.year } }, { projection: { _id: 1 }, limit: 1, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      if (counters.length > 0) {
        return true;
      }
      const documents = await bounded(() =>
        db
          .collection('documents')
          .find({ companyId: query.companyId, type: query.series, prefixSuffix: { $in: ['', null] }, date: { $lt: query.start } }, { projection: { _id: 1 }, limit: 1, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      return documents.length > 0;
    },

    maxSendProgressive: async (principal, access, query) => {
      const found = await bounded(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('documents')
          .find(
            { companyId: query.companyId, date: { $gte: query.start, $lt: query.end }, 'fattura_elettronica.progressivo_invio': { $type: 'number' } },
            { projection: { _id: 0, 'fattura_elettronica.progressivo_invio': 1 }, sort: { 'fattura_elettronica.progressivo_invio': -1 }, limit: 1, maxTimeMS: LIST_MAX_TIME_MS },
          )
          .toArray(),
      );
      return found.length === 0 ? null : wholeNumber((found[0]!['fattura_elettronica'] as { readonly progressivo_invio: unknown }).progressivo_invio);
    },

    advance: async (principal, access, key, floor, now) => {
      // With `upsert` the equality fields of the filter are the key of the counter a new one is created with; the pipeline then sets the rest.
      const counter = await groupDatabaseFor(principal, access, databases)
        .collection('document_counters')
        .findOneAndUpdate(
          { companyId: key.companyId, series: key.series, prefixSuffix: key.prefixSuffix, year: key.year },
          [{ $set: { last: { $add: [{ $max: [{ $ifNull: ['$last', 0] }, floor] }, 1] }, insertDate: { $ifNull: ['$insertDate', now] }, updateDate: now } }],
          { upsert: true, returnDocument: 'after', projection: { _id: 0, last: 1 }, maxTimeMS: LIST_MAX_TIME_MS },
        );
      // `upsert` and `returnDocument: 'after'` always return the counter.
      return (counter as unknown as { readonly last: number }).last;
    },
  };
}
