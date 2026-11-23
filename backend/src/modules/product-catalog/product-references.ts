import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { withScope } from '../../shared/security/scope/scope-filters.ts';
import { categoriesVisibleTo } from '../product-categories/categories.availability.ts';
import { isVisibleProduct } from '../products/products.availability.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';

/** What stands for the products a company or place administrator does not reach in a list of users: one anonymous entry (the callers name it with the bare kind, never with an id). */
export const ANONYMOUS_PRODUCT = '';

/** The detail field of a user of a product: `<kind>.<id>`, or the bare kind for the anonymous entry. */
export const userField = (kind: string, id: string): string => (id === ANONYMOUS_PRODUCT ? kind : `${kind}.${id}`);

/** Most products reported as users of a department, a brand or an attribute (a refused deletion lists at most these). */
export const MAX_REPORTED_PRODUCTS = 20;

/**
 * What the products of a group refer to. Every read is one query on the `products` of the group database, limited to {@link MAX_REPORTED_PRODUCTS} products, with only the id projected and a time
 * limit (`503` when it is exceeded); a product in the trash does not count. The ids come back in hexadecimal.
 */
export interface ProductReferences {
  /**
   * The products that have a brand.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param brandId Id of the brand (`brandId` of the product).
   */
  withBrand(principal: AuthPrincipal, access: GroupAccess, brandId: ObjectId): Promise<string[]>;
  /**
   * The products with a price whose tax has a fiscal department number: the POS matches the department of the cash register with it.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param department The department number of the tax (`prices[].taxData.department`).
   */
  withDepartmentNumber(principal: AuthPrincipal, access: GroupAccess, department: number): Promise<string[]>;
  /**
   * The products that use some attributes (`attributes` holds the ids of the attributes of the groups of attributes).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param attributeIds The ids of the attributes (at most the 200 of one group of attributes).
   */
  withAttributes(principal: AuthPrincipal, access: GroupAccess, attributeIds: readonly string[]): Promise<string[]>;
  /**
   * The products that are in a category (`categories` of the product).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param categoryId Id of the category.
   */
  inCategory(principal: AuthPrincipal, access: GroupAccess, categoryId: ObjectId): Promise<string[]>;
  /**
   * The products that apply a category of modifiers (`variantsCategories` of the product).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param categoryId Id of the category.
   */
  withModifierCategory(principal: AuthPrincipal, access: GroupAccess, categoryId: ObjectId): Promise<string[]>;
  /**
   * The products whose menu (`selectableBundleProducts` and `selectableVariantsBundleProducts`) takes its choices from a category.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param categoryId Id of the category.
   */
  withBundleCategory(principal: AuthPrincipal, access: GroupAccess, categoryId: ObjectId): Promise<string[]>;
  /**
   * Tells which of some products cannot be a modifier: they do not exist, are in the trash, or are not variants (`variant.status` is not `true`). One query limited to the list.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param ids The ids to check, hexadecimal (a few hundred at most).
   * @returns The positions, in the list, of the ids that are not modifiers.
   */
  notModifiers(principal: AuthPrincipal, access: GroupAccess, ids: readonly string[]): Promise<number[]>;
}

/**
 * Builds the reads of what the products refer to, over the group database of the verified access.
 *
 * @param databases Database accessor.
 */
export function createProductReferences(databases: Databases): ProductReferences {
  const users = async (principal: AuthPrincipal, access: GroupAccess, filter: Filter<Document>): Promise<string[]> => {
    const found = await bounded(() =>
      groupDatabaseFor(principal, access, databases)
        .collection('products')
        .find({ trash: { $ne: true }, ...filter }, { projection: { placesAvailability: 1 }, limit: MAX_REPORTED_PRODUCTS, maxTimeMS: LIST_MAX_TIME_MS })
        .toArray(),
    );
    // A company or place administrator is named only the products he reaches; the others are one anonymous entry (`ANONYMOUS_PRODUCT`).
    const visible = found.filter((product) => isVisibleProduct(principal, product['placesAvailability']));
    return [...visible.map((product) => (product['_id'] as ObjectId).toHexString()), ...(visible.length < found.length ? [ANONYMOUS_PRODUCT] : [])];
  };
  return {
    // The id as the `ObjectId` of the documents and, to be tolerant, as the text some older clients wrote.
    withBrand: (principal, access, brandId) => users(principal, access, { brandId: { $in: [brandId, brandId.toHexString()] } }),
    withDepartmentNumber: (principal, access, department) => users(principal, access, { 'prices.taxData.department': { $in: [department, String(department)] } }),
    withAttributes: async (principal, access, attributeIds) => (attributeIds.length === 0 ? [] : users(principal, access, { attributes: { $in: [...attributeIds] } })),
    inCategory: (principal, access, categoryId) => users(principal, access, { categories: { $in: [categoryId, categoryId.toHexString()] } }),
    withModifierCategory: (principal, access, categoryId) => users(principal, access, { variantsCategories: { $in: [categoryId, categoryId.toHexString()] } }),
    withBundleCategory: (principal, access, categoryId) => {
      const wanted = { $in: [categoryId, categoryId.toHexString()] };
      return users(principal, access, { $or: [{ 'selectableBundleProducts.categoryId': wanted }, { 'selectableVariantsBundleProducts.categoryId': wanted }] });
    },
    notModifiers: async (principal, access, ids) => {
      const wanted = [...new Set(ids)].map((id) => ObjectId.createFromHexString(id));
      const found = await bounded(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('products')
          .find(withScope(categoriesVisibleTo(principal), { _id: { $in: wanted }, 'variant.status': true, trash: { $ne: true } }), { projection: { _id: 1 }, limit: wanted.length, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      const valid = new Set(found.map((product) => (product['_id'] as ObjectId).toHexString()));
      return ids.flatMap((id, index) => (valid.has(id) ? [] : [index]));
    },
  };
}
