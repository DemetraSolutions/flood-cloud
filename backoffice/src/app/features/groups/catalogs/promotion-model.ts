import { AmountTax, DiscountType, DiscountValueType, Promotion } from './catalog.types';
import {
  dateIssue,
  fromLocalInput,
  numberIssue,
  numberOrNull,
  numberText,
  textOrNull,
  toLocalInput,
} from './catalog-fields';

/** The promotion as the form holds it: numbers and dates as text, choices as text with `''` for none. */
export interface PromotionModel {
  name: string;
  enabled: boolean;
  description: string;
  code: string;
  placeIds: string[];
  startDate: string;
  endDate: string;
  customerIds: string[];
  contactGroupIds: string[];
  maxUsesPerUser: string;
  maxUsesTotal: string;
  minAmount: string;
  currency: string;
  amountTax: string;
  seatExcluded: boolean;
  serviceExcluded: boolean;
  tipExcluded: boolean;
  deliveryExcluded: boolean;
  productsType: string;
  productsN: string;
  productsQt: string;
  productIds: string[];
  categoriesType: string;
  categoriesN: string;
  categoryIds: string[];
  discountType: string;
  discountValue: string;
  discountValueType: string;
  actionProductIds: string[];
  actionCategoryIds: string[];
  freeShipping: boolean;
}

/** Section (tab) of the form. */
export type PromotionSection = 'general' | 'conditions' | 'products' | 'actions';

/** Sections in display order. */
export const PROMOTION_SECTIONS: readonly PromotionSection[] = [
  'general',
  'conditions',
  'products',
  'actions',
];

/** Where each field of the form lives: its section and its path in the body and in the errors of the server. */
export const PROMOTION_FIELDS = {
  name: { section: 'general', path: 'name' },
  enabled: { section: 'general', path: 'enabled' },
  description: { section: 'general', path: 'description' },
  code: { section: 'general', path: 'code' },
  placeIds: { section: 'conditions', path: 'conditions.placeIds' },
  startDate: { section: 'conditions', path: 'conditions.startDate' },
  endDate: { section: 'conditions', path: 'conditions.endDate' },
  customerIds: { section: 'conditions', path: 'conditions.customerIds' },
  contactGroupIds: { section: 'conditions', path: 'conditions.contactGroupIds' },
  maxUsesPerUser: { section: 'conditions', path: 'conditions.maxUsesPerUser' },
  maxUsesTotal: { section: 'conditions', path: 'conditions.maxUsesTotal' },
  minAmount: { section: 'conditions', path: 'conditions.minAmount' },
  currency: { section: 'conditions', path: 'conditions.currency' },
  amountTax: { section: 'conditions', path: 'conditions.amountTax' },
  seatExcluded: { section: 'conditions', path: 'conditions.seatExcluded' },
  serviceExcluded: { section: 'conditions', path: 'conditions.serviceExcluded' },
  tipExcluded: { section: 'conditions', path: 'conditions.tipExcluded' },
  deliveryExcluded: { section: 'conditions', path: 'conditions.deliveryExcluded' },
  productsType: { section: 'products', path: 'conditions.products.type' },
  productsN: { section: 'products', path: 'conditions.products.n' },
  productsQt: { section: 'products', path: 'conditions.products.qt' },
  productIds: { section: 'products', path: 'conditions.products.productIds' },
  categoriesType: { section: 'products', path: 'conditions.categories.type' },
  categoriesN: { section: 'products', path: 'conditions.categories.n' },
  categoryIds: { section: 'products', path: 'conditions.categories.categoryIds' },
  discountType: { section: 'actions', path: 'actions.discountType' },
  discountValue: { section: 'actions', path: 'actions.discountValue' },
  discountValueType: { section: 'actions', path: 'actions.discountValueType' },
  actionProductIds: { section: 'actions', path: 'actions.productIds' },
  actionCategoryIds: { section: 'actions', path: 'actions.categoryIds' },
  freeShipping: { section: 'actions', path: 'actions.freeShipping' },
} as const satisfies Record<keyof PromotionModel, { section: PromotionSection; path: string }>;

/** Names of the fields of the form. */
export const PROMOTION_KEYS = Object.keys(PROMOTION_FIELDS) as (keyof PromotionModel)[];

/** Values of the choices of the form. */
export const AMOUNT_TAXES: readonly AmountTax[] = ['tax_included', 'tax_excluded'];
export const SELECTIONS = ['only_n', 'all'] as const;
export const DISCOUNT_TYPES: readonly DiscountType[] = ['on_total', 'on_products', 'on_categories'];
export const DISCOUNT_VALUE_TYPES: readonly DiscountValueType[] = ['percentage', 'amount'];

/** Largest `n` and `qt` the server accepts. */
export const MAX_SELECTION_COUNT = 1_000_000;

