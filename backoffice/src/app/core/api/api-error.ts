import { HttpErrorResponse } from '@angular/common/http';
import {
  API_ERROR_CODES,
  ApiErrorBody,
  ApiErrorCode,
  ApiErrorDetail,
  ApiErrorRow,
  ClientErrorCode,
} from './api.types';

/** Name of the response header carrying the backend request identifier. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Name of the response header carrying the seconds to wait after a `429`. */
export const RETRY_AFTER_HEADER = 'Retry-After';

/** Error raised for any failed call to the backend API, normalised from the HTTP failure. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** HTTP status, `0` when no response was received. */
  readonly status: number;
  /** Backend error code, or a client-side code for network and unexpected failures. */
  readonly code: ApiErrorCode | ClientErrorCode;
  /** Per-field details of a `422` response, empty otherwise. */
  readonly details: readonly ApiErrorDetail[];
  /** Problems of a refused workbook (`422` of the catalog import), empty otherwise. */
  readonly rows: readonly ApiErrorRow[];
  /** How many problems a refused workbook has, `null` when the response does not say. */
  readonly errorCount: number | null;
  /** Whether a refused workbook has more problems than `rows` lists. */
  readonly moreErrors: boolean;
  /** Value of the `X-Request-Id` response header, `null` when absent. */
  readonly requestId: string | null;
  /** Seconds to wait before retrying, from the `Retry-After` header; `null` when absent or invalid. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: ApiErrorCode | ClientErrorCode;
    message: string;
    details?: readonly ApiErrorDetail[];
    rows?: readonly ApiErrorRow[];
    errorCount?: number | null;
    moreErrors?: boolean;
    requestId?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? [];
    this.rows = init.rows ?? [];
    this.errorCount = init.errorCount ?? null;
    this.moreErrors = init.moreErrors ?? false;
    this.requestId = init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/** Parses a `Retry-After` header expressed in whole seconds (the form the backend sends). */
function parseRetryAfter(value: string | null): number | null {
  return value !== null && /^\d{1,6}$/.test(value) ? Number(value) : null;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): ApiErrorDetail[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const details: ApiErrorDetail[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || typeof item['field'] !== 'string' || typeof item['issue'] !== 'string') {
      return null;
    }
    details.push({ field: item['field'], issue: item['issue'] });
  }
  return details;
}

/** Keeps the well-formed problems of a workbook; anything else in the list is dropped. */
function parseRows(value: unknown): ApiErrorRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: ApiErrorRow[] = [];
  for (const item of value as unknown[]) {
    if (
      isRecord(item) &&
      typeof item['sheet'] === 'string' &&
      (item['row'] === null || typeof item['row'] === 'number') &&
      (item['column'] === null || typeof item['column'] === 'string') &&
      typeof item['code'] === 'string' &&
      typeof item['message'] === 'string'
    ) {
      rows.push({
        sheet: item['sheet'],
        row: item['row'],
        column: item['column'],
        code: item['code'],
        message: item['message'],
      });
    }
  }
  return rows;
}

/**
 * Validates an HTTP error body against the standard error envelope (allowlist).
 *
 * @param body Parsed response body of unknown shape.
 * @returns The validated error payload, or `null` when the body does not conform.
 */
export function parseApiErrorBody(body: unknown): ApiErrorBody['error'] | null {
  if (!isRecord(body) || !isRecord(body['error'])) {
    return null;
  }
  const { code, message, details } = body['error'];
  if (typeof code !== 'string' || !KNOWN_CODES.has(code) || typeof message !== 'string') {
    return null;
  }
  const parsedDetails = parseDetails(details);
  if (parsedDetails === null) {
    return null;
  }
  const { rows, errorCount, moreErrors } = body['error'];
  return {
    code: code as ApiErrorCode,
    message,
    details: parsedDetails,
    ...(rows === undefined ? {} : { rows: parseRows(rows) }),
    ...(typeof errorCount === 'number' ? { errorCount } : {}),
    ...(moreErrors === true ? { moreErrors } : {}),
  };
}

/**
 * Converts a failed HTTP response of the backend API into an {@link ApiError}.
 * Network failures (status 0) become `NETWORK_ERROR`; non-conforming bodies become
 * `UNKNOWN_ERROR` without exposing the body.
 *
 * @param response The failed HTTP response.
 */
export function toApiError(response: HttpErrorResponse): ApiError {
  const requestId = response.headers.get(REQUEST_ID_HEADER);
  const retryAfterSeconds = parseRetryAfter(response.headers.get(RETRY_AFTER_HEADER));
  if (response.status === 0) {
    return new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Network error', requestId });
  }
  const parsed = parseApiErrorBody(response.error);
  if (parsed === null) {
    return new ApiError({
      status: response.status,
      code: 'UNKNOWN_ERROR',
      message: 'Unexpected error response',
      requestId,
      retryAfterSeconds,
    });
  }
  return new ApiError({
    status: response.status,
    code: parsed.code,
    message: parsed.message,
    details: parsed.details,
    rows: parsed.rows,
    errorCount: parsed.errorCount,
    moreErrors: parsed.moreErrors,
    requestId,
    retryAfterSeconds,
  });
}

/**
 * Maps the per-field details of a `422` error to the first issue of each field.
 *
 * @param error The API error.
 * @returns Field name to issue code; empty for errors without details.
 */
export function fieldErrors(error: ApiError): Readonly<Record<string, string>> {
  const byField = new Map<string, string>();
  for (const detail of error.details) {
    if (!byField.has(detail.field)) {
      byField.set(detail.field, detail.issue);
    }
  }
  return Object.fromEntries(byField);
}

/**
 * Returns the dictionary key of the user-facing message for an error code.
 * Single central mapping from API errors to translatable messages.
 *
 * @param error The API error.
 */
export function apiErrorMessageKey(error: ApiError): string {
  return `ERRORS.API.${error.code}`;
}
