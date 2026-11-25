import { numberOrNull, numberText, textOrNull } from '../groups/catalogs/catalog-fields';
import { ContactGroup } from './contact-group.types';

/** The form of a group of contacts. */
export interface ContactGroupModel {
  name: string;
  priceListId: string;
  discountPercent: string;
}

/**
 * The form of a group of contacts.
 *
 * @param item The group as the server has it; `null` for a new one.
 */
export function toModel(item: ContactGroup | null): ContactGroupModel {
  return {
    name: item?.name ?? '',
    priceListId: item?.priceListId ?? '',
    discountPercent: numberText(item?.discountPercent ?? null),
  };
}

function payload(model: ContactGroupModel): Record<string, unknown> {
  return {
    name: model.name.trim(),
    priceListId: textOrNull(model.priceListId),
    discountPercent: numberOrNull(model.discountPercent),
  };
}

/** The body of a creation: the three fields. */
export function createBody(model: ContactGroupModel): Record<string, unknown> {
  return payload(model);
}

/**
 * The body of a modification: only the fields that changed (empty when nothing did).
 *
 * @param model The form.
 * @param before The form as the group was read.
 */
export function patchBody(model: ContactGroupModel, before: ContactGroupModel): Record<string, unknown> {
  const now = payload(model);
  const prior = payload(before);
  return Object.fromEntries(Object.entries(now).filter(([key, value]) => value !== prior[key]));
}
