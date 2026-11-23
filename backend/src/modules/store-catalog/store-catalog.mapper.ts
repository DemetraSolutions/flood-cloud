import { withoutCosts } from '../products/products.mapper.ts';
import type { ProductWithoutCosts } from '../products/products.mapper.ts';
import type { ProductDetail, ProductResult } from '../products/products.service.ts';

/** A product as the server of a point of sale reads it: the representation of the backoffice for the places the store has, without the costs, the suppliers and the simple cost (the type refuses a product that has them). */
export type StoreProduct = ProductWithoutCosts;

/** A duplicate of a code, PLU or barcode, as the store is told: where, never which other products (they are the group's, not the store's). */
export interface StoreWarning {
  /** `code`, `plu` or `barcodes.<index>`. */
  readonly field: string;
  readonly issue: 'duplicate';
}

/** A product with the warnings of its code, PLU and barcodes, as the store reads it. */
export type StoreProductDetail = StoreProduct & { readonly warnings?: readonly StoreWarning[] };

/** A product with its version (the `ETag` of the response, the `If-Match` of the next write). */
export interface StoreProductResult {
  readonly entity: StoreProductDetail;
  readonly version: string;
}

/**
 * The product of a response for a store: the costs, the suppliers and the simple cost are dropped and the warnings keep their field and nothing else (no id of another product, no count). Built field by field.
 *
 * @param detail The product as the service of the products gave it.
 */
export function toStoreProduct(detail: ProductDetail): StoreProductDetail {
  const { warnings, ...view } = detail;
  return { ...withoutCosts(view), ...(warnings === undefined ? {} : { warnings: warnings.map((warning) => ({ field: warning.field, issue: warning.issue })) }) };
}

/**
 * The result of a read or a write of a product, for a store.
 *
 * @param result The result of the service of the products.
 */
export function toStoreProductResult(result: ProductResult): StoreProductResult {
  return { entity: toStoreProduct(result.entity), version: result.version };
}
