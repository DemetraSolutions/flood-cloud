import { localizedName } from '../../db/localized-name.ts';
import type { ListConfig } from '../../shared/http/list.ts';
import { listQueryShape } from '../../shared/http/list.ts';
import { array, boolean, enumOf, integer, integerString, nullable, number, object, objectId, optional, record, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer, Schema } from '../../shared/validation/schema.ts';
import { SAFE_ID, isoInstant } from '../groups/catalogs/kit.ts';
import { atLeastOne, imageSchema } from '../product-catalog/entity.schemas.ts';
import { descriptionTexts, descriptionTextsPatch, nameTexts, nameTextsPatch } from '../product-catalog/texts.ts';
import { MAX_PRODUCT_PLACES } from './products.availability.ts';
import { CHOICE_PRICE_RULES, DELIVERY_UNITS, MODIFIER_TYPES, MODULAR_PRICE_RULES, PRODUCT_FAMILIES, PRODUCT_TYPES } from './products.mapper.ts';

/** Largest page of a list of products. */
export const MAX_PRODUCTS_PAGE = 100;

/** Largest body of a write of a product: the texts in twenty languages, fifty prices, five hundred components and two hundred places fit with a wide margin (the largest real product is 28 KB). */
export const PRODUCT_BODY_LIMIT = '256kb';

/** The limits of every list of a product. The real maxima of the groups are well below them (ten prices at most); they bound the size of a write and of every read of the references. */
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
  stockPlaces: 200,
  stockStorages: 20,
  stationPlaces: 200,
  stations: 100,
} as const);

/** Largest number a position, a production value, a price or a quantity may have. */
const MAX_NUMBER = 1_000_000_000;

const HEX_ID = /^[0-9a-f]{24}$/;
const hexId = () => string({ min: 24, max: 24, pattern: HEX_ID });
const stationId = () => string({ min: 1, max: 64, pattern: SAFE_ID });
const NO_CONTROL = /^[^\u0000-\u001F\u007F]*$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LANGUAGE = /^[a-z]{2}$/;

/**
 * How the products are sorted: by the date of the last change (newest first by default), by code or by name (the text in the language of the caller, or the first one the product has). The search `q` is
 * not a list search: the service looks for it in the name, as the exact code or as the exact barcode, so there are no search fields.
 */
export const PRODUCTS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({
    updatedAt: Object.freeze({ field: 'updateDate', kind: 'date' as const }),
    code: Object.freeze({ field: 'code', kind: 'string' as const }),
    name: Object.freeze({ field: 'name', kind: 'string' as const }),
  }),
  defaultSort: '-updatedAt',
  searchFields: Object.freeze([]),
});

/**
 * The sorts of the products for the language of the caller.
 *
 * @param language The language of the caller.
 */
export function productsListFor(language: string): ListConfig {
  return { ...PRODUCTS_LIST, sorts: { ...PRODUCTS_LIST.sorts, name: { field: 'name', kind: 'string', expression: localizedName(language) } } };
}

/** The `true`/`false` of a query string. */
const flag = () => transform(enumOf(['true', 'false']), (value) => value === 'true', 'enum');

/** Query of the list of the products: the standard parameters, the family (`products` by default), the filters, and `trashed` (`false` by default; `true` for the page of the trash). */
export const productsQuery = object({
  ...listQueryShape(PRODUCTS_LIST),
  limit: optional(integerString({ min: 1, max: MAX_PRODUCTS_PAGE })),
  family: optional(enumOf(PRODUCT_FAMILIES)),
  categoryId: optional(hexId()),
  supplierId: optional(hexId()),
  placeId: optional(hexId()),
  favorite: optional(flag()),
  enabled: optional(flag()),
  trashed: optional(flag()),
});

/** The validated query of the list of products. */
export type ProductsQuery = Infer<typeof productsQuery>;

/** Path parameters of the routes on one product; the group was already verified by the route. */
export const productParams = object({ productId: objectId() }, { allowUnknown: true });

/** The texts by language of a short name: each text of 1 to 18 characters (the limit of the form of the legacy backoffice). */
const shortNameTexts = () => record(string({ min: 1, max: 18, trim: true, pattern: NO_CONTROL }), { max: 20, key: LANGUAGE });
const shortNameTextsPatch = () => record(nullable(string({ min: 1, max: 18, trim: true, pattern: NO_CONTROL })), { max: 20, key: LANGUAGE });

