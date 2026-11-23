import { ProductRow } from '../app/features/products/product.types';

export const PRODUCT_ID_1 = '665f1c2e9b1d4a0012ab3a01';
export const PRODUCT_ID_2 = '665f1c2e9b1d4a0012ab3a02';
export const PRODUCT_ID_3 = '665f1c2e9b1d4a0012ab3a03';
export const SUPPLIER_ID = '665f1c2e9b1d4a0012ab3b01';

/** A row of the list of products (every field set to something plausible); override what the test cares about. */
export function productRow(id: string, over: Partial<ProductRow> = {}): ProductRow {
  return {
    id,
    family: 'products',
    type: 'product',
    code: 'C-001',
    name: 'Acqua',
    enabled: true,
    updatedAt: '2026-05-01T10:30:00.000Z',
    categoryIds: [],
    stock: { quantity: null, composite: false },
    price: null,
    lastSupplierId: null,
    lastSupplierName: null,
    editable: true,
    placeEditable: true,
    trashed: false,
    trashedAt: null,
    ...over,
  };
}

/** A trashed product of the trash tab. */
export function trashedProduct(id: string, over: Partial<ProductRow> = {}): ProductRow {
  return productRow(id, { trashed: true, trashedAt: '2026-11-10T10:00:00.000Z', ...over });
}

/** Rows of the trash tab of the products. */
export const TRASHED_PRODUCT = trashedProduct(PRODUCT_ID_1, { name: 'Acqua', code: 'C-001' });
export const TRASHED_SERVICE = trashedProduct(PRODUCT_ID_2, {
  name: 'Taglio',
  code: null,
  family: 'services',
  type: 'service',
  trashedAt: null,
});
export const TRASHED_NAMELESS = trashedProduct(PRODUCT_ID_3, { name: null, code: 'C-003', family: 'tgm' });
