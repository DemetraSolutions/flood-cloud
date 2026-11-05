import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { enumOf, integerString, optional, string } from '../validation/schema.ts';
import { AppError } from './errors.ts';
import type { PageInfo } from './envelope.ts';

/** Page size applied when the client sends no `limit`. */
export const DEFAULT_LIMIT = 50;

/** Largest page a client may ask for. */
export const MAX_LIMIT = 200;

/** Longest search text (`q`). */
export const MAX_SEARCH_LENGTH = 64;

/** Longest sort value, in UTF-8 bytes, that travels in a cursor. A longer string sorts as a missing value. */
export const MAX_CURSOR_VALUE_BYTES = 256;

/**
 * Longest opaque cursor accepted: the largest one this server issues, measured in characters. Its JSON is
 * at most 80 bytes of keys and id plus the value, whose worst case is {@link MAX_CURSOR_VALUE_BYTES} control
 * characters escaped to six bytes each (1616 bytes), which base64url writes in 2155 characters.
 */
export const MAX_CURSOR_LENGTH = 2200;

/** Time limit, in milliseconds, of every list query. */
export const LIST_MAX_TIME_MS = 5000;

/** Version number written in every cursor; a cursor of another version is refused. */
const CURSOR_VERSION = 1;

/** Name of the computed field the list is sorted and paged by: the stored value when it has the expected type, else null. */
export const SORT_KEY = '__sortKey';

/** Kind of the stored value a list is sorted by. */
export type SortKind = 'string' | 'date';

/** One field a list can be sorted by. */
export interface SortField {
  /** Stored field (dotted path allowed). */
  readonly field: string;
  readonly kind: SortKind;
}

/** What a resource says about its list: sortable fields, default order and searchable fields. */
export interface ListConfig {
  /** Public sort name (`username`) to stored field; `-name` is the descending form. */
  readonly sorts: Readonly<Record<string, SortField>>;
  /** Public sort name used when the client sends no `sort` (ascending). */
  readonly defaultSort: string;
  /** Stored fields `q` is searched in (case-insensitive, literal text). */
  readonly searchFields: readonly string[];
}

/**
 * The query parameters every list has, as a schema shape to spread into the `object` of the route
 * (`object({ ...listQueryShape(config), status: optional(...) })`). Numbers arrive as digit strings and
 * are converted explicitly; a repeated parameter is a `type` problem; `sort` accepts only the names
 * (and their `-name` form) the resource declares.
 *
 * @param config The resource's list description.
 */
export function listQueryShape(config: ListConfig) {
  const tokens = Object.keys(config.sorts).flatMap((name) => [name, `-${name}`]);
  return {
    limit: optional(integerString({ min: 1, max: MAX_LIMIT })),
    cursor: optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false })),
    sort: optional(enumOf(tokens)),
    q: optional(string({ min: 1, max: MAX_SEARCH_LENGTH, trim: true })),
  };
}

/** Where the previous page ended. */
export interface ListCursor {
  /** Value of the sort field of the last item; `null` when it had none. A date travels as epoch milliseconds. */
  readonly value: string | number | null;
  /** `_id` of the last item, the tie-breaker. */
  readonly id: ObjectId;
}

/** A list request after validation, defaults and cursor decoding. */
export interface ListParams {
  /** Page size, 1 to {@link MAX_LIMIT}. */
  readonly limit: number;
  /** Sort token: the public name, with a leading `-` for descending. */
  readonly sort: string;
  /** Search text, trimmed, or `null`. */
  readonly q: string | null;
  /** Where to continue from, or `null` for the first page. */
  readonly cursor: ListCursor | null;
}

/** Escapes a string for literal use inside a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function malformedCursor(): AppError {
  return new AppError('VALIDATION_ERROR', { details: [{ field: 'cursor', issue: 'format' }] });
}

/** The field and direction a sort token stands for. */
function sortOf(token: string, config: ListConfig): { readonly spec: SortField; readonly direction: 1 | -1 } {
  const descending = token.startsWith('-');
  return { spec: config.sorts[descending ? token.slice(1) : token]!, direction: descending ? -1 : 1 };
}

/**
 * Encodes a cursor: base64url of `{ ver, s, v, id }`. It holds the sort token, the value of the sort
 * field of the last item (which the client can already see) and its id, nothing else.
 */
function encodeCursor(token: string, value: string | number | null, id: ObjectId): string {
  return Buffer.from(JSON.stringify({ ver: CURSOR_VERSION, s: token, v: value, id: id.toHexString() })).toString('base64url');
}

/**
 * Decodes and validates a cursor against the sort of the request.
 *
 * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for anything that is not a cursor this server
 * issued for this sort: bad alphabet, bad JSON, other keys, another version, another sort, a value of the wrong type.
 */
function decodeCursor(raw: string, token: string, spec: SortField): ListCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw malformedCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw malformedCursor();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformedCursor();
  }
  const cursor = parsed as Record<string, unknown>;
  const keys = Object.keys(cursor).sort();
  const { ver, s, v, id } = cursor;
  const valueFits =
    v === null ||
    (spec.kind === 'string' && typeof v === 'string' && Buffer.byteLength(v) <= MAX_CURSOR_VALUE_BYTES && v.isWellFormed()) ||
    (spec.kind === 'date' && typeof v === 'number' && Number.isSafeInteger(v) && !Number.isNaN(new Date(v).getTime()));
  if (keys.join() !== 'id,s,v,ver' || ver !== CURSOR_VERSION || s !== token || typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id) || !valueFits) {
    throw malformedCursor();
  }
  return { value: v as string | number | null, id: ObjectId.createFromHexString(id) };
}

