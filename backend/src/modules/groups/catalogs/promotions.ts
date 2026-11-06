import { array, boolean, enumOf, integer, nullable, number, object, optional, personName, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import type { ReferenceCheck } from './catalog.ts';
import type { CatalogAnomaly } from './kit.ts';
import { MAX_REFERENCES, choiceOf, flagOf, integerOf, invalid, isoInstant, nestedOf, numberOf, stringsOf, textOf } from './kit.ts';

/** Most promotions a group may have. */
export const MAX_PROMOTIONS = 200;

const PRODUCT_RULES = ['only_n', 'all'] as const;
const CATEGORY_RULES = ['only_n'] as const;
const DISCOUNT_TYPES = ['on_total', 'on_products', 'on_categories'] as const;
const VALUE_TYPES = ['percentage', 'amount'] as const;
const AMOUNT_TAX = ['tax_included', 'tax_excluded'] as const;

/**
 * A promotion (legacy `promotions[]`, saved by the old client as it is). Mapping of the names that differ: `status` is `enabled`; in `conditions`,
 * `placesIds` is `placeIds`, `customersIds` is `customerIds`, `contactsGroupsIds` is `contactGroupIds`, `useForUsers` is `maxUsesPerUser`,
 * `totalAvailableNumber` is `maxUsesTotal`, `products.ids` is `products.productIds` and `categories.ids` is `categories.categoryIds`; in `actions`,
 * `productsIds` is `productIds` and `categoriesIds` is `categoryIds`. The dates are ISO 8601 strings, stored as strings like the legacy does.
 * The ids refer to the group database: places, products, product categories, contacts and contact groups.
 */
export interface Promotion {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly description: string | null;
  readonly code: string | null;
  readonly conditions: {
    readonly placeIds: readonly string[];
    readonly startDate: string | null;
    readonly endDate: string | null;
    readonly customerIds: readonly string[];
    readonly contactGroupIds: readonly string[];
    readonly maxUsesPerUser: number | null;
    readonly maxUsesTotal: number | null;
    readonly minAmount: number | null;
    readonly currency: string;
    readonly amountTax: (typeof AMOUNT_TAX)[number];
    readonly seatExcluded: boolean;
    readonly serviceExcluded: boolean;
    readonly tipExcluded: boolean;
    readonly deliveryExcluded: boolean;
    readonly products: { readonly type: (typeof PRODUCT_RULES)[number] | null; readonly n: number; readonly qt: number; readonly productIds: readonly string[] };
    readonly categories: { readonly type: (typeof CATEGORY_RULES)[number] | null; readonly n: number; readonly categoryIds: readonly string[] };
  };
  readonly actions: {
    readonly discountType: (typeof DISCOUNT_TYPES)[number] | null;
    readonly discountValue: number;
    readonly discountValueType: (typeof VALUE_TYPES)[number];
    readonly productIds: readonly string[];
    readonly categoryIds: readonly string[];
    readonly freeShipping: boolean;
  };
}

const objectIdText = string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ });
const ids = optional(array(objectIdText, { max: MAX_REFERENCES, unique: true }));
const count = optional(integer({ min: 1, max: 1_000_000 }));

const conditionsShape = {
  placeIds: ids,
  startDate: optional(nullable(isoInstant())),
  endDate: optional(nullable(isoInstant())),
  customerIds: ids,
  contactGroupIds: ids,
  maxUsesPerUser: optional(nullable(integer({ min: 1, max: 1_000_000_000 }))),
  maxUsesTotal: optional(nullable(integer({ min: 1, max: 1_000_000_000 }))),
  minAmount: optional(nullable(number({ min: 0 }))),
  currency: optional(string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ })),
  amountTax: optional(enumOf(AMOUNT_TAX)),
  seatExcluded: optional(boolean()),
  serviceExcluded: optional(boolean()),
  tipExcluded: optional(boolean()),
  deliveryExcluded: optional(boolean()),
  products: optional(object({ type: optional(nullable(enumOf(PRODUCT_RULES))), n: count, qt: count, productIds: ids })),
  categories: optional(object({ type: optional(nullable(enumOf(CATEGORY_RULES))), n: count, categoryIds: ids })),
};

const actionsShape = {
  discountType: optional(nullable(enumOf(DISCOUNT_TYPES))),
  discountValue: optional(number({ min: 0 })),
  discountValueType: optional(enumOf(VALUE_TYPES)),
  productIds: ids,
  categoryIds: ids,
  freeShipping: optional(boolean()),
};

