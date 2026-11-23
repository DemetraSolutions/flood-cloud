import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { PRODUCTS_CATEGORIES_OWNED_FIELDS, PRODUCTS_CATEGORIES_OWNED_TREES } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { withScope } from '../../shared/security/scope/scope-filters.ts';
import { createEntityRepository, entityProjection } from '../product-catalog/entity.repository.ts';
import type { EntityRepository } from '../product-catalog/entity.repository.ts';
import { categoriesVisibleTo } from './categories.availability.ts';
import { MAX_CATEGORIES } from './categories.tree.ts';
import type { TreeNode } from './categories.tree.ts';

/** Most categories reported as users of a category (a refused deletion lists at most these, for each kind of user). */
export const MAX_REPORTED_CATEGORIES = 20;

/** The `products_categories` collection of a group database, as seen by a caller. */
export interface CategoriesRepository extends EntityRepository {
  /**
   * Every category of the group with its stored parent, whoever the caller is (the tree is one for everybody, and a cycle or a depth cannot be judged on a part of it). One query with only the parent
   * projected, `maxTimeMS` and `503`.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @returns The categories, or `null` when the group has more than {@link MAX_CATEGORIES} (the tree is then not read, never read on a part).
   */
  nodes(principal: CatalogCaller, access: GroupAccess): Promise<TreeNode[] | null>;
  /**
   * The ids of the categories the caller reaches (every one for the roles that are not limited to places).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @returns At most {@link MAX_CATEGORIES} ids.
   */
  reachableIds(principal: CatalogCaller, access: GroupAccess): Promise<Set<string>>;
  /**
   * The categories the caller reaches, with what the compact tree shows (name, stored parent, position, state), at most {@link MAX_CATEGORIES}.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   */
  treeDocuments(principal: CatalogCaller, access: GroupAccess): Promise<Document[]>;
  /**
   * The categories whose stored parent is a category, itself excluded (one that is its own parent is not its own child): at most {@link MAX_REPORTED_CATEGORIES}.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the category.
   * @returns The ids, hexadecimal.
   */
  subcategories(principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<string[]>;
  /**
   * The other categories that apply a category as a category of modifiers (`variantsCategories`): at most {@link MAX_REPORTED_CATEGORIES}.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the category.
   * @returns The ids, hexadecimal.
   */
  modifierCategoryUsers(principal: CatalogCaller, access: GroupAccess, id: ObjectId): Promise<string[]>;
}

/** What the compact tree reads of a category. */
const TREE_PROJECTION = Object.freeze({ name: 1, parentId: 1, position: 1, status: 1 } as const);

/**
 * Builds the repository of the categories. The collection is the `products_categories` of the group database, opened from the verified access, so a category of another group is never reachable.
 *
 * @param databases Database accessor.
 */
export function createCategoriesRepository(databases: Databases): CategoriesRepository {
  const categories = (principal: CatalogCaller, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('products_categories');
  const idsOf = (documents: readonly Document[]): string[] => documents.map((document) => (document['_id'] as ObjectId).toHexString());
  return {
    ...createEntityRepository(databases, {
      open: (db) => db.collection('products_categories'),
      ownedFields: PRODUCTS_CATEGORIES_OWNED_FIELDS,
      summary: entityProjection(PRODUCTS_CATEGORIES_OWNED_FIELDS),
      visible: categoriesVisibleTo,
      trees: PRODUCTS_CATEGORIES_OWNED_TREES,
    }),

    nodes: async (principal, access) => {
      const found = await bounded(() => categories(principal, access).find({}, { projection: { parentId: 1 }, limit: MAX_CATEGORIES + 1, maxTimeMS: LIST_MAX_TIME_MS }).toArray());
      return found.length > MAX_CATEGORIES ? null : found.map((document) => ({ id: (document['_id'] as ObjectId).toHexString(), parent: document['parentId'] instanceof ObjectId ? document['parentId'].toHexString() : null }));
    },

    reachableIds: async (principal, access) =>
      new Set(idsOf(await bounded(() => categories(principal, access).find(withScope(categoriesVisibleTo(principal), {}), { projection: { _id: 1 }, limit: MAX_CATEGORIES, maxTimeMS: LIST_MAX_TIME_MS }).toArray()))),

    treeDocuments: (principal, access) =>
      bounded(() => categories(principal, access).find(withScope(categoriesVisibleTo(principal), {}), { projection: TREE_PROJECTION, limit: MAX_CATEGORIES, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),

    subcategories: async (principal, access, id) =>
      idsOf(await bounded(() => categories(principal, access).find({ parentId: id, _id: { $ne: id } }, { projection: { _id: 1 }, limit: MAX_REPORTED_CATEGORIES, maxTimeMS: LIST_MAX_TIME_MS }).toArray())),

    modifierCategoryUsers: async (principal, access, id) =>
      idsOf(
        await bounded(() =>
          categories(principal, access)
            .find({ variantsCategories: { $in: [id, id.toHexString()] }, _id: { $ne: id } }, { projection: { _id: 1 }, limit: MAX_REPORTED_CATEGORIES, maxTimeMS: LIST_MAX_TIME_MS })
            .toArray(),
        ),
      ),
  };
}
