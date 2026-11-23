import { FeatureName } from '../../core/groups/feature-catalog';
import { CatalogImage, LocalizedText } from '../product-catalog/product-catalog.types';

/** Path segment of the products under `/v1/groups/{groupId}`. */
export const PRODUCTS_SEGMENT = 'products';

/** The four families the catalog is shown in (computed by the server). */
export type ProductFamily = 'products' | 'services' | 'tgm' | 'modifiers';

/** The types a product has. */
export type ProductType = 'product' | 'service' | 'exempt' | 'tobaccos' | 'games' | 'monopoly';

/** What tells a family from the others in the shared list and detail pages. */
export interface FamilySettings {
  readonly family: ProductFamily;
  /** Path segment of the family under `/groups/:groupId` in the router. */
  readonly segment: string;
  /** Name of the group of dictionary keys (`PRODUCTS.<text>.*`). */
  readonly text: 'PRODUCTS' | 'SERVICES' | 'MODIFIERS' | 'TOBACCOS';
  /** The types a product of the family can have, in the order the form offers them. */
  readonly types: readonly ProductType[];
  /** Type of a new product of the family. */
  readonly defaultType: ProductType;
  /** Feature of the group the family needs; `null` for none. */
  readonly feature: FeatureName | null;
  /** Whether the products of the family are modifiers (`isModifier` of a creation). */
  readonly modifier: boolean;
}

/** The settings of each family. */
export const FAMILIES: Readonly<Record<ProductFamily, FamilySettings>> = Object.freeze({
  products: {
    family: 'products',
    segment: 'products',
    text: 'PRODUCTS',
    types: ['product', 'exempt'],
    defaultType: 'product',
    feature: null,
    modifier: false,
  },
  services: {
    family: 'services',
    segment: 'services',
    text: 'SERVICES',
    types: ['service'],
    defaultType: 'service',
    feature: 'services',
    modifier: false,
  },
  modifiers: {
    family: 'modifiers',
    segment: 'product-modifiers',
    text: 'MODIFIERS',
    types: ['product', 'exempt'],
    defaultType: 'product',
    feature: 'productsVariants',
    modifier: true,
  },
  tgm: {
    family: 'tgm',
    segment: 'tobacco-products',
    text: 'TOBACCOS',
    types: ['tobaccos', 'games', 'monopoly'],
    defaultType: 'tobaccos',
    feature: 'tobaccosGamesMonopoly',
    modifier: false,
  },
});

/** The families, in the order of the menu. */
export const FAMILY_ORDER: readonly ProductFamily[] = Object.freeze([
  'products',
  'services',
  'modifiers',
  'tgm',
]);

/** Limits of the server (`PRODUCT_LIMITS` and the schemas of the products). */
export const PRODUCT_LIMITS = Object.freeze({
  prices: 50,
  barcodes: 100,
  categories: 100,
  attributes: 200,
  modifiers: 500,
  modifierCategories: 200,
  components: 200,
  menuGroups: 50,
  choiceProducts: 500,
  suppliers: 50,
  supplierPriceLists: 20,
  gallery: 20,
  places: 200,
  code: 64,
  shortName: 18,
  barcode: 64,
  pluDigits: 6,
  position: 1_000_000,
  number: 1_000_000_000,
  percentage: 100,
  modifierPlus: 1000,
  maxConcurrent: 100_000,
  menuQuantity: 100,
  course: 99,
  unit: 20,
  location: 64,
  supplierCode: 64,
  supplierName: 150,
  internalFileName: 255,
  externalUrl: 2048,
});

/** The features of the group that decide which fields and tabs a product has. */
export const PRODUCT_FEATURES = Object.freeze([
  'cash',
  'rooms',
  'ordering',
  'warehouse',
  'tobaccosGamesMonopoly',
  'productsVariants',
  'services',
  'customersApp',
  'media',
  'scales',
  'advancedProducts',
] as const);

/** The features of a group a product depends on. */
export type ProductFeatures = Readonly<Record<(typeof PRODUCT_FEATURES)[number], boolean>>;

/** Kind of a modifier (`modifier.type`). */
export type ModifierType = 'addRemove' | 'add' | 'remove' | 'info';

/** The kinds of modifier, in the order of the legacy form. */
export const MODIFIER_TYPES: readonly ModifierType[] = Object.freeze(['addRemove', 'add', 'remove', 'info']);

/** How the price of a composable product is made (`average` is what the server accepts and stores as the legacy refuses to spell). */
export type ModularPriceRule = 'average' | 'sum' | 'fixed';

/** The rules of the price of a composable product. */
export const MODULAR_PRICE_RULES: readonly ModularPriceRule[] = Object.freeze(['average', 'sum', 'fixed']);

