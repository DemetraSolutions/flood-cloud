/** Maps every error code of `doc/API-Guidelines.md` §5 to its HTTP status. */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  MALFORMED_JSON: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  CLOCK_SKEW: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

/** A machine-readable error code exposed in the `error.code` field. */
export type ErrorCode = keyof typeof ERROR_STATUS;

/** Generic client-safe message used when no specific one is provided. */
export const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'Bad request',
  MALFORMED_JSON: 'Malformed JSON',
  UNAUTHENTICATED: 'Authentication required',
  TOKEN_EXPIRED: 'Token expired',
  CLOCK_SKEW: 'Clock skew too large',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  CONFLICT: 'Conflict',
  PRECONDITION_FAILED: 'Precondition failed',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  VALIDATION_ERROR: 'Invalid request',
  RATE_LIMITED: 'Too many requests',
  QUOTA_EXCEEDED: 'Quota exceeded',
  INTERNAL_ERROR: 'Internal server error',
  SERVICE_UNAVAILABLE: 'Service unavailable',
};

/** Per-field validation detail of a `VALIDATION_ERROR`. */
export interface ErrorDetail {
  readonly field: string;
  readonly issue: string;
}

/** Optional parts of an {@link AppError}. */
export interface AppErrorOptions {
  /** Client-safe message; defaults to the generic message of the code. */
  readonly message?: string;
  /** Per-field details, exposed in `error.details`. */
  readonly details?: readonly ErrorDetail[];
  /** Extra response headers, for example `Allow` or `Retry-After`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Expected, client-facing error. Thrown anywhere in the request pipeline and
 * rendered by the central error handler with the standard envelope.
 *
 * @example
 * throw new AppError('NOT_FOUND');
 * throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': '30' } });
 */
export class AppError extends Error {
  /** Machine-readable code. */
  readonly code: ErrorCode;
  /** HTTP status derived from the code. */
  readonly status: number;
  /** Per-field details, if any. */
  readonly details: readonly ErrorDetail[] | undefined;
  /** Extra response headers. */
  readonly headers: Readonly<Record<string, string>>;

  /**
   * @param code Error code; its status comes from {@link ERROR_STATUS}.
   * @param options Optional message, details and headers.
   */
  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}
