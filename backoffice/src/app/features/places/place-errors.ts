import { FieldTree } from '@angular/forms/signals';
import { ApiError } from '../../core/api/api-error';
import { I18nService } from '../../core/i18n/i18n.service';
import { failureMessage } from '../../shared/forms/form-errors';
import { isStale, resolveField } from '../companies/company-errors';
import { FIELDS } from './place-fields';
import { isGeneralField } from './place-model';
import { SettingsBlockName } from './place.types';

/**
 * Finds the form field of a backend field name. The general fields live under `general` in the
 * model; the scalar keys of a settings block under the `f` of its block (the key may have dots:
 * `printing.receipt.user`); the images of the media block under `logos`; every other name (rows
 * of the lists, the license, the hours) is walked as it is, and when the form has no field of
 * that exact name (a language not yet typed, a price list of the self ordering) the closest
 * parent that exists stands for it.
 *
 * @param root The form (root field tree).
 * @param field Field of an error detail (`address.city`, `payments.paymentTypes.2.name`).
 * @returns The field, or `undefined` when not even the first segment exists.
 */
export function resolvePlaceField(
  root: FieldTree<unknown>,
  field: string,
): FieldTree<unknown> | undefined {
  if (isGeneralField(field)) {
    return resolveField(root, `general.${field}`);
  }
  // The delivery costs sit under `takeAway` in the API and flat under the block in the form.
  const [block, ...rest] = field
    .replace(/^delivery\.takeAway\.shippingCosts/, 'delivery.shippingCosts')
    .split('.');
  const definitions = Object.hasOwn(FIELDS, block)
    ? (FIELDS[block as SettingsBlockName] as readonly { key: string }[])
    : undefined;
  if (definitions === undefined) {
    return resolveField(root, field);
  }
  for (let length = rest.length; length > 0; length--) {
    const key = rest.slice(0, length).join('.');
    if (definitions.some((definition) => definition.key === key)) {
      const scalars = resolveField(root, `${block}.f`) as unknown as Record<
        string,
        FieldTree<unknown>
      >;
      return scalars[key];
    }
  }
  return resolveField(
    root,
    block === 'media' && rest.length > 0 ? `media.logos.${rest[0]}` : field,
  );
}

/**
 * User message for a failed state change of a place from the list (trash, restore, delete,
 * duplicate): the reasons the backend gives for a `409` and a stale version have their own text,
 * everything else uses the central mapping.
 *
 * @param i18n Translation service.
 * @param error The caught error.
 */
export function placeActionMessage(i18n: I18nService, error: unknown): string {
  if (isStale(error)) {
    return i18n.t('PLACES.CONFLICT');
  }
  if (error instanceof ApiError && error.code === 'CONFLICT') {
    const detail = error.details[0] as { field: string; issue: string } | undefined;
    if (detail?.issue === 'referenced') {
      return i18n.t('PLACES.ACTION.ERROR_REFERENCED');
    }
    if (detail?.field === 'companyId') {
      return i18n.t('PLACES.ACTION.ERROR_COMPANY');
    }
    return i18n.t('PLACES.ACTION.ERROR_STATE');
  }
  return failureMessage(i18n, error);
}