/** What a group of choices of modifiers charges: the most expensive or the cheapest ones. */
export type ChoicePriceRule = 'highest' | 'lowest';

/** The rules of the price of a group of choices. */
export const CHOICE_PRICE_RULES: readonly ChoicePriceRule[] = Object.freeze(['highest', 'lowest']);

/** The units a supplier delivers in. */
export type DeliveryUnit = 'days' | 'months' | 'years';

/** The delivery units, in the order of the legacy form. */
export const DELIVERY_UNITS: readonly DeliveryUnit[] = Object.freeze(['days', 'months', 'years']);

/** A barcode of a product. */
export interface Barcode {
  readonly value: string;
  readonly loadQuantity?: number | null;
  readonly saleQuantity: number | null;
}

/** The copy of the tax rate a price holds (read only). */
export interface PriceTax {
  readonly rate: number | null;
  readonly department: number | null;
  readonly description: string | null;
  readonly vatNature: string | null;
}

/** A rule of a price list of a product (decimal amounts, never cents). */
export interface Price {
  readonly id: string | null;
  readonly priceListId: string | null;
  readonly currency: string | null;
  readonly taxId: string | null;
  readonly tax: PriceTax | null;
  readonly net: number | null;
  readonly gross: number | null;
  readonly discount: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly dailyFrom: string | null;
  readonly dailyTo: string | null;
  readonly weekDays: readonly number[];
  readonly fromQuantity: number | null;
  readonly maxSaleQuantity: number | null;
}

/** A store a product is for. */
export interface ProductPlace {
  readonly placeId: string;
  readonly favorite: boolean;
  readonly favoriteHandheld: boolean;
  readonly position: number | null;
  readonly productionCenterId: string | null;
}

/** Print stations by store. */
export type StationsByPlace = Readonly<Record<string, readonly string[]>>;

/** The stock of a product in a storage of a store. */
export interface StockEntry {
  readonly quantity: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly location: string | null;
}

/** The stock of a product: by store, by storage. */
export type StockByPlace = Readonly<Record<string, Readonly<Record<string, StockEntry>>>>;

/** One of the forms of cost of a product (read only). */
export interface Cost {
  readonly last: number | null;
  readonly average: number | null;
  readonly weightedAverage: number | null;
}

/** The costs of a product (read only: the warehouse maintains them). */
export interface Costs extends Cost {
  readonly lastSupplierId: string | null;
  readonly bySupplier: Readonly<Record<string, Cost>>;
}

/** A component of the bill of materials. */
export interface Component {
  readonly productId: string;
  readonly quantity: number | null;
  readonly waste: number | null;
}

/** A group of choices of a menu. */
export interface MenuChoice {
  readonly categoryId: string | null;
  readonly quantity: number | null;
  readonly course?: number | null;
  readonly productIds: readonly string[];
}

/** A group of choices of modifiers. */
export interface ModifierChoice {
  readonly categoryId: string | null;
  readonly freeQuantity: number | null;
  readonly priceRule: ChoicePriceRule | null;
  readonly productIds: readonly string[];
}

/** A price list of a supplier for a product. */
export interface SupplierPriceList {
  readonly id: string | null;
  readonly price: number | null;
  readonly discount1: number | null;
  readonly discount2: number | null;
  readonly discount3: number | null;
}

/** A supplier of a product. */
export interface Supplier {
  readonly contactId: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly minQuantity: number | null;
  readonly deliveryTime: number | null;
  readonly deliveryTimeUnit: DeliveryUnit | null;
  readonly favorite: boolean;
  readonly priceLists: readonly SupplierPriceList[];
}

/** The switches of the publication of a product on the integrations. */
export interface ProductIntegrations {
  readonly floodOrders: boolean;
  readonly yellgo: boolean;
  readonly leggimenu: boolean;
}

/** The settings of a modifier. */
export interface ModifierSettings {
  readonly type: ModifierType | null;
  readonly pricePercentagePlus: number | null;
  readonly pricePercentageMinus: number | null;
  readonly description: LocalizedText;
}

/** A value that other products use too (the save went through: it is only a warning). */
export interface ProductWarning {
  /** `code`, `plu` or `barcodes.<index>`. */
  readonly field: string;
  readonly issue: 'duplicate';
  /** At most five products the caller reaches that use the value. */
  readonly productIds: readonly string[];
  /** How many other products use it that are not named. */
  readonly others: number;
}

