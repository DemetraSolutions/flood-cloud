import { MAX_CURSOR_LENGTH } from '../../shared/http/list.ts';
import { array, boolean, enumOf, integer, integerString, nullable, number, object, objectId, optional, refine, string, transform } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { SAFE_ID, isoInstant } from '../groups/catalogs/kit.ts';
import { atLeastOne } from '../product-catalog/entity.schemas.ts';
import { MAX_CATEGORY_PLACES } from '../product-categories/categories.availability.ts';
import { commonShape as categoryShape, createFields as categoryCreateFields, patchFields as categoryPatchFields } from '../product-categories/categories.schemas.ts';
import { MAX_PRODUCT_PLACES } from '../products/products.availability.ts';
import { PRODUCT_FAMILIES } from '../products/products.mapper.ts';
import { PRODUCT_LIMITS, commonShape as productShape, createFields as productCreateFields, hexId, patchFields as productPatchFields } from '../products/products.schemas.ts';

/** Page of the products a public key reads when it asks for none, and the largest it may ask for: every product comes whole. */
export const PUBLIC_PRODUCTS_DEFAULT_PAGE = 25;
export const PUBLIC_PRODUCTS_MAX_PAGE = 50;

/** Page of the other collections of the catalog a public key reads when it asks for none, and the largest it may ask for. */
export const PUBLIC_CATALOG_DEFAULT_PAGE = 50;
export const PUBLIC_CATALOG_MAX_PAGE = 100;

/** Largest amount of a price, in cents: the largest the backoffice accepts (a billion units of currency), which a number holds exactly. */
export const MAX_PRICE_CENTS = 100_000_000_000;

const cursor = () => optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false }));

/** `ecommerce=true`: only what is available for the e-commerce. The value `false` is not a filter and is refused. */
const onlyTrue = () => transform(enumOf(['true']), () => true as const, 'enum');

/** Query of `GET /public/v1/products`: the page, the family, `updatedSince` (an ISO 8601 instant) and `ecommerce=true`. Nothing else. */
export const publicProductsQuery = object({
  limit: optional(integerString({ min: 1, max: PUBLIC_PRODUCTS_MAX_PAGE })),
  cursor: cursor(),
  family: optional(enumOf(PRODUCT_FAMILIES)),
  updatedSince: optional(isoInstant()),
  ecommerce: optional(onlyTrue()),
});

/** The validated query of the public list of products. */
export type PublicProductsQuery = Infer<typeof publicProductsQuery>;

/** Query of `GET /public/v1/stock`: the page only. */
export const publicStockQuery = object({ limit: optional(integerString({ min: 1, max: PUBLIC_PRODUCTS_MAX_PAGE })), cursor: cursor() });

/** The validated query of the public list of stocks. */
export type PublicStockQuery = Infer<typeof publicStockQuery>;

/** Query of the public lists of the categories, the brands, the groups of attributes and the departments: the page and `updatedSince`. Nothing else. */
export const publicChangesQuery = object({ limit: optional(integerString({ min: 1, max: PUBLIC_CATALOG_MAX_PAGE })), cursor: cursor(), updatedSince: optional(isoInstant()) });

/** The validated query of a public list of the catalog. */
export type PublicChangesQuery = Infer<typeof publicChangesQuery>;

/** Path parameter of the routes on one product. */
export const publicProductParams = object({ productId: objectId() });

/** Path parameter of the routes on one category. */
export const publicCategoryParams = object({ categoryId: objectId() });

/** Path parameter of the routes on one brand. */
export const publicBrandParams = object({ brandId: objectId() });

/** Path parameter of the routes on one group of attributes. */
export const publicAttributeGroupParams = object({ attributeGroupId: objectId() });

/** Path parameter of the routes on one department. */
export const publicDepartmentParams = object({ departmentId: objectId() });

/** The status an integration may give a product or a category: a product in the trash is never written as a status (it has its own routes). */
const writableStatus = () => enumOf(['active', 'disabled'] as const);

/** A barcode of a public body: the value and how many pieces one reading sells. The loading of the warehouse is not the integrator's. */
const publicBarcode = () => object({ value: string({ min: 1, max: 64, pattern: /^[^\u0000-\u001F\u007F]*$/ }), saleQuantity: optional(nullable(number({ min: 0, max: 1_000_000_000 }))) });

/** The barcodes of a public body: no value twice. */
const publicBarcodes = () =>
  refine(array(publicBarcode(), { max: PRODUCT_LIMITS.barcodes }), (value) => value.flatMap((item, index) => (value.findIndex((other) => other.value === item.value) === index ? [] : [`${String(index)}.value`])), 'incorrect');

/**
 * A price of a public body, in cents with tax included: the list, the currency, the tax rate of the group (`taxId`), the gross amount, the discount and the conditions of validity. The server works out the amount without
 * tax. A rule that is sent back as it was read keeps its `id`.
 */
