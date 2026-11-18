import { ReadonlyFieldTree, TreeValidationResult } from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage, serverFieldErrors } from '../../shared/forms/form-errors';

/** What a price form tells about a failed save. */
export interface PriceWriteOutcome {
  /** The version saved is no longer the current one (`412`): offer to reload. */
  readonly stale: boolean;
  /** Message of a failure that belongs to no field, `null` when none. */
  readonly failure: string | null;
  /** Errors to return from the submit action, one per field the backend refused. */
  readonly errors: TreeValidationResult;
}

/**
 * Sorts out a failed save of the price list or of the overrides of a dealer: a stale version
 * (`412`) offers to reload, the fields refused (`422`) get their message, anything else uses the
 * central mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 * @param fields Backend field name (`plans.<key>`, `services.<key>`) to form field.
 */
export function priceWriteOutcome(
  i18n: I18nService,
  error: unknown,
  fields: () => Record<string, ReadonlyFieldTree<unknown>>,
): PriceWriteOutcome {
  if (error instanceof ApiError && error.status === 412) {
    return { stale: true, failure: null, errors: undefined };
  }
  if (error instanceof ApiError && error.code === 'VALIDATION_ERROR' && error.details.length > 0) {
    const mapped = serverFieldErrors(i18n, error, fields());
    return {
      stale: false,
      failure: mapped.unmatched ? i18n.t('ERRORS.API.VALIDATION_ERROR') : null,
      errors: mapped.errors,
    };
  }
  return { stale: false, failure: failureMessage(i18n, error), errors: undefined };
}
