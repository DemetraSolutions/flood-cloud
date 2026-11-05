import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';

/**
 * User message for a failed user operation: a `403` means the target cannot be managed by the
 * current user (rank, perimeter, or more permissions than they hold); everything else uses the
 * central mapping.
 */
export function userFailureMessage(i18n: I18nService, error: unknown): string {
  return error instanceof ApiError && error.code === 'FORBIDDEN'
    ? i18n.t('USERS.FORBIDDEN_TARGET')
    : failureMessage(i18n, error);
}
