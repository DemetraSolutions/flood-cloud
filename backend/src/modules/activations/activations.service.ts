import { ObjectId } from 'mongodb';
import type { ClientSession } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { ActivationWindow } from '../../shared/security/scope/mirror-activations.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { effectivePrices } from '../settings/price-list.ts';
import type { PriceList } from '../settings/price-list.ts';
import type { SettingsService } from '../settings/settings.service.ts';
import { DEFAULT_LIMITS, activationTotalsOf, compute, renewalTotalsOf } from './activations.engine.ts';
import type { Bucket, EngineLimits } from './activations.engine.ts';
import { decodeDetailCursor, decodeStatementCursor, encodeDetailCursor, encodeStatementCursor } from './activations.cursor.ts';
import { NO_ACTIVATIONS, NO_DEALER_NAME, NO_RENEWALS, compareDetailKeys, compareKeys, detailKeyOf, keyOf, sortDetail, sortLines, toDealerView, toLineView, toRowView, totalsOf } from './activations.mapper.ts';
import type { DealerView, DetailEntry, DetailLineView, LineView, RowView, TotalsView } from './activations.mapper.ts';
import { isFuture, monthOf, monthStart, parseMonth, periodOf, previousMonth, yearPeriodOf } from './activations.period.ts';
import type { YearMonth } from './activations.period.ts';
import type { ActivationsRepository, DealerTarget, GroupFacts } from './activations.repository.ts';
import type { DetailCsvQuery, DetailQuery, MonthParams, StatementCsvQuery, StatementQuery, SummaryQuery, YearParams } from './activations.schemas.ts';
import { STATEMENT_DEFAULT_LIMIT } from './activations.schemas.ts';
import type { ActivationTotals, Closure, DealerRef, Line, RenewalTotals, Section } from './activations.types.ts';

/** Most groups, dealers and closure documents one read holds; more is a data problem and an error. */
const MAX_GROUPS = 20_000;
const MAX_CLOSURES = 5000;

/** The summary of an invoice month. */
export interface SummaryResult {
  /** The invoice month, `YYYY-MM`. */
  readonly month: string;
  /** The month whose activations the invoice holds, `YYYY-MM`. */
  readonly activityMonth: string;
  readonly status: 'open' | 'closed';
  readonly rows: readonly RowView[];
  readonly totals: TotalsView;
  readonly renewalBase: { readonly year: number; readonly frozen: boolean };
}

/** The lines of one section of the statement of a dealer, with what is needed to show and export them. */
export interface Statement {
  readonly dealer: DealerView;
  readonly month: string;
  readonly activityMonth: string;
  readonly section: Section;
  readonly status: 'open' | 'closed';
  readonly renewalBase: { readonly year: number; readonly frozen: boolean };
  /** The totals of the whole section (not of the page). */
  readonly totals: ActivationTotals | RenewalTotals;
  /** The prices applied: the effective list of the dealer, the one stored in the closure for a closed month. */
  readonly prices: PriceList;
  /** The lines, in the order of the statement. */
  readonly lines: readonly Line[];
}

/** A page of a statement. */
export interface StatementPage extends Omit<Statement, 'lines'> {
  readonly lines: readonly LineView[];
  readonly page: PageInfo;
}

/** The detail of the activations of a span of months: every line with its dealer, in the order of the view, and the totals of the whole set. */
export interface Detail {
  /** The first month of the query, or `null` when it had none (from the beginning). */
  readonly from: string | null;
  readonly to: string;
  /** The year of "now" (Rome) the months were counted against: a place of an earlier year counts 12 months, one of this year the months left. */
  readonly referenceYear: number;
  readonly totals: ActivationTotals;
  readonly entries: readonly DetailEntry[];
}

/** A page of the detail of the activations. */
export interface DetailPage {
  readonly from: string | null;
  readonly to: string;
  readonly referenceYear: number;
  readonly totals: ActivationTotals;
  readonly lines: readonly DetailLineView[];
  readonly page: PageInfo;
}

/** The outcome of freezing a renewal base or closing a month. */
export interface ClosingResult {
  readonly period: string;
  /** How many dealer documents were written. */
  readonly dealers: number;
  /** How many lines they hold. */
  readonly lines: number;
}

