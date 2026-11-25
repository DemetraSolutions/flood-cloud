import { ApiError } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';

/** What a failed call of the module asks of the host page and what it shows to the user. */
export interface IntegrationFailure {
  /** The text for the user. */
  readonly message: string;
  /** Whether the place changed meanwhile (`412`): the page must be read again. */
  readonly stale: boolean;
}

/**
 * Whether the outcome of a failed attempt is unknown: the request may have been handled (a lost
 * answer, a server error). The user may repeat the same attempt, which must carry the same
 * `Idempotency-Key`; any other failure is a definitive answer and the next attempt is a new one.
 *
 * @param error The caught error.
 */
export function outcomeUnknown(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

/** The first detail of a `422`, `undefined` when there is none. */
function firstDetail(error: ApiError): { field: string; issue: string } | undefined {
  return error.details[0];
}

/**
 * The message of a failed call, in the vocabulary of the user. Nothing the provider said is ever
 * shown (the backend never sends it); a `502` is always the same sentence and is never retried
 * by the client.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 * @param own The field of the call itself (`activationCode`): its issue is shown as that field's.
 */
export function integrationFailure(
  i18n: I18nService,
  error: unknown,
  own: string | null = null,
): IntegrationFailure {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PRECONDITION_FAILED':
        return { message: i18n.t('INTEGRATIONS.STALE'), stale: true };
      case 'PROVIDER_ERROR':
        return { message: i18n.t('INTEGRATIONS.PROVIDER_ERROR'), stale: false };
      case 'SERVICE_UNAVAILABLE':
        return { message: i18n.t('INTEGRATIONS.UNAVAILABLE'), stale: false };
      case 'VALIDATION_ERROR':
        return { message: validationMessage(i18n, error, own), stale: false };
    }
  }
  return { message: failureMessage(i18n, error), stale: false };
}

function validationMessage(i18n: I18nService, error: ApiError, own: string | null): string {
  const detail = firstDetail(error);
  if (detail === undefined) {
    return i18n.t('INTEGRATIONS.INVALID');
  }
  if (own !== null && detail.field === own) {
    return i18n.t(detail.issue === 'incorrect' ? 'INTEGRATIONS.CODE_REFUSED' : issueMessageKey(detail.issue));
  }
  if (detail.field.endsWith('.status')) {
    return i18n.t('INTEGRATIONS.DISABLED');
  }
  if (detail.field.startsWith('integrations.')) {
    return i18n.t(
      detail.issue === 'required' ? 'INTEGRATIONS.CREDENTIAL_MISSING' : 'INTEGRATIONS.CREDENTIAL_REFUSED',
    );
  }
  return i18n.t('INTEGRATIONS.INVALID');
}

/**
 * The API error carried by a failed resource (it may be wrapped).
 *
 * @param error What the resource holds as its error.
 * @returns The API error, `null` when the failure is not one.
 */
export function apiErrorOf(error: unknown): ApiError | null {
  if (error instanceof ApiError) {
    return error;
  }
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause instanceof ApiError ? cause : null;
}
