import { FieldTree, isFieldTree } from '@angular/forms/signals';
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

const LIST_FIELDS = /^(companyIds|placeIds|serviceIds)\.\d+$/;
const PRICE_LIST_FIELD = /^pos\.options\.priceLists\..+$/;

/**
 * Form field a backend field name stands for: an item of the perimeter and service lists is the
 * list itself, and any detail of a price list is the price list control.
 *
 * @param field Field name of an error detail (`placeIds.3`, `pos.options.priceLists.0.isDefault`).
 */
export function normalizeField(field: string): string {
  return field.replace(LIST_FIELDS, '$1').replace(PRICE_LIST_FIELD, 'pos.options.priceLists');
}

/**
 * Finds the field of a form by the path the backend uses (`pos.grants.discount`,
 * `shiftTime.weeks.0.days.1.slots.2.end`); the model mirrors the request body, so the path is
 * walked as it is.
 *
 * @param root The form (root field tree).
 * @param path Dotted path.
 * @returns The field, or `undefined` when the form has no such field.
 */
export function fieldAt(root: FieldTree<unknown>, path: string): FieldTree<unknown> | undefined {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    node = isFieldTree(node) ? (node as unknown as Record<string, unknown>)[segment] : undefined;
    if (!isFieldTree(node)) {
      return undefined;
    }
  }
  return node as FieldTree<unknown>;
}