/** A product as the server returns it (detail and the answer of every write). Fields of a feature the group lacks are absent. */
export interface Product {
  readonly id: string;
  readonly family: ProductFamily;
  readonly type: ProductType | null;
  readonly isModifier: boolean;
  readonly enabled: boolean;
  readonly code: string | null;
  readonly plu?: string | null;
  readonly name: LocalizedText;
  readonly shortName: LocalizedText;
  readonly description: LocalizedText;
  readonly shortDescription: LocalizedText;
  readonly favorite: boolean;
  readonly favoriteHandheld?: boolean;
  readonly generic: boolean;
  readonly toCheck: boolean;
  readonly noDiscount: boolean;
  readonly brandId: string | null;
  readonly categoryIds: readonly string[];
  readonly attributeIds: readonly string[];
  readonly position: number | null;
  readonly productionValue: number | null;
  readonly duration?: string | null;
  readonly maxConcurrent?: number | null;
  readonly availability?: {
    readonly pos?: boolean;
    readonly warehouse?: boolean;
    readonly scales?: boolean;
    readonly ecommerce?: boolean;
  };
  readonly featured?: boolean;
  readonly integrations: ProductIntegrations;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly modifier?: ModifierSettings;
  readonly requiredModifierIds?: readonly string[];
  readonly modifierIds?: readonly string[];
  readonly excludedModifierIds?: readonly string[];
  readonly modifierCategoryIds?: readonly string[];
  readonly scaleType?: 'weight' | 'piece' | null;
  readonly loadUnit?: string | null;
  readonly unloadUnit?: string | null;
  readonly conversionRatio?: number | null;
  readonly colors?: { readonly text: string | null; readonly background: string | null };
  readonly dining?: {
    readonly halfPortion: boolean;
    readonly feePercentage: number | null;
    readonly hiddenOnHandheld: boolean;
    readonly affiliatedMenu: boolean;
    readonly reversePrint: boolean;
  };
  readonly barcodes: readonly Barcode[];
  readonly prices: readonly Price[];
  readonly places: readonly ProductPlace[];
  readonly printStations?: StationsByPlace;
  readonly counterPrintStations?: StationsByPlace;
  readonly stock?: StockByPlace;
  readonly costs?: Costs;
  readonly simpleCost: number | null;
  readonly suppliers: readonly Supplier[];
  readonly shipping: {
    readonly width: number | null;
    readonly height: number | null;
    readonly depth: number | null;
    readonly weight: number | null;
  };
  readonly components: readonly Component[];
  readonly menu?: readonly MenuChoice[];
  readonly modifierChoices?: readonly ModifierChoice[];
  readonly modularPriceRule?: ModularPriceRule | null;
  readonly image?: CatalogImage | null;
  readonly gallery?: readonly CatalogImage[];
  readonly internalFileName?: string | null;
  readonly externalUrl?: string | null;
  /** The caller may change, trash and delete the product as a whole. */
  readonly editable: boolean;
  /** The caller may change the data of their own stores (availability, print stations and stock limits). */
  readonly placeEditable: boolean;
  readonly trashed: boolean;
  readonly trashedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** The values other products use too (reads and the answers of a creation and a modification). */
  readonly warnings?: readonly ProductWarning[];
}

/** A row of the list of products. */
export interface ProductRow {
  readonly id: string;
  readonly family: ProductFamily;
  readonly type: ProductType | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly updatedAt: string | null;
  readonly categoryIds: readonly string[];
  /** `null` for a product that does not move the warehouse (or a service, or a group without `warehouse`). */
  readonly stock: { readonly quantity: number | null; readonly composite: boolean };
  /** The price of the default price list, with tax and discount. */
  readonly price: number | null;
  readonly lastSupplierId: string | null;
  /** Name of the last supplier (`null` for none or one the caller cannot read). */
  readonly lastSupplierName: string | null;
  readonly editable: boolean;
  readonly placeEditable: boolean;
  readonly trashed: boolean;
  readonly trashedAt: string | null;
}

/** The outcome of an item of the bulk move to the trash. */
export interface ProductTrashResult {
  readonly id: string;
  readonly outcome: 'trashed' | 'skipped';
  readonly issue?: 'notFound' | 'forbidden' | 'alreadyTrashed' | 'conflict';
}

/** The answer of the bulk move to the trash. */
export interface ProductTrashResponse {
  readonly results: readonly ProductTrashResult[];
}

/** The features of a product as a record, from a reader of the features of the group. */
export function featuresOf(enabled: (name: (typeof PRODUCT_FEATURES)[number]) => boolean): ProductFeatures {
  return Object.fromEntries(PRODUCT_FEATURES.map((name) => [name, enabled(name)])) as ProductFeatures;
}

/**
 * Router commands of the list of a family, of one product or of the page of a new one.
 *
 * @param groupId Group of the products.
 * @param family The family of the products.
 * @param productId The product; `null` for the page of a new one, omitted for the list.
 */
export function productRoute(
  groupId: string,
  family: ProductFamily,
  productId?: string | null,
): string[] {
  const base = ['/groups', groupId, FAMILIES[family].segment];
  return productId === undefined ? base : [...base, productId === null ? 'new' : productId];
}
