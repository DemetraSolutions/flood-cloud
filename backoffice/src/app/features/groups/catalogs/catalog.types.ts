/** Segment of a catalog under `/v1/groups/{groupId}/…` (the six of the group record, then fidelity, favorites and promotions). */
export type CatalogSegment =
  | 'price-lists'
  | 'taxes'
  | 'currencies'
  | 'measure-units'
  | 'warehouse-rules'
  | 'fidelity-card-rules'
  | 'fidelity/card-types'
  | 'fidelity/points-collections'
  | 'fidelity/prize-catalogues'
  | 'product-favorites'
  | 'promotions';

/** A price list. */
export interface PriceList {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

/** A tax rate. */
export interface Tax {
  readonly id: string;
  readonly rate: number;
  readonly department: number | null;
  readonly description: string | null;
  readonly vatNature: string | null;
}

/** A currency; its `code` is its identifier in the URLs. */
export interface Currency {
  readonly code: string;
  readonly symbol: string;
}

/** A unit of measure. */
export interface MeasureUnit {
  readonly id: string;
  readonly value: string;
}

/** Whether a warehouse rule loads or unloads the stock. */
export type WarehouseRuleType = 'load' | 'unload';
/** How a movement changes a quantity or a value: keeps it, adds to it, subtracts from it. */
export type WarehouseSign = '=' | '+' | '-';
/** The counterpart of a warehouse movement. */
export type WarehouseCounterpart = 'suppliers' | 'customers' | 'indoor';

/** A warehouse rule (causale). A stored value outside the allowed ones is `null`. */
export interface WarehouseRule {
  readonly id: string;
  readonly type: WarehouseRuleType | null;
  readonly name: string;
  readonly quantity: WarehouseSign | null;
  readonly value: WarehouseSign | null;
  readonly useLoadUnit: boolean;
  readonly counterpart: WarehouseCounterpart | null;
  readonly isDefault: boolean;
  readonly cashLoad: boolean;
  readonly cashUnload: boolean;
}

/** The loyalty-card rule of a currency. */
export interface FidelityCardRule {
  readonly currency: string;
  readonly pointValue: number | null;
  readonly discountPercentage: number | null;
}

/** Price lists a group may have. */
export const MAX_PRICE_LISTS = 50;
/** Tax rates a group may have. */
export const MAX_TAXES = 30;
/** Currencies a group may have. */
export const MAX_CURRENCIES = 10;
/** Units of measure a group may have. */
export const MAX_MEASURE_UNITS = 50;
/** Warehouse rules a group may have. */
export const MAX_WAREHOUSE_RULES = 50;

/**
 * VAT natures of the electronic invoice with their official description (the same list the
 * previous backoffice offered; the description pre-fills the one of the tax rate).
 */
export const VAT_NATURES: readonly { readonly code: string; readonly description: string }[] = [
  { code: 'N1', description: 'Operazioni escluse ex art. 15' },
  {
    code: 'N2.1',
    description: 'Operazioni non soggette ad IVA ai sensi degli artt. da 7 a 7-septies',
  },
  { code: 'N2.2', description: 'Operazioni non soggette - altri casi' },
  { code: 'N3.1', description: 'Operazioni non imponibili - esportazioni' },
  { code: 'N3.2', description: 'Operazioni non imponibili - cessioni intracomunitarie' },
  { code: 'N3.3', description: 'Operazioni non imponibili - cessioni verso San Marino' },
  {
    code: 'N3.4',
    description: 'Operazioni non imponibili - operazioni assimilate alle cessioni all’esportazione',
  },
  {
    code: 'N3.5',
    description: 'Operazioni non imponibili - a seguito di dichiarazioni d’intento',
  },
  {
    code: 'N3.6',
    description:
      'Operazioni non imponibili - altre operazioni che non concorrono alla formazione del plafond',
  },
  { code: 'N4', description: 'Operazioni esenti' },
  { code: 'N5', description: 'Regime del margine o con IVA non esposta in fattura' },
  {
    code: 'N6.1',
    description: 'Inversione contabile - cessione di rottami e altri materiali di recupero',
  },
  { code: 'N6.2', description: 'Inversione contabile - cessione di oro e argento puro' },
  { code: 'N6.3', description: 'Inversione contabile - subappalto nel settore edile' },
  { code: 'N6.4', description: 'Inversione contabile - cessione di fabbricati' },
  { code: 'N6.5', description: 'Inversione contabile - cessione di telefoni cellulari' },
  { code: 'N6.6', description: 'Inversione contabile - cessione di prodotti elettronici' },
  {
    code: 'N6.7',
    description: 'Inversione contabile - prestazioni comparto edile e settori connessi',
  },
  { code: 'N6.8', description: 'Inversione contabile - operazioni settore energetico' },
  { code: 'N6.9', description: 'Inversione contabile - altri casi' },
];

/** Official description of a VAT nature, `null` for an unknown code. */
export function vatNatureDescription(code: string): string | null {
  return VAT_NATURES.find((nature) => nature.code === code)?.description ?? null;
}

/** Card types a group may have. */
export const MAX_CARD_TYPES = 50;
/** Points collections a group may have. */
export const MAX_POINTS_COLLECTIONS = 50;
/** Prize catalogues a group may have. */
export const MAX_PRIZE_CATALOGUES = 20;
/** Prizes a catalogue may have. */
export const MAX_PRIZES = 200;
/** Product favorites lists a group may have. */
export const MAX_PRODUCT_FAVORITES = 50;
/** Products a favorites list may have. */
export const MAX_FAVORITE_PRODUCTS = 500;
/** Promotions a group may have. */
export const MAX_PROMOTIONS = 200;
/** Ids a list of a promotion (stores, customers, products…) may have. */
export const MAX_PROMOTION_IDS = 500;
/** Stores a card type may name. */
export const MAX_CARD_PLACES = 500;
/** Points collections a card type may name. */
export const MAX_CARD_COLLECTIONS = 50;

/** Kind of prepaid card. */
export type PrepaidType = 'multi' | 'mono';

/** A loyalty-card type. An empty `placeIds` means every store of the group. */
export interface CardType {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly discountPercentage: number | null;
  readonly priceListId: string | null;
  readonly prepaid: {
    readonly enabled: boolean;
    readonly type: PrepaidType | null;
    readonly taxPercentage: number | null;
  };
  readonly pointsCollect: {
    readonly enabled: boolean;
    readonly collectionIds: readonly string[];
  };
  readonly placeIds: readonly string[];
}

/** A points collection: how much money earns a point and when. Dates are ISO 8601 or `null`. */
export interface PointsCollection {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly pointConversion: number | null;
  readonly minAmount: number | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly pointsExpirationDate: string | null;
  readonly prizeCatalogueId: string | null;
}

/** A prize of a catalogue. The image is not managed here: only whether there is one. */
export interface Prize {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly description: string | null;
  readonly pointsValue: number | null;
  readonly extraPrice: number | null;
  readonly redemptionConditions: string | null;
  readonly imageSet: boolean;
}

/** A prize catalogue with its prizes. */
export interface PrizeCatalogue {
  readonly id: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly prizes: readonly Prize[];
}

/** A product of a favorites list. */
export interface FavoriteProduct {
  readonly productId: string;
  readonly position: number | null;
}

/** A list of favorite products, in the order they are shown at the till. */
export interface ProductFavorites {
  readonly id: string;
  readonly name: string;
  readonly products: readonly FavoriteProduct[];
}

/** How a promotion applies to the products or categories of a cart. */
export type PromotionSelection = 'only_n' | 'all';
/** What a promotion discounts. */
export type DiscountType = 'on_total' | 'on_products' | 'on_categories';
/** Whether a discount value is a percentage or an amount. */
export type DiscountValueType = 'percentage' | 'amount';
/** Whether the minimum amount includes the tax. */
export type AmountTax = 'tax_included' | 'tax_excluded';

/** A promotion. Dates are ISO 8601 text or `null`. */
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
    readonly amountTax: AmountTax | null;
    readonly seatExcluded: boolean;
    readonly serviceExcluded: boolean;
    readonly tipExcluded: boolean;
    readonly deliveryExcluded: boolean;
    readonly products: {
      readonly type: PromotionSelection | null;
      readonly n: number | null;
      readonly qt: number | null;
      readonly productIds: readonly string[];
    };
    readonly categories: {
      readonly type: 'only_n' | null;
      readonly n: number | null;
      readonly categoryIds: readonly string[];
    };
  };
  readonly actions: {
    readonly discountType: DiscountType | null;
    readonly discountValue: number | null;
    readonly discountValueType: DiscountValueType | null;
    readonly productIds: readonly string[];
    readonly categoryIds: readonly string[];
    readonly freeShipping: boolean;
  };
}
