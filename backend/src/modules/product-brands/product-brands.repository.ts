import { PRODUCTS_BRANDS_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { createEntityRepository, entityProjection } from '../product-catalog/entity.repository.ts';
import type { EntityRepository } from '../product-catalog/entity.repository.ts';

/**
 * Builds the repository of the brands. The collection is the `products_brands` of the group database, opened from the verified access, so a brand of another group is never reachable.
 *
 * @param databases Database accessor.
 */
export function createBrandsRepository(databases: Databases): EntityRepository {
  return createEntityRepository(databases, { open: (db) => db.collection('products_brands'), ownedFields: PRODUCTS_BRANDS_OWNED_FIELDS, summary: entityProjection(PRODUCTS_BRANDS_OWNED_FIELDS) });
}