/** The form model of a promotion, or of a new one (the server's defaults) when `null`. */
export function modelOf(item: Promotion | null): PromotionModel {
  const conditions = item?.conditions;
  const actions = item?.actions;
  return {
    name: item?.name ?? '',
    enabled: item?.enabled ?? true,
    description: item?.description ?? '',
    code: item?.code ?? '',
    placeIds: [...(conditions?.placeIds ?? [])],
    startDate: toLocalInput(conditions?.startDate ?? null),
    endDate: toLocalInput(conditions?.endDate ?? null),
    customerIds: [...(conditions?.customerIds ?? [])],
    contactGroupIds: [...(conditions?.contactGroupIds ?? [])],
    maxUsesPerUser: numberText(conditions?.maxUsesPerUser ?? null),
    maxUsesTotal: numberText(conditions?.maxUsesTotal ?? null),
    minAmount: numberText(conditions?.minAmount ?? null),
    currency: conditions?.currency ?? 'EUR',
    amountTax: conditions === undefined ? 'tax_included' : (conditions.amountTax ?? ''),
    seatExcluded: conditions?.seatExcluded ?? false,
    serviceExcluded: conditions?.serviceExcluded ?? false,
    tipExcluded: conditions?.tipExcluded ?? false,
    deliveryExcluded: conditions?.deliveryExcluded ?? false,
    productsType: conditions?.products.type ?? '',
    productsN: item === null ? '1' : numberText(conditions?.products.n ?? null),
    productsQt: item === null ? '1' : numberText(conditions?.products.qt ?? null),
    productIds: [...(conditions?.products.productIds ?? [])],
    categoriesType: conditions?.categories.type ?? '',
    categoriesN: item === null ? '1' : numberText(conditions?.categories.n ?? null),
    categoryIds: [...(conditions?.categories.categoryIds ?? [])],
    discountType: actions?.discountType ?? '',
    discountValue: numberText(actions?.discountValue ?? null),
    discountValueType: actions === undefined ? 'percentage' : (actions.discountValueType ?? ''),
    actionProductIds: [...(actions?.productIds ?? [])],
    actionCategoryIds: [...(actions?.categoryIds ?? [])],
    freeShipping: actions?.freeShipping ?? false,
  };
}

const DATE_KEYS: readonly (keyof PromotionModel)[] = ['startDate', 'endDate'];
const NUMBER_KEYS: readonly (keyof PromotionModel)[] = [
  'maxUsesPerUser',
  'maxUsesTotal',
  'minAmount',
  'productsN',
  'productsQt',
  'categoriesN',
  'discountValue',
];
const CHOICE_KEYS: readonly (keyof PromotionModel)[] = [
  'amountTax',
  'productsType',
  'categoriesType',
  'discountType',
  'discountValueType',
];
const OPTIONAL_TEXT_KEYS: readonly (keyof PromotionModel)[] = ['description', 'code'];

/** The value of a field as the body carries it. */
export function bodyValue(model: PromotionModel, key: keyof PromotionModel): unknown {
  const value = model[key];
  if (DATE_KEYS.includes(key)) {
    return fromLocalInput(value as string);
  }
  if (NUMBER_KEYS.includes(key)) {
    return numberOrNull(value as string);
  }
  if (CHOICE_KEYS.includes(key)) {
    return value === '' ? null : value;
  }
  if (OPTIONAL_TEXT_KEYS.includes(key)) {
    return textOrNull(value as string);
  }
  return typeof value === 'string' ? value.trim() : value;
}

function normalized(model: PromotionModel, key: keyof PromotionModel): string {
  const value = model[key];
  return JSON.stringify(typeof value === 'string' ? value.trim() : value);
}

/** Puts a value in a body at a dotted path (`conditions.products.n`). */
function setPath(body: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  const last = parts.pop() as string;
  let target = body;
  for (const part of parts) {
    target = (target[part] ??= {}) as Record<string, unknown>;
  }
  target[last] = value;
}

/**
 * Body of a creation: every field except the ones that are empty (the server's default, `null`,
 * applies).
 */
export function createBody(model: PromotionModel): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of PROMOTION_KEYS) {
    const value = bodyValue(model, key);
    if (value !== null) {
      setPath(body, PROMOTION_FIELDS[key].path, value);
    }
  }
  return body;
}

/**
 * Body of a modification: only the fields that differ from the saved promotion, nested as the
 * server merges them (`{ conditions: { products: { n: 2 } } }`); a list is sent whole. A date is
 * compared as typed, so one the input cannot show stays as stored.
 */
export function patchBody(model: PromotionModel, saved: PromotionModel): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of PROMOTION_KEYS) {
    if (normalized(model, key) !== normalized(saved, key)) {
      setPath(body, PROMOTION_FIELDS[key].path, bodyValue(model, key));
    }
  }
  return body;
}

/** Validation issue of a field, or `undefined` (same names as the backend; the server stays the authority). */
export function promotionIssue(
  model: PromotionModel,
  key: keyof PromotionModel,
): string | undefined {
  switch (key) {
    case 'maxUsesPerUser':
    case 'maxUsesTotal':
      return numberIssue(model[key], { min: 1, integer: true, optional: true });
    case 'minAmount':
      return numberIssue(model.minAmount, { min: 0, optional: true });
    case 'productsN':
    case 'productsQt':
    case 'categoriesN':
      return numberIssue(model[key], {
        min: 1,
        max: MAX_SELECTION_COUNT,
        integer: true,
        optional: true,
      });
    case 'discountValue': {
      const issue = numberIssue(model.discountValue, { min: 0, optional: true });
      return (
        issue ??
        (model.discountValueType === 'percentage' && Number(model.discountValue) > 100
          ? 'incorrect'
          : undefined)
      );
    }
    case 'currency':
      return /^[A-Z]{3}$/.test(model.currency) ? undefined : 'pattern';
    case 'startDate':
      return dateIssue(model.startDate);
    case 'endDate': {
      const invalid = dateIssue(model.endDate);
      if (invalid !== undefined) {
        return invalid;
      }
      const from = fromLocalInput(model.startDate);
      const to = fromLocalInput(model.endDate);
      return from !== null && to !== null && to < from ? 'incorrect' : undefined;
    }
    default:
      return undefined;
  }
}
