import {
  CardType,
  PointsCollection,
  Prize,
  PrizeCatalogue,
  ProductFavorites,
  Promotion,
} from '../app/features/groups/catalogs/catalog.types';

/** A loyalty-card type; override what the test cares about. */
export function aCardType(overrides: Partial<CardType> = {}): CardType {
  return {
    id: 'ct1',
    enabled: true,
    name: 'Gold',
    discountPercentage: 5,
    priceListId: null,
    prepaid: { enabled: false, type: null, taxPercentage: null },
    pointsCollect: { enabled: false, collectionIds: [] },
    placeIds: [],
    ...overrides,
  };
}

/** A points collection. */
export function aPointsCollection(overrides: Partial<PointsCollection> = {}): PointsCollection {
  return {
    id: 'pc1',
    enabled: true,
    name: 'Spring',
    pointConversion: 10,
    minAmount: null,
    dateFrom: null,
    dateTo: null,
    pointsExpirationDate: null,
    prizeCatalogueId: null,
    ...overrides,
  };
}

/** A prize. */
export function aPrize(overrides: Partial<Prize> = {}): Prize {
  return {
    id: 'pr1',
    enabled: true,
    name: 'Mug',
    description: null,
    pointsValue: 100,
    extraPrice: null,
    redemptionConditions: null,
    imageSet: false,
    ...overrides,
  };
}

/** A prize catalogue. */
export function aPrizeCatalogue(overrides: Partial<PrizeCatalogue> = {}): PrizeCatalogue {
  return { id: 'cat1', enabled: true, name: 'Gifts', prizes: [aPrize()], ...overrides };
}

/** A list of favorite products. */
export function aFavoritesList(overrides: Partial<ProductFavorites> = {}): ProductFavorites {
  return {
    id: 'fav1',
    name: 'Bar',
    products: [
      { productId: 'prod2', position: 1 },
      { productId: 'prod1', position: 0 },
    ],
    ...overrides,
  };
}

/** A promotion with the defaults of a new one. */
export function aPromotion(
  overrides: Omit<Partial<Promotion>, 'conditions' | 'actions'> & {
    conditions?: Partial<Promotion['conditions']>;
    actions?: Partial<Promotion['actions']>;
  } = {},
): Promotion {
  const { conditions, actions, ...rest } = overrides;
  return {
    id: 'promo1',
    enabled: true,
    name: 'Happy hour',
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
      ...conditions,
    },
    actions: {
      discountType: 'on_total',
      discountValue: 10,
      discountValueType: 'percentage',
      productIds: [],
      categoryIds: [],
      freeShipping: false,
      ...actions,
    },
    ...rest,
  };
}