const publicPrice = () =>
  object({
    id: optional(nullable(string({ min: 1, max: 64, pattern: SAFE_ID }))),
    priceListId: string({ min: 1, max: 64, pattern: SAFE_ID }),
    currency: string({ min: 3, max: 3, pattern: /^[A-Z]{3}$/ }),
    taxId: string({ min: 1, max: 64, pattern: SAFE_ID }),
    grossCents: integer({ min: 0, max: MAX_PRICE_CENTS }),
    discountPercent: optional(number({ min: 0, max: 100 })),
    validFrom: optional(nullable(isoInstant())),
    validTo: optional(nullable(isoInstant())),
    dailyFrom: optional(nullable(string({ min: 5, max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }))),
    dailyTo: optional(nullable(string({ min: 5, max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }))),
    weekDays: optional(array(integer({ min: 0, max: 6 }), { max: 7, unique: true })),
    fromQuantity: optional(nullable(number({ min: 0, max: 1_000_000_000 }))),
    maxSaleQuantity: optional(nullable(number({ min: 0, max: 1_000_000_000 }))),
  });

/** A place of a public body: the place, whether the product is a favorite there and its position. The production center of the place is not the integrator's. */
const publicProductPlace = () => object({ placeId: hexId(), favorite: optional(boolean()), position: optional(nullable(integer({ min: 0, max: 1_000_000 }))) });

/** The places of a public body: no place twice. */
const publicProductPlaces = () =>
  refine(
    array(publicProductPlace(), { max: MAX_PRODUCT_PLACES }),
    (value) => value.flatMap((entry, index) => (value.findIndex((other) => other.placeId === entry.placeId) === index ? [] : [`${String(index)}.placeId`])),
    'incorrect',
  );

/**
 * The fields of a product a public body never has: the costs and the suppliers, the images and the files, the print stations (they are not in the shape of a product), the stock (it is read only), the bill of materials,
 * the settings of the rooms, the colors of the cash register, the integrations and the internal flags. Anything not listed here is the same as the backoffice and is governed by the functions of the group in the same way.
 */
function publicProductShape() {
  const { simpleCost: _cost, suppliers: _suppliers, image: _image, gallery: _gallery, internalFileName: _file, externalUrl: _url, integrations: _integrations, productionValue: _production, colors: _colors, dining: _dining, favoriteHandheld: _handheld, toCheck: _toCheck, stock: _stock, components: _components, enabled: _enabled, prices: _prices, places: _places, barcodes: _barcodes, ...rest } = productShape();
  return { ...rest, status: optional(writableStatus()), barcodes: optional(publicBarcodes()), prices: optional(array(publicPrice(), { max: PRODUCT_LIMITS.prices })), places: optional(publicProductPlaces()) };
}

const withoutStations = <T extends Record<string, unknown>>(shape: T): Omit<T, 'printStations' | 'counterPrintStations'> => {
  const { printStations: _stations, counterPrintStations: _counter, ...rest } = shape;
  return rest;
};

/** Body of `POST /public/v1/products`: only the name is required. Nothing else is accepted. */
export const publicCreateProductBody = object(withoutStations(productCreateFields(publicProductShape())));

/** Validated body of a public creation of a product. */
export type PublicCreateProductBody = Infer<typeof publicCreateProductBody>;

/** Body of `PATCH /public/v1/products/{productId}`: any of the fields, at least one. */
export const publicPatchProductBody = atLeastOne(object(withoutStations(productPatchFields(publicProductShape()))));

/** Validated body of a public modification of a product. */
export type PublicPatchProductBody = Infer<typeof publicPatchProductBody>;

/** A place of a public category: the place and the position of the category in it. The production center of the place is not the integrator's. */
const publicCategoryPlace = () => object({ placeId: hexId(), position: optional(nullable(integer({ min: 0, max: 1_000_000 }))) });

/** The places of a public category: no place twice. */
const publicCategoryPlaces = () =>
  refine(
    array(publicCategoryPlace(), { max: MAX_CATEGORY_PLACES }),
    (value) => value.flatMap((entry, index) => (value.findIndex((other) => other.placeId === entry.placeId) === index ? [] : [`${String(index)}.placeId`])),
    'incorrect',
  );

/** The fields of a category a public body never has: the images and the files, the print stations and the production, the settings of the rooms and of the cash register and the integrations. */
function publicCategoryShape() {
  const { image: _image, icon: _icon, internalFileName: _file, externalUrl: _url, integrations: _integrations, dining: _dining, productionValue: _production, secondaryFiscalPrinter: _printer, backgroundColor: _background, textColor: _text, enabled: _enabled, places: _places, ...rest } = categoryShape();
  return { ...rest, status: optional(writableStatus()), places: optional(publicCategoryPlaces()) };
}

const withoutCategoryStations = <T extends Record<string, unknown>>(shape: T): Omit<T, 'printStations' | 'counterPrintStations'> => withoutStations(shape);

/** Body of `POST /public/v1/categories`: only the name is required. Nothing else is accepted. */
export const publicCreateCategoryBody = object(withoutCategoryStations(categoryCreateFields(publicCategoryShape())));

/** Validated body of a public creation of a category. */
export type PublicCreateCategoryBody = Infer<typeof publicCreateCategoryBody>;

/** Body of `PATCH /public/v1/categories/{categoryId}`: any of the fields, at least one. */
export const publicPatchCategoryBody = atLeastOne(object(withoutCategoryStations(categoryPatchFields(publicCategoryShape()))));

/** Validated body of a public modification of a category. */
export type PublicPatchCategoryBody = Infer<typeof publicPatchCategoryBody>;
