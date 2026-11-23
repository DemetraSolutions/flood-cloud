import type { Collection, Db } from 'mongodb';

/** The catalog collections of a group database, in report order. */
export const CATALOG_COLLECTIONS = ['products', 'products_categories', 'products_departments', 'products_brands', 'products_attributes'] as const;

/** One of {@link CATALOG_COLLECTIONS}. */
export type CatalogCollection = (typeof CATALOG_COLLECTIONS)[number];

/**
 * Opens each collection the catalog profile reads by its literal name (the registry test requires literal
 * names in the sources). `places` is read only for its ids.
 */
export const OPEN: Readonly<Record<CatalogCollection | 'places', (db: Db) => Collection>> = {
  products: (db) => db.collection('products'),
  products_categories: (db) => db.collection('products_categories'),
  products_departments: (db) => db.collection('products_departments'),
  products_brands: (db) => db.collection('products_brands'),
  products_attributes: (db) => db.collection('products_attributes'),
  places: (db) => db.collection('places'),
};
