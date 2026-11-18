import { ObjectId } from 'mongodb';
import { MAX_CURSOR_LENGTH } from '../../shared/http/list.ts';
import { enumOf, integerString, object, optional, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';
import { MAX_YEAR, MIN_YEAR, parseMonth } from './activations.period.ts';
import { SECTIONS } from './activations.types.ts';

/** Largest page of a statement. */
export const STATEMENT_MAX_LIMIT = 100;

/** Default page of a statement. */
export const STATEMENT_DEFAULT_LIMIT = 50;

/** A month, `YYYY-MM`, of the years 2020 to 2100. */
const month = (): Schema<string, false> => refine(string({ min: 7, max: 7, normalize: false }), (value) => (parseMonth(value) === null ? [''] : []), 'format');

/** A year from 2020 to 2100, as digits. */
const year = (): Schema<number, false> => refine(transform(string({ min: 4, max: 4, pattern: /^\d{4}$/, normalize: false }), (value) => Number(value), 'format'), (value) => (value < MIN_YEAR || value > MAX_YEAR ? [''] : []), 'format');

/** A dealer of the path or the query: the id of a dealer, or `none` for the groups with no dealer. */
const dealerRef = (): Schema<ObjectId | 'none', false> =>
  transform(string({ min: 1, max: 24, normalize: false }), (value): ObjectId | 'none' | undefined => (value === 'none' ? 'none' : /^[0-9a-fA-F]{24}$/.test(value) ? ObjectId.createFromHexString(value) : undefined), 'format');

/** Query of `GET /v1/activations`: the invoice month and, optionally, one dealer. Unknown parameters are refused. */
export const summaryQuery = object({ month: month(), dealerId: optional(dealerRef()) });

/** Validated query of the summary. */
export type SummaryQuery = Infer<typeof summaryQuery>;

/** Query of `GET /v1/activations/statements/{dealerId}`: the invoice month, the section and the cursor pagination. */
export const statementQuery = object({
  month: month(),
  section: enumOf(SECTIONS),
  limit: optional(integerString({ min: 1, max: STATEMENT_MAX_LIMIT })),
  cursor: optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false })),
});

/** Validated query of a statement. */
export type StatementQuery = Infer<typeof statementQuery>;

/** Query of the CSV of a statement: the invoice month and the section, with no pagination. */
export const statementCsvQuery = object({ month: month(), section: enumOf(SECTIONS) });

/** Validated query of the CSV of a statement. */
export type StatementCsvQuery = Infer<typeof statementCsvQuery>;

/** Path parameters of the statement routes. */
export const statementParams = object({ dealerId: dealerRef() });

/** Validated path parameters of a statement. */
export type StatementParams = Infer<typeof statementParams>;

/** Path parameters of the routes on a renewal base. */
export const yearParams = object({ year: year() });

/** Validated path parameters of a renewal base. */
export type YearParams = Infer<typeof yearParams>;

/** Path parameters of the routes on a month closure. */
export const monthParams = object({ month: month() });

/** Validated path parameters of a month closure. */
export type MonthParams = Infer<typeof monthParams>;


/** The longest span of the detail view, in months, both ends included. */
export const DETAIL_MAX_MONTHS = 24;

/** The months since year 0 of a month text already validated: it orders and measures spans. */
function monthIndex(text: string): number {
  const value = parseMonth(text)!;
  return value.year * 12 + value.month;
}

/** The span, in months, from the first to the last month of a validated query (negative when it is reversed). */
function spanMonths(value: unknown): number {
  const { from, to } = value as { from: string; to: string };
  return monthIndex(to) - monthIndex(from);
}

/**
 * An object with the span of the detail view: the first and the last activation month, and one dealer, plus whatever else the route takes. A start after the end is `minimum` on `to`; a longer span than
 * {@link DETAIL_MAX_MONTHS} is `maximum` on `to`.
 */
function spanOf<E extends Record<string, Schema<unknown>>>(extra: E) {
  return refine(
    refine(object({ from: month(), to: month(), dealerId: optional(dealerRef()), ...extra }), (value) => (spanMonths(value) < 0 ? ['to'] : []), 'minimum'),
    (value) => (spanMonths(value) >= DETAIL_MAX_MONTHS ? ['to'] : []),
    'maximum',
  );
}

/** Query of `GET /v1/activations/lines`: the span, the dealer and the cursor pagination. */
export const detailQuery = spanOf({ limit: optional(integerString({ min: 1, max: STATEMENT_MAX_LIMIT })), cursor: optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false })) });

/** Validated query of the detail view. */
export type DetailQuery = Infer<typeof detailQuery>;

/** Query of `GET /v1/activations/lines.csv`: the filters, with no pagination. */
export const detailCsvQuery = spanOf({});

/** Validated query of the CSV of the detail view. */
export type DetailCsvQuery = Infer<typeof detailCsvQuery>;
