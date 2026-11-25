/** Why a call to a provider failed: a closed set, so a caller can decide on it and a log can carry it. */
export type HttpFailure =
  /** The connection failed (DNS, refused, reset, a redirect that was refused). */
  | 'network'
  /** The attempt, or the whole call with its retry, did not finish in time (the body included). */
  | 'timeout'
  /** The provider answered with a status that is not a success; the status is in {@link ProviderHttpError.status}. */
  | 'status'
  /** The answer is not what was asked for: not JSON, no body, not declared as JSON, or an origin other than the configured one. */
  | 'invalidResponse'
  /** The answer is larger than the client accepts. */
  | 'tooLarge';

/**
 * The only error of the HTTP client of the integrations. It says who (`provider`), what (`operation`), why (`reason`) and the HTTP `status` when there is one, and nothing
 * else: the message is built from those and there is no `cause`, so logging or serializing it can never leak a URL (a provider key may sit in its query), a header, a body or a
 * piece of what the provider answered.
 */
export class ProviderHttpError extends Error {
  /** The provider the call was for (`Cerved`, `Satispay`…). */
  readonly provider: string;
  /** What the caller was doing (`search`, `profile`…). */
  readonly operation: string;
  readonly reason: HttpFailure;
  /** The HTTP status of the answer, `null` when there was none. */
  readonly status: number | null;

  /**
   * @param provider The provider the call was for.
   * @param operation What the caller was doing.
   * @param reason Why it failed.
   * @param status HTTP status of the answer, if any.
   */
  constructor(provider: string, operation: string, reason: HttpFailure, status: number | null = null) {
    super(`${provider} ${operation} failed: ${reason}${status === null ? '' : ` (HTTP ${String(status)})`}`);
    this.name = 'ProviderHttpError';
    this.provider = provider;
    this.operation = operation;
    this.reason = reason;
    this.status = status;
  }
}