const shape = {
  enabled: optional(boolean()),
  description: optional(nullable(string({ min: 1, max: 1000, trim: true }))),
  code: optional(nullable(string({ min: 1, max: 50, trim: true }))),
  conditions: optional(object(conditionsShape)),
  actions: optional(object(actionsShape)),
};

/** Body of the creation of a promotion: the name is required, the rest has the defaults of the legacy form. */
export const createPromotionBody = object({ name: personName(200), ...shape });

/** Body of the modification of a promotion (JSON Merge Patch; the lists replace the stored ones). */
export const patchPromotionBody = object({ name: optional(personName(200)), ...shape });

type CreateBody = Infer<typeof createPromotionBody>;
type PatchBody = Infer<typeof patchPromotionBody>;

/** A stored instant (an ISO string, as the legacy client sends it) as the normalized ISO string, or `null` if it is not a date. */
function instantOf(raw: unknown, field: string, anomalies: CatalogAnomaly[]): string | null {
  if (typeof raw === 'string' && !Number.isNaN(new Date(raw).getTime())) {
    return new Date(raw).toISOString();
  }
  if (raw !== undefined && raw !== null) {
    anomalies.push({ kind: 'invalidValue', field });
  }
  return null;
}

const defaultPromotion = (id: string): Promotion => ({
  id,
  enabled: true,
  name: '',
  description: null,
  code: null,
  conditions: {
    placeIds: [],
    startDate: null,
    endDate: null,
    customerIds: [],
    contactGroupIds: [],
    maxUsesPerUser: null,
    maxUsesTotal: null,
    minAmount: null,
    currency: 'EUR',
    amountTax: 'tax_included',
    seatExcluded: false,
    serviceExcluded: false,
    tipExcluded: false,
    deliveryExcluded: false,
    products: { type: null, n: 1, qt: 1, productIds: [] },
    categories: { type: null, n: 1, categoryIds: [] },
  },
  actions: { discountType: null, discountValue: 0, discountValueType: 'percentage', productIds: [], categoryIds: [], freeShipping: false },
});

/**
 * The promotions (`/promotions`). The ids a request names must exist in the group (`422 incorrect`, with the index); the end date cannot precede the start;
 * a percentage discount is at most 100.
 */
