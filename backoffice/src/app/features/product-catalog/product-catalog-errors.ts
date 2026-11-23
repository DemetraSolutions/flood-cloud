import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { ReferenceApi } from '../../core/reference/reference-api';
import { failureMessage } from '../../shared/forms/form-errors';

/** The products that stopped a deletion or a change, as the page shows them. */
export interface BlockedBy {
  /** Name of the entry that cannot be deleted or changed. */
  readonly entry: string;
  /** Names of the products (the id of one the user cannot read). */
  readonly products: readonly string[];
}

/** Whether a failure is the `409` that lists the products that use an entry. */
export function isReferenced(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.code === 'CONFLICT' &&
    error.details.some((detail) => detail.issue === 'referenced')
  );
}

/**
 * The names of the products a `409` points at (`products.<id>`); an id stands for a product whose
 * name cannot be read. Never rejects: a failed read is logged and the ids are shown.
 *
 * @param reference Reference reads of the group.
 * @param groupId Group of the entry.
 * @param error The `409`.
 */
export async function productNames(
  reference: ReferenceApi,
  groupId: string,
  error: ApiError,
): Promise<string[]> {
  const ids = error.details
    .filter((detail) => detail.issue === 'referenced')
    .map((detail) => detail.field.replace(/^products\./, ''));
  try {
    const names = await reference.lookupNames(groupId, 'products', ids);
    return ids.map((id) => names[id] ?? id);
  } catch (failure) {
    console.warn('Cannot read the names of the products that use the entry', failure);
    return ids;
  }
}

/**
 * User message for a failed deletion that is not a list of products: a `403` (the entry is for
 * stores outside the perimeter of a company or store administrator, or for every store) has its
 * own text, a `409` that is not a list of products (a concurrent change) asks to reload, everything else uses the central mapping.
 */
export function deleteFailureMessage(i18n: I18nService, error: unknown): string {
  if (error instanceof ApiError && error.code === 'FORBIDDEN') {
    return i18n.t('PRODUCT_CATALOG.ERROR.DELETE_FORBIDDEN');
  }
  if (error instanceof ApiError && error.code === 'CONFLICT') {
    return i18n.t('PRODUCT_CATALOG.ERROR.CONCURRENT');
  }
  return failureMessage(i18n, error);
}
