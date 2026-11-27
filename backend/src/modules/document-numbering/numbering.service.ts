import { ObjectId } from 'mongodb';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { Databases } from '../../db/databases.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { createNumberingRepository } from './numbering.repository.ts';
import type { NumberingRepository, NumberingSetup } from './numbering.repository.ts';
import type { NumberingIndexGuard } from './numbering.indexes.ts';
import { fiscalYearOf, numberingBase, resolvePrefixSuffix } from './numbering.resolve.ts';
import type { NumberingAnomaly, NumberingSeries, PrefixSuffixPosition } from './numbering.resolve.ts';

/** What a caller says to reserve a number: the company and the point of sale (already resolved and checked by the caller), the series and the date of the document. Nothing else comes from a client. */
export interface ReserveNumberInput {
  readonly companyId: ObjectId;
  readonly placeId: ObjectId;
  readonly series: NumberingSeries;
  /** The date of the document: its fiscal year is the calendar year of this instant in the time zone of the point of sale. */
  readonly date: Date;
}

/** The number a document was given. */
export interface NumberReservation {
  /** The number, a whole number of at least 1, never given to another document of the same company, series, sectional and year. */
  readonly number: number;
  /** The name of the sectional, `''` for none. */
  readonly prefixSuffix: string;
  /** Where the name of the sectional goes in the printed number. */
  readonly prefixSuffixPosition: PrefixSuffixPosition;
  /** The fiscal year the number belongs to. */
  readonly year: number;
  /** What was found wrong in the setup and gone around; never an error, the caller decides what to show. */
  readonly anomalies: NumberingAnomaly[];
}

/** What a caller says to reserve a send progressive: the company and the point of sale and the date of the document. */
export interface ReserveSendProgressiveInput {
  readonly companyId: ObjectId;
  readonly placeId: ObjectId;
  readonly date: Date;
}

/** The progressive of the sending of an electronic invoice a document was given. */
export interface SendProgressiveReservation {
  /** `progressivo_invio`: a whole number of at least 1, unique for the company and the fiscal year across every type and sectional. */
  readonly progressive: number;
  /** The fiscal year it belongs to. */
  readonly year: number;
  readonly anomalies: NumberingAnomaly[];
}

/** The single entry point of the numbering of the fiscal documents. */
export interface NumberingService {
  /**
   * Makes sure the group has the indexes of the numbering. It runs outside a transaction: a caller that holds one open (`nested`) calls it before opening it, and the reservations in that transaction refuse to run when it did not.
   *
   * @throws {Error} When the unique index of the counters could not be created: no number is given without it.
   */
  ensureIndexes(principal: ScopeHolder, access: GroupAccess): Promise<void>;
  /**
   * Reserves the next number of a series for a company, a sectional and a year, in a transaction on the cluster of the group (the one of the caller when `nested`): if that transaction does not commit, the number is not consumed. The sectional is the one of the
   * point of sale, then the one of the cash desks, then none; the year is the one of the date in the time zone of the point of sale. The counter is aligned with the highest number already in the documents of the same company, type, sectional and year (the legacy
   * writes them, with no counter) and, for the invoices without a sectional of a year with no document, and only the first year the company numbers, with the last invoice number issued outside Flood (`lastInvoiceNumber` of the company). Concurrent reservations of the same counter are serialized by the
   * write conflict on the counter, so they get different, consecutive numbers.
   *
   * @param principal The authenticated caller.
   * @param access The verified group access.
   * @param input The company, the point of sale, the series and the date.
   * @returns The number with its sectional and year and the anomalies.
   * @throws {RangeError} When an id is not an `ObjectId`, the series is unknown or the date is not a valid date between the years 1970 and 9998 (a bug of the caller).
   * @throws {Error} When the company or the point of sale is not of the group (or the point of sale is not of the company), or the indexes are missing (a bug of the caller, who has resolved them already).
   */
  reserveNumber(principal: ScopeHolder, access: GroupAccess, input: ReserveNumberInput): Promise<NumberReservation>;
  /**
   * Reserves the next `progressivo_invio` of a company and a fiscal year, the same way as {@link NumberingService.reserveNumber}: one counter for all the types and sectionals, aligned with the highest `progressivo_invio` of the documents of the company in the year, with
   * no base. It is separate from the number because only the documents sent as electronic invoices have it, so the others never consume one.
   *
   * @param principal The authenticated caller.
   * @param access The verified group access.
   * @param input The company, the point of sale and the date.
   * @returns The progressive with its year and the anomalies.
   * @throws {RangeError} As {@link NumberingService.reserveNumber}.
   * @throws {Error} As {@link NumberingService.reserveNumber}.
   */
  reserveSendProgressive(principal: ScopeHolder, access: GroupAccess, input: ReserveSendProgressiveInput): Promise<SendProgressiveReservation>;
}

