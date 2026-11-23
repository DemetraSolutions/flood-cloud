import { PRODUCTS_ATTRIBUTES_OWNED_FIELDS } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { createEntityRepository, entityProjection } from '../product-catalog/entity.repository.ts';
import type { EntityRepository } from '../product-catalog/entity.repository.ts';

/**
 * Builds the repository of the groups of attributes. The collection is the `products_attributes` of the group database, opened from the verified access, so a group of attributes of another group
 * is never reachable. The groups of attributes have no places, so every caller reaches all of them.
 *
 * @param databases Database accessor.
 */
export function createAttributeGroupsRepository(databases: Databases): EntityRepository {
  return createEntityRepository(databases, {
    open: (db) => db.collection('products_attributes'),
    ownedFields: PRODUCTS_ATTRIBUTES_OWNED_FIELDS,
    summary: entityProjection(PRODUCTS_ATTRIBUTES_OWNED_FIELDS),
  });
}
