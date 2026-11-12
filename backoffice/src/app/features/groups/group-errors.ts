import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';

/** Whether a failure is the `409` of a group document that changed or cannot take the change. */
export function isGroupConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'CONFLICT';
}

/** Whether a failure carries per-field details that can be shown on the fields of a form. */
export function hasFieldDetails(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.code === 'VALIDATION_ERROR' ||
      error.code === 'FORBIDDEN' ||
      error.code === 'CONFLICT') &&
    error.details.length > 0
  );
}

/**
 * User message for a failed write of the group record. A `409` invites to reload (the document
 * changed in the meantime or cannot take the change); everything else uses the central mapping.
 */
export function groupFailureMessage(i18n: I18nService, error: unknown): string {
  return isGroupConflict(error)
    ? i18n.t('GROUP_SETTINGS.ERROR.CONFLICT')
    : failureMessage(i18n, error);
}

/** The same error with the field of each detail renamed (backend field to form field). */
export function renameFields(error: ApiError, rename: (field: string) => string): ApiError {
  return new ApiError({
    status: error.status,
    code: error.code as ApiError['code'],
    message: error.message,
    requestId: error.requestId,
    details: error.details.map((detail) => ({ field: rename(detail.field), issue: detail.issue })),
  });
}