/** Collaborators of {@link createNumberingService}. */
export interface NumberingServiceDeps {
  /** The database accessor: the real one, or (with `nested`) the one bound to the transaction of the caller. */
  readonly databases: Databases;
  /** Whether `databases` is already the accessor of an open transaction (`sessionDatabases`): the work then joins it instead of opening another one (a sale numbers its invoice inside its own transaction). */
  readonly nested?: boolean;
  /** Makes sure the group has the indexes of the numbering. */
  readonly indexes: NumberingIndexGuard;
  /** Builds the repository over a database accessor (the default builds the real one; a test wraps it). */
  readonly repositoryOver?: (databases: Databases) => NumberingRepository;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

const SERIES: readonly NumberingSeries[] = ['invoice', 'credit-note'];

/** Checks what a caller must have guaranteed. */
function assertInput(input: { readonly companyId: ObjectId; readonly placeId: ObjectId }): void {
  if (!(input.companyId instanceof ObjectId) || !(input.placeId instanceof ObjectId)) {
    throw new RangeError('A numbering needs the ids of the company and of the place');
  }
}

/**
 * Builds the numbering service: the one place that gives numbers and progressives to the fiscal documents, so that they are never repeated whoever asks (the points of sale, the backoffice, any other client of this backend).
 *
 * @param deps The collaborators.
 */
export function createNumberingService(deps: NumberingServiceDeps): NumberingService {
  const repositoryOver = deps.repositoryOver ?? ((databases: Databases) => createNumberingRepository(databases));

  /** Makes sure the unique index is there: asks the guard outside a transaction, and only checks what it confirmed inside one. */
  const requireIndexes = async (principal: ScopeHolder, access: GroupAccess): Promise<void> => {
    const there = deps.nested === true ? deps.indexes.confirmed(access) : await deps.indexes.ensure(principal, access);
    if (!there) {
      throw new Error('The unique index of the counters of the numbering is not available: no number is given without it');
    }
  };

  /** The company and the point of sale of the group the caller resolved already. */
  const setupOf = async (repository: NumberingRepository, principal: ScopeHolder, access: GroupAccess, input: { readonly companyId: ObjectId; readonly placeId: ObjectId }): Promise<NumberingSetup> => {
    const setup = await repository.readSetup(principal, access, input.companyId, input.placeId);
    if (setup === null) {
      throw new Error('The company or the point of sale of a numbering is not of the group');
    }
    return setup;
  };

  /** Runs `work` in a transaction on the cluster of the group, over a repository that makes every read and write part of it (the driver may repeat `work`, so it keeps nothing between attempts but its result). */
  const inTransaction = <T>(principal: ScopeHolder, access: GroupAccess, work: (repository: NumberingRepository) => Promise<T>): Promise<T> =>
    deps.nested === true ? work(repositoryOver(deps.databases)) : inGroupTransaction(principal, access, deps.databases, (session) => work(repositoryOver(sessionDatabases(deps.databases, session, access.groupId))));

  return {
    ensureIndexes: (principal, access) => requireIndexes(principal, access),

    reserveNumber: async (principal, access, input) => {
      assertInput(input);
      if (!SERIES.includes(input.series)) {
        throw new RangeError('The series of a numbering is invoice or credit-note');
      }
      await requireIndexes(principal, access);
      const setup = await setupOf(repositoryOver(deps.databases), principal, access, input);
      const fiscal = fiscalYearOf(input.date, setup.place.timezone);
      const sectional = resolvePrefixSuffix(setup.company, setup.place);
      return inTransaction(principal, access, async (repository) => {
        const highest = await repository.maxNumber(principal, access, { companyId: input.companyId, type: input.series, prefixSuffix: sectional.name, start: fiscal.start, end: fiscal.end });
        // The last number issued outside Flood is the base only where it can be: invoices with no sectional, in a year in which no document has been issued yet and only the first year the company numbers (the years after restart from 1).
        const candidate = input.series === 'invoice' && sectional.name === '' && highest === null ? numberingBase(setup.company.lastInvoiceNumber) : 0;
        const base = candidate > 0 && !(await repository.hasEarlierNumbering(principal, access, { companyId: input.companyId, series: input.series, year: fiscal.year, start: fiscal.start })) ? candidate : 0;
        const number = await repository.advance(principal, access, { companyId: input.companyId, series: input.series, prefixSuffix: sectional.name, year: fiscal.year }, Math.max(highest ?? 0, base), new Date(deps.now()));
        return { number, prefixSuffix: sectional.name, prefixSuffixPosition: sectional.position, year: fiscal.year, anomalies: [...sectional.anomalies, ...fiscal.anomalies] };
      });
    },

    reserveSendProgressive: async (principal, access, input) => {
      assertInput(input);
      await requireIndexes(principal, access);
      const setup = await setupOf(repositoryOver(deps.databases), principal, access, input);
      const fiscal = fiscalYearOf(input.date, setup.place.timezone);
      return inTransaction(principal, access, async (repository) => {
        const highest = await repository.maxSendProgressive(principal, access, { companyId: input.companyId, start: fiscal.start, end: fiscal.end });
        const progressive = await repository.advance(principal, access, { companyId: input.companyId, series: '_sendProgressive', prefixSuffix: '', year: fiscal.year }, highest ?? 0, new Date(deps.now()));
        return { progressive, year: fiscal.year, anomalies: fiscal.anomalies };
      });
    },
  };
}