export const promotions = defineCatalog<Promotion, CreateBody, PatchBody>({
  name: 'promotion',
  segment: 'promotions',
  path: 'promotions',
  kind: 'array',
  limit: MAX_PROMOTIONS,
  idKey: 'id',
  // Seven lists of up to 500 ids each can come close to the default 100 kB.
  bodyLimit: '256kb',
  readPermission: 'products:read',
  updatePermission: 'products:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createPromotionBody,
  patchSchema: patchPromotionBody,
  toElement: (id, raw, anomalies) => {
    const at = `promotions.${id}`;
    const conditions = nestedOf(raw['conditions'], `${at}.conditions`, anomalies);
    const products = nestedOf(conditions['products'], `${at}.conditions.products`, anomalies);
    const categories = nestedOf(conditions['categories'], `${at}.conditions.categories`, anomalies);
    const actions = nestedOf(raw['actions'], `${at}.actions`, anomalies);
    return {
      id,
      enabled: flagOf(raw['status']),
      name: textOf(raw['name']) ?? '',
      description: textOf(raw['description']),
      code: textOf(raw['code']),
      conditions: {
        placeIds: stringsOf(conditions['placesIds'], `${at}.conditions.placesIds`, anomalies),
        startDate: instantOf(conditions['startDate'], `${at}.conditions.startDate`, anomalies),
        endDate: instantOf(conditions['endDate'], `${at}.conditions.endDate`, anomalies),
        customerIds: stringsOf(conditions['customersIds'], `${at}.conditions.customersIds`, anomalies),
        contactGroupIds: stringsOf(conditions['contactsGroupsIds'], `${at}.conditions.contactsGroupsIds`, anomalies),
        maxUsesPerUser: integerOf(conditions['useForUsers']),
        maxUsesTotal: integerOf(conditions['totalAvailableNumber']),
        minAmount: numberOf(conditions['minAmount']),
        currency: textOf(conditions['currency']) ?? 'EUR',
        amountTax: choiceOf(conditions['amountTax'], AMOUNT_TAX, `${at}.conditions.amountTax`, anomalies) ?? 'tax_included',
        seatExcluded: flagOf(conditions['seatExcluded']),
        serviceExcluded: flagOf(conditions['serviceExcluded']),
        tipExcluded: flagOf(conditions['tipExcluded']),
        deliveryExcluded: flagOf(conditions['deliveryExcluded']),
        products: {
          type: choiceOf(products['type'], PRODUCT_RULES, `${at}.conditions.products.type`, anomalies),
          n: integerOf(products['n']) ?? 1,
          qt: integerOf(products['qt']) ?? 1,
          productIds: stringsOf(products['ids'], `${at}.conditions.products.ids`, anomalies),
        },
        categories: {
          type: choiceOf(categories['type'], CATEGORY_RULES, `${at}.conditions.categories.type`, anomalies),
          n: integerOf(categories['n']) ?? 1,
          categoryIds: stringsOf(categories['ids'], `${at}.conditions.categories.ids`, anomalies),
        },
      },
      actions: {
        discountType: choiceOf(actions['discountType'], DISCOUNT_TYPES, `${at}.actions.discountType`, anomalies),
        discountValue: numberOf(actions['discountValue']) ?? 0,
        discountValueType: choiceOf(actions['discountValueType'], VALUE_TYPES, `${at}.actions.discountValueType`, anomalies) ?? 'percentage',
        productIds: stringsOf(actions['productsIds'], `${at}.actions.productsIds`, anomalies),
        categoryIds: stringsOf(actions['categoriesIds'], `${at}.actions.categoriesIds`, anomalies),
        freeShipping: flagOf(actions['freeShipping']),
      },
    };
  },
  defaults: (id) => defaultPromotion(id),
  places: (element) => ({ field: 'conditions.placeIds', ids: element.conditions.placeIds }),
  toRaw: (element, raw) => {
    const conditions = nestedOf(raw?.['conditions'], '', []);
    const actions = nestedOf(raw?.['actions'], '', []);
    const { conditions: c, actions: a } = element;
    return {
      ...raw,
      id: element.id,
      status: element.enabled,
      name: element.name,
      description: element.description,
      code: element.code,
      conditions: {
        ...conditions,
        placesIds: [...c.placeIds],
        startDate: c.startDate,
        endDate: c.endDate,
        customersIds: [...c.customerIds],
        contactsGroupsIds: [...c.contactGroupIds],
        useForUsers: c.maxUsesPerUser,
        totalAvailableNumber: c.maxUsesTotal,
        minAmount: c.minAmount,
        currency: c.currency,
        amountTax: c.amountTax,
        seatExcluded: c.seatExcluded,
        serviceExcluded: c.serviceExcluded,
        tipExcluded: c.tipExcluded,
        deliveryExcluded: c.deliveryExcluded,
        products: { ...nestedOf(conditions['products'], '', []), type: c.products.type, n: c.products.n, qt: c.products.qt, ids: [...c.products.productIds] },
        categories: { ...nestedOf(conditions['categories'], '', []), type: c.categories.type, n: c.categories.n, ids: [...c.categories.categoryIds] },
      },
      actions: {
        ...actions,
        discountType: a.discountType,
        discountValue: a.discountValue,
        discountValueType: a.discountValueType,
        productsIds: [...a.productIds],
        categoriesIds: [...a.categoryIds],
        freeShipping: a.freeShipping,
      },
    };
  },
  check: ({ element, body }): ReferenceCheck[] => {
    const { conditions: c, actions: a } = element;
    if ((body.conditions?.startDate !== undefined || body.conditions?.endDate !== undefined) && c.startDate !== null && c.endDate !== null && c.endDate < c.startDate) {
      throw invalid('conditions.endDate', 'incorrect');
    }
    if ((body.actions?.discountValue !== undefined || body.actions?.discountValueType !== undefined) && a.discountValueType === 'percentage' && a.discountValue > 100) {
      throw invalid('actions.discountValue', 'incorrect');
    }
    const wanted: Array<[boolean, ReferenceCheck]> = [
      [body.conditions?.placeIds !== undefined, { field: 'conditions.placeIds', collection: 'places', ids: c.placeIds }],
      [body.conditions?.products?.productIds !== undefined, { field: 'conditions.products.productIds', collection: 'products', ids: c.products.productIds }],
      [body.conditions?.categories?.categoryIds !== undefined, { field: 'conditions.categories.categoryIds', collection: 'categories', ids: c.categories.categoryIds }],
      [body.conditions?.customerIds !== undefined, { field: 'conditions.customerIds', collection: 'contacts', ids: c.customerIds }],
      [body.conditions?.contactGroupIds !== undefined, { field: 'conditions.contactGroupIds', collection: 'contactGroups', ids: c.contactGroupIds }],
      [body.actions?.productIds !== undefined, { field: 'actions.productIds', collection: 'products', ids: a.productIds }],
      [body.actions?.categoryIds !== undefined, { field: 'actions.categoryIds', collection: 'categories', ids: a.categoryIds }],
    ];
    return wanted.filter(([touched]) => touched).map(([, check]) => check);
  },
});
