import { ReadonlyFieldState, ReadonlyFieldTree, ValidationError } from '@angular/forms/signals';
import { ApiError, apiErrorMessageKey } from '../../core/api/api-error';
import { issueMessageKey } from '../../core/api/field-issues';
import { I18nService } from '../../core/i18n/i18n.service';

/** Kind of the errors that come from the backend (`422`) rather than from a client validator. */
export const SERVER_ERROR_KIND = 'server';

/**
 * User message to show under a field, or `null`. Server errors are always shown; client
 * validation errors only after the user touched the field (or tried to submit).
 *
 * @param i18n Translation service.
 * @param state State of the field.
 */
export function fieldErrorMessage(
  i18n: I18nService,
  state: ReadonlyFieldState<unknown>,
): string | null {
  const shown = state.errors().find((error) => error.kind === SERVER_ERROR_KIND || state.touched());
  if (shown === undefined) {
    return null;
  }
  return shown.kind === SERVER_ERROR_KIND && shown.message !== undefined
    ? shown.message
    : i18n.t(issueMessageKey(shown.kind));
}

/** Result of mapping a `422` onto a form. */
export interface ServerFieldErrors {
  /** Errors to return from the submit action, one per mapped field. */
  readonly errors: ValidationError.WithFieldTree[];
  /** `true` when some detail did not match any field (shown as a form-level message). */
  readonly unmatched: boolean;
}

/**
 * Maps the `details` of a `422 VALIDATION_ERROR` onto the fields of a form: the first issue of
 * each known field becomes a server error with its translated message.
 *
 * @param i18n Translation service.
 * @param error The API error.
 * @param fields Backend field name to form field.
 */
export function serverFieldErrors(
  i18n: I18nService,
  error: ApiError,
  fields: Readonly<Record<string, ReadonlyFieldTree<unknown>>>,
): ServerFieldErrors {
  const errors: ValidationError.WithFieldTree[] = [];
  const seen = new Set<string>();
  let unmatched = false;
  for (const { field, issue } of error.details) {
    const fieldTree = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (fieldTree === undefined) {
      unmatched = true;
    } else if (!seen.has(field)) {
      seen.add(field);
      errors.push({ kind: SERVER_ERROR_KIND, fieldTree, message: i18n.t(issueMessageKey(issue)) });
    }
  }
  return { errors, unmatched: unmatched || error.details.length === 0 };
}

/**
 * Moves the focus to the first field of a form that has an error, so that a failed submit lands
 * the keyboard and screen-reader user on the problem.
 *
 * @param root The form (root field tree).
 */
export function focusFirstError(root: ReadonlyFieldTree<unknown>): void {
  root().errorSummary()[0]?.fieldTree().focusBoundControl();
}

/**
 * User message for any failure of a form action. Backend errors use the central mapping;
 * anything else is logged (never swallowed) and reported generically.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function failureMessage(i18n: I18nService, error: unknown): string {
  if (error instanceof ApiError) {
    return i18n.t(apiErrorMessageKey(error));
  }
  console.error(error);
  return i18n.t('ERRORS.GENERIC.MESSAGE');
}
