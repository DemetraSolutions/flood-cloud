import { FieldTree } from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { fieldAt } from '../users/users-errors';

/**
 * Finds the form field of a backend field name; when the form has no field of that exact name
 * (a currency of the minimum order, say) the closest parent that exists stands for it.
 *
 * @param root The form (root field tree).
 * @param path Dotted path in the form model.
 * @returns The field, or `undefined` when not even the first segment exists.
 */
export function resolveField(
  root: FieldTree<unknown>,
  path: string,
): FieldTree<unknown> | undefined {
  const segments = path.split('.');
  for (let length = segments.length; length > 0; length--) {
    const found = fieldAt(root, segments.slice(0, length).join('.'));
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Whether a failure carries per-field details that belong on the fields of the form. */
export function hasFieldDetails(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.code === 'VALIDATION_ERROR' ||
      error.code === 'CONFLICT' ||
      error.code === 'FORBIDDEN') &&
    error.details.length > 0
  );
}

/** Whether a failure is the `412` of a company that was changed after it was read. */
export function isStale(error: unknown): boolean {
  return error instanceof ApiError && error.status === 412;
}

/**
 * User message for a failed state change of a company from the list (trash, restore, delete):
 * the reasons the backend gives for a `409` and a stale version have their own text, everything
 * else uses the central mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function companyActionMessage(i18n: I18nService, error: unknown): string {
  if (isStale(error)) {
    return i18n.t('COMPANIES.CONFLICT');
  }
  if (error instanceof ApiError && error.code === 'CONFLICT') {
    const detail = error.details[0] as { field: string; issue: string } | undefined;
    if (detail?.issue === 'taken') {
      return i18n.t('COMPANIES.ACTION.ERROR_VAT_TAKEN');
    }
    if (detail?.issue === 'referenced') {
      return i18n.t('COMPANIES.ACTION.ERROR_REFERENCED');
    }
  }
  return failureMessage(i18n, error);
}