/** The billing of the activations (the tool of the PSA and of the dealers to know what each dealer must pay). */
export interface ActivationsService {
  /**
   * The summary of an invoice month, one row per dealer by name. The platform administrator sees every dealer that has something (or the one he asks for); a dealer only himself.
   *
   * @param principal The authenticated caller (the route requires `activations:read`).
   * @param query Validated query.
   * @throws {AppError} `FORBIDDEN` when a dealer asks for another dealer or for `none`; `NOT_FOUND` for a dealer that does not exist; `SERVICE_UNAVAILABLE` on a read that exceeds its time limit.
   */
  summary(principal: AuthPrincipal, query: SummaryQuery): Promise<SummaryResult>;
  /**
   * One section of the statement of a dealer for an invoice month, a page of lines.
   *
   * @param principal The authenticated caller.
   * @param dealer The dealer of the path (`none` for the groups with no dealer).
   * @param query Validated query.
   * @throws {AppError} As {@link summary}; `CONFLICT` when the dealer has more lines than a statement holds; `VALIDATION_ERROR` on `cursor`/`format`.
   */
  statementPage(principal: AuthPrincipal, dealer: ObjectId | 'none', query: StatementQuery): Promise<StatementPage>;
  /**
   * Every line of one section of the statement of a dealer, for the CSV.
   *
   * @param principal The authenticated caller.
   * @param dealer The dealer of the path.
   * @param query Validated query.
   * @throws {AppError} As {@link statementPage}.
   */
  statement(principal: AuthPrincipal, dealer: ObjectId | 'none', query: StatementCsvQuery): Promise<Statement>;
  /**
   * A page of every activation of a span of activation months, with the items of its price, always computed live with the current prices (an analysis view, never an invoice). The platform administrator sees every dealer
   * (or the one he asks for), a dealer only himself.
   *
   * @param principal The authenticated caller (the route requires `activations:read`).
   * @param query Validated query.
   * @throws {AppError} `FORBIDDEN`, `NOT_FOUND` as {@link summary}; `CONFLICT` (`tooManyLines`) when the span holds more lines than the view does; `VALIDATION_ERROR` on `cursor`/`format`.
   */
  detailPage(principal: AuthPrincipal, query: DetailQuery): Promise<DetailPage>;
  /**
   * Every line of the detail, for the CSV.
   *
   * @param principal The authenticated caller.
   * @param query Validated query.
   * @throws {AppError} As {@link detailPage}.
   */
  detail(principal: AuthPrincipal, query: DetailCsvQuery): Promise<Detail>;
  /**
   * Freezes the renewal base of a year: the park of every dealer at the end of the year before, with the lines and the prices applied. From then on it never changes.
   *
   * @param principal The authenticated administrator (the route requires `activations:manage`).
   * @param params The year.
   * @param client Request context.
   * @throws {AppError} `CONFLICT` (`alreadyFrozen`, `empty`, `tooManyLines`).
   */
  freezeBase(principal: AuthPrincipal, params: YearParams, client: ClientContext): Promise<ClosingResult>;
  /**
   * Unfreezes the renewal base of a year.
   *
   * @throws {AppError} `CONFLICT` (`notFrozen`, or `monthClosed` while a month of the year is closed).
   */
  unfreezeBase(principal: AuthPrincipal, params: YearParams, client: ClientContext): Promise<void>;
  /**
   * Closes an invoice month for every dealer, in one transaction: the lines of the activations of the month before and the totals of the renewals are stored and never change.
   *
   * @throws {AppError} `CONFLICT` (`future`, `alreadyClosed`, `baseNotFrozen`, `tooManyLines`).
   */
  closeMonth(principal: AuthPrincipal, params: MonthParams, client: ClientContext): Promise<ClosingResult>;
  /**
   * Reopens a closed month: its closure is deleted and it is computed live again.
   *
   * @throws {AppError} `CONFLICT` (`notClosed`).
   */
  reopenMonth(principal: AuthPrincipal, params: MonthParams, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createActivationsService}. */
export interface ActivationsServiceDeps {
  readonly repository: ActivationsRepository;
  /** The price list in force. */
  readonly priceLists: Pick<SettingsService, 'getPriceList'>;
  readonly activityLog: ActivityLog;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
  /** Limits of a computation (tests lower them). */
  readonly limits?: EngineLimits;
}

const conflict = (field: string, issue: string): AppError => new AppError('CONFLICT', { details: [{ field, issue } satisfies ErrorDetail] });

/** What an invoice month is made of. */
interface Months {
  readonly invoice: YearMonth;
  readonly activity: YearMonth;
}

const monthsOf = (text: string): Months => {
  const invoice = parseMonth(text)!;
  return { invoice, activity: previousMonth(invoice) };
};

/**
 * Builds the service of the billing.
 *
 * The month of an activation is never paid. For the invoice month `I` of year `Y` Flood issues two invoices to every dealer: the activations of the month before `I` (each place pays its monthly fee for the months left of its
 * activation year: May gives 7, June to December; December gives 0) and the instalment of the renewals, one twelfth of the annual fee of the park as at 31 December `Y - 1`, which is the sum of the monthly fees of the places
 * activated up to then. Months are the ones of the clock in Rome. A month that is closed is served from its closure and never changes; an open one is computed live, with the renewal base of its year live until it is frozen.
 *
 * @param deps Repository, price list, activity log, clock and limits.
 */
export function createActivationsService(deps: ActivationsServiceDeps): ActivationsService {
  const { repository, activityLog } = deps;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const now = (): Date => new Date(deps.now());

  /** The dealer a request is about: a dealer is forced to himself, the platform administrator may name one (or the groups with no dealer), or none for all. */
  const targetOf = async (principal: AuthPrincipal, requested: ObjectId | 'none' | undefined): Promise<DealerTarget> => {
    if (principal.scope.kind === 'dealer') {
      if (requested !== undefined && !(requested instanceof ObjectId && requested.equals(principal.userId))) {
        throw new AppError('FORBIDDEN');
      }
      return { kind: 'dealer', id: principal.userId };
    }
    // Only the platform administrator and a dealer reach the billing (the route says so): any other perimeter is refused here too.
    if (principal.scope.kind !== 'platform') {
      throw new AppError('FORBIDDEN');
    }
    if (requested === undefined) {
      return { kind: 'all' };
    }
    if (requested === 'none') {
      return { kind: 'none' };
    }
    if ((await repository.readDealers([requested])).size === 0) {
      throw new AppError('NOT_FOUND');
    }
    return { kind: 'dealer', id: requested };
  };

  /** The key of a target that names one dealer in the buckets. */
  const keyOfTarget = (target: DealerTarget): string => (target.kind === 'dealer' ? target.id.toHexString() : 'none');

  /** The groups that count for a target, the dealers they point to, and the prices each pays. */
  const context = async (target: DealerTarget, extraDealers: readonly ObjectId[] = []) => {
    const groupList = await repository.readGroups(target, MAX_GROUPS);
    const groups = new Map<string, GroupFacts>(groupList.map((group) => [group.id.toHexString(), group]));
    const ids = new Map<string, ObjectId>();
    for (const id of [...groupList.flatMap((group) => (group.dealerId === null ? [] : [group.dealerId])), ...extraDealers, ...(target.kind === 'dealer' ? [target.id] : [])]) {
      ids.set(id.toHexString(), id);
    }
    const dealers = await repository.readDealers([...ids.values()]);
    const list = (await deps.priceLists.getPriceList()).list;
    const pricesOf = (key: string): PriceList => effectivePrices(list, key === 'none' ? {} : (dealers.get(key)?.overrides ?? {}));
    const nameOf = (key: string, id: ObjectId | null): string => (id === null ? NO_DEALER_NAME : (dealers.get(key)?.name ?? key));
    return { groups, groupIds: target.kind === 'all' ? null : groupList.map((group) => group.id), dealers, pricesOf, nameOf, empty: groupList.length === 0 };
  };
  type Context = Awaited<ReturnType<typeof context>>;

  /** The lines of a section activated in a window for the groups of a context. With no group to read there is nothing, and nothing is read. */
  const run = async (ctx: Context, window: ActivationWindow, section: Section, keepLines: boolean, referenceYear: number | null = null): Promise<Map<string, Bucket>> => {
    if (ctx.empty) {
      return new Map();
    }
    return compute({ repository, groups: ctx.groups, groupIds: ctx.groupIds, window, section, pricesOf: ctx.pricesOf, now: now(), keepLines, limits, referenceYear });
  };
  /** The lines of a section of an invoice month. */
  const live = (ctx: Context, months: Months, section: Section, keepLines: boolean): Promise<Map<string, Bucket>> =>
    run(ctx, section === 'activations' ? { from: monthStart(months.activity.year, months.activity.month), to: monthStart(months.invoice.year, months.invoice.month) } : { from: null, to: monthStart(months.invoice.year, 1) }, section, keepLines);

  const closureFilter = (kind: Closure['kind'], period: string, target: DealerTarget) => ({ kind, period, ...(target.kind === 'all' ? {} : { dealerId: target.kind === 'none' ? null : target.id }) });
  const refOf = (key: string, id: ObjectId | null, ctx: Context): DealerRef => ({ id, name: ctx.nameOf(key, id) });
  const dealerIdOfKey = (key: string): ObjectId | null => (key === 'none' ? null : ObjectId.createFromHexString(key));
  const noLinesIssue = (): AppError => conflict('lines', 'tooManyLines');

  return {
    summary: async (principal, query) => {
      const target = await targetOf(principal, query.dealerId);
      const months = monthsOf(query.month);
      const period = periodOf(months.invoice);
      const activityMonth = periodOf(months.activity);
      const year = months.invoice.year;
      const closed = await repository.hasClosure('month', period);
      const baseFrozen = closed || (await repository.hasClosure('renewalBase', yearPeriodOf(year)));
      const ctx = await context(target);
      const rows: RowView[] = [];
      if (closed) {
        for (const closure of await repository.readClosures(closureFilter('month', period, target), false, MAX_CLOSURES)) {
          rows.push(toRowView({ dealer: { id: closure.dealerId, name: closure.dealerName }, status: 'closed', activityMonth, activations: closure.activations.totals, year, frozen: true, renewals: closure.renewals.totals }));
        }
        if (target.kind !== 'all' && rows.length === 0) {
          rows.push(toRowView({ dealer: refOf(keyOfTarget(target), target.kind === 'dealer' ? target.id : null, ctx), status: 'closed', activityMonth, activations: NO_ACTIVATIONS, year, frozen: true, renewals: NO_RENEWALS }));
        }
      } else {
        const activations = await live(ctx, months, 'activations', false);
        const renewals = new Map<string, RenewalTotals>();
        if (baseFrozen) {
          for (const closure of await repository.readClosures(closureFilter('renewalBase', yearPeriodOf(year), target), false, MAX_CLOSURES)) {
            renewals.set(closure.dealerId === null ? 'none' : closure.dealerId.toHexString(), closure.renewals.totals);
          }
        } else {
          for (const [key, bucket] of await live(ctx, months, 'renewals', false)) {
            renewals.set(key, renewalTotalsOf(bucket));
          }
        }
        const keys = new Set([...activations.keys(), ...renewals.keys(), ...(target.kind === 'all' ? [] : [keyOfTarget(target)])]);
        for (const key of keys) {
          const dealerId = dealerIdOfKey(key);
          rows.push(toRowView({ dealer: refOf(key, dealerId, ctx), status: 'open', activityMonth, activations: activationTotalsOf(activations.get(key)), year, frozen: baseFrozen, renewals: renewals.get(key) ?? NO_RENEWALS }));
        }
      }
      rows.sort((a, b) => a.dealer.name.localeCompare(b.dealer.name, 'it'));
      return { month: period, activityMonth, status: closed ? 'closed' : 'open', rows, totals: totalsOf(rows), renewalBase: { year, frozen: baseFrozen } };
    },

    statementPage: async (principal, dealer, query) => {
      const statement = await statementOf(principal, dealer, query.month, query.section);
      const limit = query.limit ?? STATEMENT_DEFAULT_LIMIT;
      const after = query.cursor === undefined ? null : decodeStatementCursor(query.cursor);
      const rest = after === null ? statement.lines : statement.lines.filter((line) => compareKeys(keyOf(line), after) > 0);
      const page = rest.slice(0, limit);
      const next = rest.length > limit ? encodeStatementCursor(keyOf(page[page.length - 1]!)) : null;
      return { ...statement, lines: page.map(toLineView), page: { limit, next } };
    },

    statement: (principal, dealer, query) => statementOf(principal, dealer, query.month, query.section),

    detailPage: async (principal, query) => {
      const detail = await detailOf(principal, query);
      const limit = query.limit ?? STATEMENT_DEFAULT_LIMIT;
      const bounded = query.from !== undefined;
      const cursor = query.cursor === undefined ? null : decodeDetailCursor(query.cursor);
      if (cursor !== null && cursor.bounded !== bounded) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'cursor', issue: 'format' }] });
      }
      const after = cursor === null ? null : cursor.key;
      const rest = after === null ? detail.entries : detail.entries.filter((entry) => compareDetailKeys(detailKeyOf(entry), after) > 0);
      const page = rest.slice(0, limit);
      const next = rest.length > limit ? encodeDetailCursor(detailKeyOf(page[page.length - 1]!), bounded) : null;
      return { from: detail.from, to: detail.to, referenceYear: detail.referenceYear, totals: detail.totals, lines: page.map((entry) => ({ ...toLineView(entry.line), dealer: toDealerView(entry.dealer) })), page: { limit, next } };
    },

    detail: (principal, query) => detailOf(principal, query),

    freezeBase: async (principal, params, client) => {
      const period = yearPeriodOf(params.year);
      if (params.year > monthOf(now()).year) {
        throw conflict('year', 'yearInFuture');
      }
      if (await repository.hasClosure('renewalBase', period)) {
        throw conflict('year', 'alreadyFrozen');
      }
      const ctx = await context({ kind: 'all' });
      const buckets = await live(ctx, { invoice: { year: params.year, month: 1 }, activity: { year: params.year - 1, month: 12 } }, 'renewals', true);
      if (buckets.size === 0) {
        throw conflict('year', 'empty');
      }
      if ([...buckets.values()].some((bucket) => bucket.overflow)) {
        throw noLinesIssue();
      }
      const closedAt = now();
      const documents: Closure[] = [...buckets].map(([key, bucket]) => ({
        kind: 'renewalBase',
        period,
        dealerId: bucket.dealerId,
        dealerName: ctx.nameOf(key, bucket.dealerId),
        prices: ctx.pricesOf(key),
        activations: { lines: [], totals: activationTotalsOf(undefined) },
        renewals: { lines: sortLines(bucket.lines), totals: renewalTotalsOf(bucket) },
        closedAt,
        closedBy: principal.userId,
      }));
      await repository.transaction(async (session) => {
        await lock(session, params.year, principal, 'year', 'alreadyFrozen');
        if ((await repository.hasClosure('renewalBase', period, session)) || !(await repository.insertClosures(documents, session))) {
          throw conflict('year', 'alreadyFrozen');
        }
      });
      const result = { period, dealers: documents.length, lines: [...buckets.values()].reduce((sum, bucket) => sum + bucket.lines.length, 0) };
      await log(principal, client, 'activations.renewalBaseFrozen', result);
      return result;
    },

    unfreezeBase: async (principal, params, client) => {
      const period = yearPeriodOf(params.year);
      const deleted = await repository.transaction(async (session) => {
        await lock(session, params.year, principal, 'year', 'notFrozen');
        if (!(await repository.hasClosure('renewalBase', period, session))) {
          throw conflict('year', 'notFrozen');
        }
        if (await repository.hasClosedMonthIn(params.year, session)) {
          throw conflict('year', 'monthClosed');
        }
        return repository.deleteClosures('renewalBase', period, session);
      });
      await log(principal, client, 'activations.renewalBaseUnfrozen', { period, dealers: deleted, lines: 0 });
    },

    closeMonth: async (principal, params, client) => {
      const months = monthsOf(params.month);
      const period = periodOf(months.invoice);
      const year = months.invoice.year;
      if (isFuture(months.invoice, now())) {
        throw conflict('month', 'monthInFuture');
      }
      if (await repository.hasClosure('month', period)) {
        throw conflict('month', 'alreadyClosed');
      }
      const yearPeriod = yearPeriodOf(year);
      // The dealers of the frozen base are read now only to name them; the base the closure is made on is read again inside the transaction.
      const known = await repository.readClosures({ kind: 'renewalBase', period: yearPeriod }, false, MAX_CLOSURES);
      if (known.length === 0) {
        throw conflict('month', 'baseNotFrozen');
      }
      const ctx = await context({ kind: 'all' }, known.flatMap((closure) => (closure.dealerId === null ? [] : [closure.dealerId])));
      const buckets = await live(ctx, months, 'activations', true);
      if ([...buckets.values()].some((bucket) => bucket.overflow)) {
        throw noLinesIssue();
      }
      const closedAt = now();
      let documents: Closure[] = [];
      await repository.transaction(async (session) => {
        await lock(session, year, principal, 'month', 'alreadyClosed');
        const bases = new Map((await repository.readClosures({ kind: 'renewalBase', period: yearPeriod }, false, MAX_CLOSURES, session)).map((closure) => [closure.dealerId === null ? 'none' : closure.dealerId.toHexString(), closure]));
        if (bases.size === 0) {
          throw conflict('month', 'baseNotFrozen');
        }
        if (await repository.hasClosure('month', period, session)) {
          throw conflict('month', 'alreadyClosed');
        }
        documents = [...new Set([...buckets.keys(), ...bases.keys()])].map((key) => {
          const bucket = buckets.get(key);
          const base = bases.get(key);
          const dealerId = dealerIdOfKey(key);
          return {
            kind: 'month',
            period,
            dealerId,
            dealerName: ctx.dealers.get(key)?.name ?? (key === 'none' ? NO_DEALER_NAME : (base?.dealerName ?? key)),
            prices: ctx.pricesOf(key),
            activations: { lines: sortLines(bucket?.lines ?? []), totals: activationTotalsOf(bucket) },
            renewals: { totals: base?.renewals.totals ?? NO_RENEWALS },
            closedAt,
            closedBy: principal.userId,
          };
        });
        if (!(await repository.insertClosures(documents, session))) {
          throw conflict('month', 'alreadyClosed');
        }
      });
      const result = { period, dealers: documents.length, lines: documents.reduce((sum, document) => sum + document.activations.lines.length, 0) };
      await log(principal, client, 'activations.monthClosed', result);
      return result;
    },

    reopenMonth: async (principal, params, client) => {
      const months = monthsOf(params.month);
      const period = periodOf(months.invoice);
      const deleted = await repository.transaction(async (session) => {
        await lock(session, months.invoice.year, principal, 'month', 'notClosed');
        if (!(await repository.hasClosure('month', period, session))) {
          throw conflict('month', 'notClosed');
        }
        return repository.deleteClosures('month', period, session);
      });
      await log(principal, client, 'activations.monthReopened', { period, dealers: deleted, lines: 0 });
    },
  };

  /** The detail of the activations of a span: the places activated from the first day of the first month (or from the beginning) to the end of the last one (months of Rome), live, for the groups of the target. */
  async function detailOf(principal: AuthPrincipal, query: DetailCsvQuery): Promise<Detail> {
    const target = await targetOf(principal, query.dealerId);
    const first = query.from === undefined ? null : parseMonth(query.from)!;
    const last = parseMonth(query.to)!;
    const ctx = await context(target);
    const referenceYear = monthOf(now()).year;
    const buckets = await run(ctx, { from: first === null ? null : monthStart(first.year, first.month), to: monthStart(last.year, last.month + 1) }, 'activations', true, referenceYear);
    const entries = [...buckets].flatMap(([key, bucket]) => bucket.lines.map((line) => ({ dealer: refOf(key, bucket.dealerId, ctx), line })));
    if ([...buckets.values()].some((bucket) => bucket.overflow) || entries.length > limits.maxLines) {
      throw noLinesIssue();
    }
    const total = (pick: (bucket: Bucket) => number): number => [...buckets.values()].reduce((sum, bucket) => sum + pick(bucket), 0);
    const monthlyCents = total((bucket) => bucket.monthlyCents);
    return {
      from: query.from ?? null,
      to: query.to,
      referenceYear,
      totals: { places: total((bucket) => bucket.places), monthlyCents, amountCents: total((bucket) => bucket.amountCents), projection12Cents: monthlyCents * 12, anomalies: total((bucket) => bucket.anomalies) },
      entries: sortDetail(entries),
    };
  }

  /** Writes the lock document of a year inside a transaction: see {@link ActivationsRepository.lockYear}. A lock that cannot be written because another transaction created it first is the conflict the caller names. */
  async function lock(session: ClientSession, year: number, principal: AuthPrincipal, field: string, issue: string): Promise<void> {
    if (!(await repository.lockYear(year, principal.userId, now(), session))) {
      throw conflict(field, issue);
    }
  }

  /** The statement of a dealer: from the closure when the month is closed, live otherwise. */
  async function statementOf(principal: AuthPrincipal, requested: ObjectId | 'none', monthText: string, section: Section): Promise<Statement> {
    const target = await targetOf(principal, requested);
    const months = monthsOf(monthText);
    const period = periodOf(months.invoice);
    const year = months.invoice.year;
    const key = keyOfTarget(target);
    const dealerId = target.kind === 'dealer' ? target.id : null;
    const closed = await repository.hasClosure('month', period);
    const baseFrozen = closed || (await repository.hasClosure('renewalBase', yearPeriodOf(year)));
    const ctx = await context(target);
    const base = { dealer: toDealerView(refOf(key, dealerId, ctx)), month: period, activityMonth: periodOf(months.activity), section, status: closed ? ('closed' as const) : ('open' as const), renewalBase: { year, frozen: baseFrozen } };
    const own = (kind: Closure['kind'], at: string) => repository.readClosures({ kind, period: at, dealerId }, true, 1).then((found) => found[0] ?? null);

    if (section === 'activations') {
      if (closed) {
        const closure = await own('month', period);
        return { ...base, totals: closure?.activations.totals ?? NO_ACTIVATIONS, prices: closure?.prices ?? ctx.pricesOf(key), lines: sortLines(closure?.activations.lines ?? []) };
      }
      const bucket = (await live(ctx, months, 'activations', true)).get(key);
      if (bucket?.overflow === true) {
        throw noLinesIssue();
      }
      return { ...base, totals: activationTotalsOf(bucket), prices: ctx.pricesOf(key), lines: sortLines(bucket?.lines ?? []) };
    }
    const monthClosure = closed ? await own('month', period) : null;
    if (baseFrozen) {
      const frozen = await own('renewalBase', yearPeriodOf(year));
      return { ...base, totals: monthClosure?.renewals.totals ?? frozen?.renewals.totals ?? NO_RENEWALS, prices: frozen?.prices ?? ctx.pricesOf(key), lines: sortLines(frozen?.renewals.lines ?? []) };
    }
    const bucket = (await live(ctx, months, 'renewals', true)).get(key);
    if (bucket?.overflow === true) {
      throw noLinesIssue();
    }
    return { ...base, totals: renewalTotalsOf(bucket), prices: ctx.pricesOf(key), lines: sortLines(bucket?.lines ?? []) };
  }

  /** Records a billing operation of the PSA. */
  function log(principal: AuthPrincipal, client: ClientContext, action: 'activations.renewalBaseFrozen' | 'activations.renewalBaseUnfrozen' | 'activations.monthClosed' | 'activations.monthReopened', result: ClosingResult): Promise<void> {
    return recordDataChange(activityLog, {
      actor: actorOf(principal),
      resource: { type: 'activations', id: result.period },
      action,
      before: undefined,
      after: undefined,
      metadata: { period: result.period, dealers: result.dealers, lines: result.lines },
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });
  }
}
