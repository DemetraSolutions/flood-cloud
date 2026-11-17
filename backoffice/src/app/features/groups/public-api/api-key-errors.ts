import { ApiError } from '../../../core/api/api-error';
import { I18nService } from '../../../core/i18n/i18n.service';
import { failureMessage } from '../../../shared/forms/form-errors';
import { EditorErrors, editorErrors } from '../catalogs/catalog-errors';

/**
 * User message for a failed write on a key. A `409` has two causes that depend on what was
 * asked: the group already has 50 active keys (creation) or the key is revoked or expired
 * (modification and revocation). Everything else (403, 404, 422, 429, network) uses the central
 * mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 * @param creating Whether the failed request was the creation of a key.
 */
export function apiKeyFailureMessage(i18n: I18nService, error: unknown, creating: boolean): string {
  if (error instanceof ApiError && error.code === 'CONFLICT') {
    return i18n.t(creating ? 'PUBLIC_API.ERROR.TOO_MANY' : 'PUBLIC_API.ERROR.NOT_EDITABLE');
  }
  return failureMessage(i18n, error);
}

/**
 * Splits the error of a save into what belongs to the fields of the key form
 * (`restrictions.companyIds.2` lands on `restrictions.companyIds`) and a message for the form.
 */
export function keyEditorErrors(
  i18n: I18nService,
  error: ApiError | null,
  known: readonly string[],
  creating: boolean,
): EditorErrors {
  const split = editorErrors(i18n, error, known);
  return {
    fields: split.fields,
    form: split.form === null ? null : apiKeyFailureMessage(i18n, error, creating),
  };
}
