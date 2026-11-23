import { MAX_CURSOR_LENGTH } from '../../shared/http/list.ts';
import { enumOf, integerString, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import { isoInstant } from '../groups/catalogs/kit.ts';
import { PRODUCT_FAMILIES } from '../products/products.mapper.ts';

/** Page of the products a store reads when it asks for none. */
export const STORE_PRODUCTS_DEFAULT_PAGE = 25;

/** Largest page of products a store may ask for: half of the backoffice list, because every product comes whole. */
export const STORE_PRODUCTS_MAX_PAGE = 50;

/** Page of the categories a store reads when it asks for none. */
export const STORE_CATEGORIES_DEFAULT_PAGE = 50;

/** Largest page of categories a store may ask for: the largest page of the backoffice list. */
export const STORE_CATEGORIES_MAX_PAGE = 100;

/** Largest page of departments a store may ask for. */
export const STORE_DEPARTMENTS_MAX_PAGE = 100;

const cursor = () => optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false }));

/**
 * Query of `GET /v1/store-context/catalog/products`: the page (`limit`, `cursor`), the family (every family when left out) and `updatedSince`, an ISO 8601 instant. Nothing else: no search, no sort, no
 * filter of the place (it is the one of the key), and any other parameter is `422`.
 */
export const storeProductsQuery = object({
  limit: optional(integerString({ min: 1, max: STORE_PRODUCTS_MAX_PAGE })),
  cursor: cursor(),
  family: optional(enumOf(PRODUCT_FAMILIES)),
  updatedSince: optional(isoInstant()),
});

/** The validated query of the products of a store. */
export type StoreProductsQuery = Infer<typeof storeProductsQuery>;

/** Query of `GET /v1/store-context/catalog/categories`: the page and `updatedSince`. Nothing else. */
export const storeCategoriesQuery = object({
  limit: optional(integerString({ min: 1, max: STORE_CATEGORIES_MAX_PAGE })),
  cursor: cursor(),
  updatedSince: optional(isoInstant()),
});

/** The validated query of the categories of a store. */
export type StoreCategoriesQuery = Infer<typeof storeCategoriesQuery>;

/** Query of `GET /v1/store-context/catalog/departments`: the page only. */
export const storeDepartmentsQuery = object({ limit: optional(integerString({ min: 1, max: STORE_DEPARTMENTS_MAX_PAGE })), cursor: cursor() });

/** The validated query of the departments of a store. */
export type StoreDepartmentsQuery = Infer<typeof storeDepartmentsQuery>;

/** Path parameters of the routes on one product (the builder has already checked that it is an id). */
export const storeProductParams = object({ productId: objectId() }, { allowUnknown: true });

/** Path parameters of the routes on one category (the builder has already checked that it is an id). */
export const storeCategoryParams = object({ categoryId: objectId() }, { allowUnknown: true });