/**
 * Turns the validated query into list parameters: applies the defaults and decodes the cursor.
 *
 * @param query The validated `limit`, `cursor`, `sort` and `q`.
 * @param config The resource's list description.
 * @returns The parameters.
 * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
 */
export function listParamsOf(query: { readonly limit?: number; readonly cursor?: string; readonly sort?: string; readonly q?: string }, config: ListConfig): ListParams {
  const sort = query.sort ?? config.defaultSort;
  return {
    limit: query.limit ?? DEFAULT_LIMIT,
    sort,
    q: query.q ?? null,
    cursor: query.cursor === undefined ? null : decodeCursor(query.cursor, sort, sortOf(sort, config).spec),
  };
}

/** The condition that selects what comes after the cursor in the order of the sort, `null` values sorting first. */
function afterCursor(cursor: ListCursor, spec: SortField, direction: 1 | -1): Filter<Document> {
  const operator = direction === 1 ? '$gt' : '$lt';
  if (cursor.value === null) {
    // Items without the value come first ascending and last descending, and tie on `_id`.
    return direction === 1 ? { $or: [{ [SORT_KEY]: null, _id: { [operator]: cursor.id } }, { [SORT_KEY]: { $ne: null } }] } : { [SORT_KEY]: null, _id: { [operator]: cursor.id } };
  }
  const value = spec.kind === 'date' ? new Date(cursor.value) : cursor.value;
  const later: Filter<Document>[] = [{ [SORT_KEY]: { [operator]: value } }, { [SORT_KEY]: value, _id: { [operator]: cursor.id } }];
  return { $or: direction === 1 ? later : [...later, { [SORT_KEY]: null }] };
}

/**
 * The filter that comes from the search text, to be applied to the stored fields before anything else.
 *
 * @param params The list parameters.
 * @param config The resource's list description.
 * @returns A MongoDB filter (`{}` when there is no search).
 */
export function listSearch(params: ListParams, config: ListConfig): Filter<Document> {
  if (params.q === null) {
    return {};
  }
  const pattern = escapeRegExp(params.q);
  return { $or: config.searchFields.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } })) };
}

/**
 * The aggregation that reads one page: the scope-limited filter, the sort key, the cursor, the order and the cut.
 * The sort key is computed in the database as the stored value when it has the type the sort expects
 * (a string of at most {@link MAX_CURSOR_VALUE_BYTES} bytes, or a date) and null otherwise, so the order the
 * database applies and the one the cursor continues are the same for every document, whatever irregular value
 * the legacy stored. The order is the key and `_id` as the tie-breaker in the same direction, applied before the cut.
 *
 * @param match The filter of the request, already combined with the scope through `withScope`.
 * @param params The list parameters.
 * @param config The resource's list description.
 * @param projection Fields to return (inclusion projection); the sort key is always returned.
 * @returns The pipeline, reading `limit + 1` documents.
 */
export function listPipeline(match: Filter<Document>, params: ListParams, config: ListConfig, projection: Readonly<Record<string, 1>>): Document[] {
  const { spec, direction } = sortOf(params.sort, config);
  const stored = '$' + spec.field;
  const key =
    spec.kind === 'date'
      ? { $cond: [{ $eq: [{ $type: stored }, 'date'] }, stored, null] }
      : { $cond: [{ $and: [{ $eq: [{ $type: stored }, 'string'] }, { $lte: [{ $strLenBytes: stored }, MAX_CURSOR_VALUE_BYTES] }] }, stored, null] };
  return [
    { $match: match },
    { $addFields: { [SORT_KEY]: key } },
    ...(params.cursor === null ? [] : [{ $match: afterCursor(params.cursor, spec, direction) }]),
    { $sort: { [SORT_KEY]: direction, _id: direction } },
    { $limit: params.limit + 1 },
    { $project: { ...projection, [SORT_KEY]: 1 } },
  ];
}

/** One page cut from the documents of a query made with `limit + 1`. */
export interface ListPage {
  /** At most `limit` documents. */
  readonly items: Document[];
  /** Page metadata for the response. */
  readonly page: PageInfo;
}

function valueAt(document: Document): string | number | null {
  const raw: unknown = document[SORT_KEY];
  return raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? raw : null;
}

/**
 * Cuts the page out of the documents read with {@link listPipeline} (a limit of `limit + 1`): when the extra
 * document is there, another page follows and the cursor points just after the last document kept.
 *
 * @param documents Up to `limit + 1` documents in the order of the pipeline, each with its sort key.
 * @param params The list parameters.
 * @returns The documents of the page and `{ limit, next }`.
 */
export function pageOf(documents: readonly Document[], params: ListParams): ListPage {
  const items = documents.slice(0, params.limit);
  // With more than `limit` documents the page is never empty: `limit` is at least 1.
  const last = items[items.length - 1]!;
  const next = documents.length > params.limit ? encodeCursor(params.sort, valueAt(last), last['_id'] as ObjectId) : null;
  return { items, page: { limit: params.limit, next } };
}
