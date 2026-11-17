/** Why a call to Cerved failed. Never carries a URL, a key, a response body or a VAT number. */
export type CervedFailure =
  /** The request did not finish within the timeout. */
  | 'timeout'
  /** The connection failed (DNS, refused, reset, a redirect that was refused). */
  | 'network'
  /** The provider answered with a status that is not a success. */
  | 'status'
  /** The answer is larger than the adapter accepts. */
  | 'tooLarge'
  /** The answer is not JSON, or has no body. */
  | 'malformed'
  /** The adapter has no key to authenticate with. */
  | 'configuration';

/**
 * The only error of the Cerved adapter. It says what failed (`operation`, `reason`, the HTTP `status` when there is one) and nothing else: the message is
 * built from those, so logging it can never leak a key, a URL, a VAT number or a piece of what the provider answered.
 */
export class CervedError extends Error {
  /** What the adapter was doing: `search` or `profile`. */
  readonly operation: string;
  readonly reason: CervedFailure;
  /** The HTTP status of the answer, `null` when there was none. */
  readonly status: number | null;

  /**
   * @param operation What the adapter was doing.
   * @param reason Why it failed.
   * @param status HTTP status of the answer, if any.
   */
  constructor(operation: string, reason: CervedFailure, status: number | null = null) {
    super(`Cerved ${operation} failed: ${reason}${status === null ? '' : ` (HTTP ${String(status)})`}`);
    this.name = 'CervedError';
    this.operation = operation;
    this.reason = reason;
    this.status = status;
  }
}
