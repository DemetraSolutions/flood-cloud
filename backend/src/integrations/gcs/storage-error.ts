/** Why a call to the object storage failed. Never carries a URL, a token, a response body or an object name. */
export type StorageFailure =
  /** The request did not finish within the timeout. */
  | 'timeout'
  /** The connection failed (DNS, refused, reset). */
  | 'network'
  /** The provider answered with a status the adapter does not accept (after the retries, for a transient one). */
  | 'status'
  /** The token endpoint refused the credentials or answered something that is not a token. */
  | 'auth'
  /** The object already exists and is not the one this call was uploading (an upload never overwrites). */
  | 'exists'
  /** A response the adapter cannot read. */
  | 'malformed'
  /** The credentials file or the settings are not usable. */
  | 'configuration';

/**
 * The only error of the storage adapter. It says what failed (`operation`, `reason`, the HTTP `status` when there is one) and nothing else: the
 * message is built from those, so logging it can never leak a URL, a token or an object name.
 */
export class StorageError extends Error {
  /** What the adapter was doing: `upload`, `delete`, `token`, `startup`. */
  readonly operation: string;
  readonly reason: StorageFailure;
  /** The HTTP status of the answer, `null` when there was none. */
  readonly status: number | null;

  /**
   * @param operation What the adapter was doing.
   * @param reason Why it failed.
   * @param status HTTP status of the answer, if any.
   */
  constructor(operation: string, reason: StorageFailure, status: number | null = null) {
    super(`Storage ${operation} failed: ${reason}${status === null ? '' : ` (HTTP ${String(status)})`}`);
    this.name = 'StorageError';
    this.operation = operation;
    this.reason = reason;
    this.status = status;
  }
}