const color = () => transform(string({ min: 7, max: 7, pattern: /^#[0-9A-Fa-f]{6}$/ }), (value) => value.toLowerCase(), 'pattern');
const position = () => nullable(integer({ min: 0, max: 1_000_000 }));
const amount = () => number({ min: 0, max: MAX_NUMBER });
const time = () => string({ min: 5, max: 5, pattern: TIME });

/** A barcode: the value (up to 64 characters, no control character), how many pieces a reading loads (`warehouse`) and sells. */
const barcode = () => object({ value: string({ min: 1, max: 64, pattern: NO_CONTROL }), loadQuantity: optional(nullable(amount())), saleQuantity: optional(nullable(amount())) });

/** The list of the barcodes: no value twice. */
const barcodes = () =>
  refine(array(barcode(), { max: PRODUCT_LIMITS.barcodes }), (value) => value.flatMap((item, index) => (value.findIndex((other) => other.value === item.value) === index ? [] : [`${String(index)}.value`])), 'incorrect');

/** A price: the list, the currency, the tax rate of the group, the gross or the net amount (at least one), the discount and the conditions. */
const price = () =>
  refine(
    object({
      id: optional(nullable(string({ min: 1, max: 64, pattern: SAFE_ID }))),
      priceListId: string({ min: 1, max: 64, pattern: SAFE_ID }),
      currency: string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
      taxId: string({ min: 1, max: 64, pattern: SAFE_ID }),
      gross: optional(amount()),
      net: optional(amount()),
      discount: optional(number({ min: 0, max: 100 })),
      validFrom: optional(nullable(isoInstant())),
      validTo: optional(nullable(isoInstant())),
      dailyFrom: optional(nullable(time())),
      dailyTo: optional(nullable(time())),
      weekDays: optional(array(integer({ min: 0, max: 6 }), { max: 7, unique: true })),
      fromQuantity: optional(nullable(amount())),
      maxSaleQuantity: optional(nullable(amount())),
    }),
    (value) => (value.gross === undefined && value.net === undefined ? ['gross'] : []),
    'required',
  );

/** A place the product is for: the place and its data (favorite, favorite on the handhelds, position and production center of the place). */
const placeEntry = () => object({ placeId: hexId(), favorite: optional(boolean()), favoriteHandheld: optional(boolean()), position: optional(position()), productionCenterId: optional(nullable(stationId())) });

/** The availability: the places, without repetitions (`places.<index>.placeId` `incorrect` for a place named twice). */
const places = () =>
  refine(
    array(placeEntry(), { max: MAX_PRODUCT_PLACES }),
    (value) => value.flatMap((entry, index) => (value.findIndex((other) => other.placeId === entry.placeId) === index ? [] : [`${String(index)}.placeId`])),
    'incorrect',
  );

const stations = () => array(stationId(), { max: PRODUCT_LIMITS.stations, unique: true });

/** The print stations of a creation: for each place, the ids of its stations. */
const stationsByPlace = () => record(stations(), { max: PRODUCT_LIMITS.stationPlaces, key: HEX_ID });

/** The print stations of a modification: for each place named, its stations, or `null` to take the place away; the places not named stay. */
const stationsByPlacePatch = () => record(nullable(stations()), { max: PRODUCT_LIMITS.stationPlaces, key: HEX_ID });

/** What a write of the stock of a storage sets: the minimum, the maximum and the location (never the quantity, which the warehouse owns). */
const stockLeaves = () => object({ min: optional(nullable(amount())), max: optional(nullable(amount())), location: optional(nullable(string({ min: 1, max: 64, pattern: NO_CONTROL }))) });

/** The stock of a request: for each place, for each storage of the place, its leaves. */
const stock = () => record(record(stockLeaves(), { max: PRODUCT_LIMITS.stockStorages, key: HEX_ID }), { max: PRODUCT_LIMITS.stockPlaces, key: HEX_ID });

/** A supplier: a contact of the group that is a supplier, the code and the name the supplier gives the product, the delivery and the price lists of the supplier. */
const supplier = () =>
  object({
    contactId: hexId(),
    code: optional(nullable(string({ min: 1, max: 64, pattern: NO_CONTROL }))),
    name: optional(nullable(string({ min: 1, max: 150, pattern: NO_CONTROL }))),
    minQuantity: optional(nullable(amount())),
    deliveryTime: optional(nullable(amount())),
    deliveryTimeUnit: optional(nullable(enumOf(DELIVERY_UNITS))),
    favorite: optional(boolean()),
    priceLists: optional(
      array(object({ id: string({ min: 1, max: 64, pattern: SAFE_ID }), price: optional(nullable(amount())), discount1: optional(nullable(number({ min: 0, max: 100 }))), discount2: optional(nullable(number({ min: 0, max: 100 }))), discount3: optional(nullable(number({ min: 0, max: 100 }))) }), {
        max: PRODUCT_LIMITS.supplierPriceLists,
      }),
    ),
  });

const suppliers = () =>
  refine(array(supplier(), { max: PRODUCT_LIMITS.suppliers }), (value) => value.flatMap((item, index) => (value.findIndex((other) => other.contactId === item.contactId) === index ? [] : [`${String(index)}.contactId`])), 'incorrect');

/** The ids of the products of a group of choices of a menu. */
const choiceProducts = () => array(hexId(), { max: PRODUCT_LIMITS.choiceProducts, unique: true });

const components = () =>
  refine(
    array(object({ productId: hexId(), quantity: number({ min: 0.000001, max: MAX_NUMBER }), waste: optional(nullable(number({ min: 0, max: 100 }))) }), { max: PRODUCT_LIMITS.components }),
    (value) => value.flatMap((item, index) => (value.findIndex((other) => other.productId === item.productId) === index ? [] : [`${String(index)}.productId`])),
    'incorrect',
  );

const menu = () => array(object({ categoryId: hexId(), quantity: integer({ min: 1, max: 100 }), course: optional(nullable(integer({ min: 0, max: 99 }))), productIds: optional(choiceProducts()) }), { max: PRODUCT_LIMITS.menuGroups });

const modifierChoices = () =>
  array(object({ categoryId: hexId(), freeQuantity: number({ min: 0, max: 100 }), priceRule: enumOf(Object.keys(CHOICE_PRICE_RULES) as ['highest', 'lowest']), productIds: optional(choiceProducts()) }), { max: PRODUCT_LIMITS.menuGroups });

/** The images of the gallery, from the library of the group, without repetitions. */
const gallery = () =>
  refine(
    array(object({ imageId: string({ min: 24, max: 24, pattern: HEX_ID }) }), { max: PRODUCT_LIMITS.gallery }),
    (value) => value.flatMap((item, index) => (value.findIndex((other) => other.imageId === item.imageId) === index ? [] : [`${String(index)}.imageId`])),
    'incorrect',
  );

/** What a creation and a modification have in common, except the texts: every field optional but the name of a creation. */
function commonShape() {
  return {
    type: optional(enumOf(PRODUCT_TYPES)),
    enabled: optional(boolean()),
    code: optional(string({ max: 64, trim: true, pattern: NO_CONTROL })),
    plu: optional(nullable(string({ min: 1, max: 6, pattern: /^(0|[1-9][0-9]{0,5})$/ }))),
    barcodes: optional(barcodes()),
    favorite: optional(boolean()),
    favoriteHandheld: optional(boolean()),
    generic: optional(boolean()),
    toCheck: optional(boolean()),
    noDiscount: optional(boolean()),
    brandId: optional(nullable(hexId())),
    categoryIds: optional(array(hexId(), { max: PRODUCT_LIMITS.categories, unique: true })),
    attributeIds: optional(array(string({ min: 1, max: 64, pattern: SAFE_ID }), { max: PRODUCT_LIMITS.attributes, unique: true })),
    position: optional(position()),
    productionValue: optional(position()),
    duration: optional(nullable(time())),
    maxConcurrent: optional(nullable(integer({ min: 0, max: 100_000 }))),
    availability: optional(object({ pos: optional(boolean()), warehouse: optional(boolean()), scales: optional(boolean()), ecommerce: optional(boolean()) })),
    featured: optional(boolean()),
    integrations: optional(object({ floodOrders: optional(boolean()), yellgo: optional(boolean()), leggimenu: optional(boolean()) })),
    validFrom: optional(nullable(isoInstant())),
    validTo: optional(nullable(isoInstant())),
    requiredModifierIds: optional(array(hexId(), { max: PRODUCT_LIMITS.modifiers, unique: true })),
    modifierIds: optional(array(hexId(), { max: PRODUCT_LIMITS.modifiers, unique: true })),
    excludedModifierIds: optional(array(hexId(), { max: PRODUCT_LIMITS.modifiers, unique: true })),
    modifierCategoryIds: optional(array(hexId(), { max: PRODUCT_LIMITS.modifierCategories, unique: true })),
    scaleType: optional(enumOf(['weight', 'piece'] as const)),
    loadUnit: optional(nullable(string({ min: 1, max: 20, trim: true, pattern: NO_CONTROL }))),
    unloadUnit: optional(nullable(string({ min: 1, max: 20, trim: true, pattern: NO_CONTROL }))),
    conversionRatio: optional(number({ min: 0.000001, max: MAX_NUMBER })),
    colors: optional(object({ text: optional(color()), background: optional(color()) })),
    dining: optional(object({ halfPortion: optional(boolean()), feePercentage: optional(nullable(number({ min: 0, max: 100 }))), hiddenOnHandheld: optional(boolean()), affiliatedMenu: optional(boolean()), reversePrint: optional(boolean()) })),
    prices: optional(array(price(), { max: PRODUCT_LIMITS.prices })),
    places: optional(places()),
    stock: optional(stock()),
    simpleCost: optional(nullable(amount())),
    suppliers: optional(suppliers()),
    shipping: optional(object({ width: optional(nullable(amount())), height: optional(nullable(amount())), depth: optional(nullable(amount())), weight: optional(nullable(amount())) })),
    components: optional(components()),
    menu: optional(menu()),
    modifierChoices: optional(modifierChoices()),
    modularPriceRule: optional(nullable(enumOf(Object.keys(MODULAR_PRICE_RULES) as ['average', 'sum', 'fixed']))),
    image: optional(imageSchema()),
    gallery: optional(gallery()),
    internalFileName: optional(nullable(string({ min: 1, max: 255, trim: true, pattern: NO_CONTROL }))),
    externalUrl: optional(nullable(externalUrl())),
  };
}

/** An external URL: `https` only, no user or password, at most 2048 characters. */
function externalUrl(): Schema<string, false> {
  return transform(
    string({ min: 1, max: 2048, trim: true, pattern: NO_CONTROL }),
    (value) => {
      const url = URL.canParse(value) ? new URL(value) : null;
      return url !== null && url.protocol === 'https:' && url.username === '' && url.password === '' ? value : undefined;
    },
    'format',
  );
}

const modifierBase = () => ({ type: optional(enumOf(MODIFIER_TYPES)), pricePercentagePlus: optional(nullable(number({ min: 0, max: 1000 }))), pricePercentageMinus: optional(nullable(number({ min: 0, max: 100 }))) });

/** Body of `POST /v1/groups/{groupId}/products`: only the name is required. Nothing else is accepted. */
export const createProductBody = object({
  ...commonShape(),
  name: nameTexts(),
  shortName: optional(shortNameTexts()),
  description: optional(descriptionTexts()),
  shortDescription: optional(descriptionTexts()),
  isModifier: optional(boolean()),
  modifier: optional(object({ ...modifierBase(), description: optional(descriptionTexts()) })),
  printStations: optional(stationsByPlace()),
  counterPrintStations: optional(stationsByPlace()),
});

/** Validated body of a creation. */
export type CreateProductBody = Infer<typeof createProductBody>;

/** Body of `PATCH /v1/groups/{groupId}/products/{id}`: any of the fields, at least one (`required` on the body otherwise). `isModifier` can only be repeated as it is. */
export const patchProductBody = atLeastOne(
  object({
    ...commonShape(),
    name: optional(nameTextsPatch()),
    shortName: optional(shortNameTextsPatch()),
    description: optional(descriptionTextsPatch()),
    shortDescription: optional(descriptionTextsPatch()),
    isModifier: optional(boolean()),
    modifier: optional(object({ ...modifierBase(), description: optional(descriptionTextsPatch()) })),
    printStations: optional(stationsByPlacePatch()),
    counterPrintStations: optional(stationsByPlacePatch()),
  }),
);

/** Validated body of a modification. */
export type PatchProductBody = Infer<typeof patchProductBody>;

/** The fields every write has, for the code that reads them without caring whether it is a creation or a modification. */
export type ProductBody = CreateProductBody | PatchProductBody;
