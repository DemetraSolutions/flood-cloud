import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { TrashKind } from './trash.types';

/**
 * User message for a failed bulk call of the trash: the check of what still refers to a contact
 * that was too slow (`503`) has its own text, everything else uses the central mapping.
 *
 * @param i18n Translation service.
 * @param kind Kind of the items of the call.
 * @param error The caught error.
 */
export function trashFailureMessage(i18n: I18nService, kind: TrashKind, error: unknown): string {
  return kind === 'contacts' && error instanceof ApiError && error.code === 'SERVICE_UNAVAILABLE'
    ? i18n.t('CONTACTS.ERROR.TOO_SLOW')
    : failureMessage(i18n, error);
}
