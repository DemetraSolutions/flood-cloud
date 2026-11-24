import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';

/** The `409` details that name a reason of the group (`group`/<reason>). */
export const CONFLICT_REASONS = [
  'noTobaccoPlace',
  'noZeroTaxRate',
  'noPriceList',
  'emptyList',
  'massDisable',
  'busy',
] as const;

/** Dictionary key of the message of a `409`. */
function conflictKey(error: ApiError): string {
  if (error.details.some((detail) => detail.field === 'Idempotency-Key')) {
    return 'TOBACCO_SYNC.ERROR.KEY_REUSED';
  }
  const issue = error.details.find((detail) => detail.field === 'group')?.issue ?? '';
  return (CONFLICT_REASONS as readonly string[]).includes(issue)
    ? `TOBACCO_SYNC.ERROR.CONFLICT.${issue}`
    : 'TOBACCO_SYNC.ERROR.CONFLICT.other';
}

/** Dictionary key of the message of a `422`. */
function invalidKey(error: ApiError): string {
  if (
    error.details.some((detail) => detail.field === 'warehouse' && detail.issue === 'notAllowed')
  ) {
    return 'TOBACCO_SYNC.ERROR.WAREHOUSE';
  }
  if (error.details.some((detail) => detail.field.startsWith('placeIds.'))) {
    return 'TOBACCO_SYNC.ERROR.PLACES';
  }
  return 'TOBACCO_SYNC.ERROR.INVALID';
}

/**
 * The message for a failed check or synchronization: each status the route answers has its own text (`403` permission or function, `409` with its reason, `413`, `422`, `429` with the wait); anything else uses the central mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function syncFailureMessage(i18n: I18nService, error: unknown): string {
  if (!(error instanceof ApiError)) {
    return failureMessage(i18n, error);
  }
  switch (error.status) {
    case 403:
      return i18n.t(
        error.code === 'FEATURE_DISABLED'
          ? 'TOBACCO_SYNC.ERROR.FEATURE'
          : 'TOBACCO_SYNC.ERROR.FORBIDDEN',
      );
    case 409:
      return i18n.t(conflictKey(error));
    case 413:
      return i18n.t('TOBACCO_SYNC.ERROR.TOO_LARGE');
    case 422:
      return i18n.t(invalidKey(error));
    case 429:
      return error.retryAfterSeconds === null
        ? i18n.t('TOBACCO_SYNC.ERROR.RATE_LIMITED')
        : i18n.t('TOBACCO_SYNC.ERROR.RATE_LIMITED_WAIT', { seconds: error.retryAfterSeconds });
    default:
      return failureMessage(i18n, error);
  }
}
