import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';

/** What can still refer to a contact (the first segment of the `field` of a `409` detail), in the order the server looks for it. */
export const CONTACT_REFERENCE_KINDS = [
  'contactAssociations',
  'promotions',
  'products',
  'warehouseMovements',
  'appointments',
  'tableReservations',
  'documents',
  'sales',
] as const;

/** What can still refer to a group of contacts. */
export const CONTACT_GROUP_REFERENCE_KINDS = ['contacts', 'promotions'] as const;

/** One kind of reference that stops a deletion. */
export interface ReferenceKind {
  /** The kind, as the server names it (the text is `CONTACTS.REFERENCE.<kind>`). */
  readonly kind: string;
  /** How many references of the kind the server listed (at most 20 in all). */
  readonly count: number;
}

/** Whether a failure is the `409` that lists what still refers to an entry. */
export function isReferenced(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.code === 'CONFLICT' &&
    error.details.some((detail) => detail.issue === 'referenced')
  );
}

/**
 * The kinds of reference a `409` points at (`<kind>.<id>`), in the order of `kinds`, with how many
 * the server listed of each. A name it does not know is left out.
 *
 * @param error The `409`.
 * @param kinds The kinds of the entry, in the order the server looks for them.
 */
export function referenceKinds(error: ApiError, kinds: readonly string[]): ReferenceKind[] {
  const found = error.details
    .filter((detail) => detail.issue === 'referenced')
    .map((detail) => detail.field.split('.')[0]);
  return kinds
    .map((kind) => ({ kind, count: found.filter((name) => name === kind).length }))
    .filter((entry) => entry.count > 0);
}

/**
 * User message for a failed deletion or action on a contact or group of contacts that is not a
 * list of references: the check that was too slow (`503`) and a concurrent change (`409`) have
 * their own text, everything else (the hourly limit of deletions, with its waiting time, too)
 * uses the central mapping.
 */
export function contactFailureMessage(i18n: I18nService, error: unknown): string {
  if (error instanceof ApiError && error.code === 'SERVICE_UNAVAILABLE') {
    return i18n.t('CONTACTS.ERROR.TOO_SLOW');
  }
  if (error instanceof ApiError && error.code === 'CONFLICT') {
    return i18n.t('CONTACTS.ERROR.CONCURRENT');
  }
  return failureMessage(i18n, error);
}
