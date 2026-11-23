import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import { PRODUCTS_INSERT_ONLY_FIELDS, PRODUCTS_OWNED_FIELDS, PRODUCTS_OWNED_TREES, PRODUCTS_STOCK_LEAVES } from '../../db/collections.ts';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { withScope } from '../../shared/security/scope/scope-filters.ts';
import { createEntityRepository, sameAs } from '../product-catalog/entity.repository.ts';
import type { EntityRepository } from '../product-catalog/entity.repository.ts';
import { contactName } from '../group-lookup/lookup.repository.ts';
import { categoriesVisibleTo } from '../product-categories/categories.availability.ts';

/** Most products reported as users of a product (a refused deletion lists at most these, for each kind of user). */
export const MAX_REPORTED_PRODUCTS = 20;

/** Most products read to look for the other products that use a code, a PLU or a barcode. */
export const MAX_DUPLICATE_SCAN = 100;

/** Most products one read of the bills of materials looks at (the walk that looks for a cycle). */
export const MAX_BUNDLE_READ = 2000;

/** The fields a row of the list reads: never the whole document. */
const ROW_PROJECTION = Object.freeze({
  type: 1,
  code: 1,
  name: 1,
  status: 1,
  updateDate: 1,
  categories: 1,
  'availability.warehouse': 1,
  'bundleProducts._id': 1,
  quantity: 1,
  prices: 1,
  'lastAveragePrice.lastSupplierId': 1,
  placesAvailability: 1,
  'variant.status': 1,
  trash: 1,
  trashDate: 1,
} as const);

/** The path of a leaf of the stock a write may set: `quantity.__<placeId>.__<storageId>.min|max|location`. */
const STOCK_LEAF = new RegExp(`^quantity\\.__[0-9a-f]{24}\\.__[0-9a-f]{24}\\.(${PRODUCTS_STOCK_LEAVES.join('|')})$`);

/** The kinds of product that use another one (a refused deletion names them). */
export type ProductUserKind = 'bundles' | 'menus' | 'modifierChoices' | 'modifierLists';

/** A product or a category that uses a product, with where it is available (the places decide whether a company or place administrator may be told about it). */
export interface ProductUser {
  readonly id: string;
  readonly placesAvailability: unknown;
}

/** What a read of the other products that use the same code, PLU or barcode looks for. */
export interface DuplicateQuery {
  readonly code: string | null;
  readonly plu: string | null;
  readonly barcodes: readonly string[];
}

/** The `products` collection of a group database, as seen by a caller. */
export interface ProductsRepository extends EntityRepository {
  /**
   * The other products, not in the trash, that have one of the values (a code, a PLU or a barcode): their ids, the three fields and where they are available. At most {@link MAX_DUPLICATE_SCAN}: the
   * check is a warning, so a long tail is counted, not read.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id The product the values belong to, excluded.
   * @param query The values.
   */
  usingValues(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, query: DuplicateQuery): Promise<Document[]>;
  /**
   * Tells which of some products are valid for a use: they exist and are not in the trash, a modifier or not as asked, and (for a company or place administrator) reached by the caller. One query limited to the list.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param ids The ids to check, hexadecimal.
   * @param use `modifier`: only modifiers; `plain`: only products that are not modifiers.
   * @param scoped Whether a company or place administrator may use only the products he reaches.
   * @returns The positions, in the list, of the ids that are not valid.
   */
  invalid(principal: AuthPrincipal, access: GroupAccess, ids: readonly string[], use: 'modifier' | 'plain', scoped: boolean): Promise<number[]>;
  /**
   * The components of the bill of materials of some products (whatever the caller reaches: a cycle cannot be judged on a part of the data).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param ids The products, hexadecimal (at most {@link MAX_BUNDLE_READ}).
   * @returns The components of each product that exists, hexadecimal.
   */
  componentsOf(principal: AuthPrincipal, access: GroupAccess, ids: readonly string[]): Promise<Map<string, string[]>>;
  /**
   * The products, not in the trash, that use a product in one of the four ways (at most {@link MAX_REPORTED_PRODUCTS}).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the product.
   * @param kind In its bill of materials, in a menu, in a group of choices of modifiers, or in the lists of modifiers.
   */
  users(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, kind: ProductUserKind): Promise<ProductUser[]>;
  /**
   * The categories whose list of modifiers (`variants`) has the product (at most {@link MAX_REPORTED_PRODUCTS}).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the product.
   * @returns The categories with where they are available (the places decide whether a company or place administrator may be told about them).
   */
  categoriesWithModifier(principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<ProductUser[]>;
  /**
   * Moves a product to the trash or takes it out, only if it is still as it was read.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the product.
   * @param to The new state.
   * @param now The date of the change (`trashDate` and `updateDate`: the POS reads the products by `updateDate`).
   * @param read What the product had when it was read: its `updateDate`, `trash` and `placesAvailability`.
   * @returns Whether the product was changed (`false` when it changed, or went, since it was read).
   */
  setTrash(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, to: 'trashed' | 'restored', now: Date, read: { readonly updateDate: unknown; readonly trash: unknown; readonly placesAvailability: unknown }): Promise<boolean>;
  /**
   * Deletes a product that is in the trash, only if it is still as it was read.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the product.
   * @param read What the product had when it was read.
   * @returns Whether a product was deleted.
   */
  removeTrashed(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, read: { readonly updateDate: unknown; readonly placesAvailability: unknown }): Promise<boolean>;
  /**
   * The ids of the products in the trash that the caller reaches, in `_id` order, at most `limit`.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param limit How many ids at most.
   * @param after Only the products with an id greater than this one, `null` for all.
   */
  trashedIds(principal: AuthPrincipal, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  /**
   * How many products in the trash the caller reaches.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   */
  countTrashed(principal: AuthPrincipal, access: GroupAccess): Promise<number>;
  /**
   * The display names of some contacts (company name, else name and surname, in clear; `null` when there is none), in one read limited to the ids: what a page of the list shows as the last supplier (a contact in the trash has no name shown; one that is no longer a supplier keeps it).
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param ids The contacts, hexadecimal (at most a page).
   * @returns The name of each contact that exists.
   */
  supplierNames(principal: AuthPrincipal, access: GroupAccess, ids: readonly string[]): Promise<Map<string, string | null>>;
  /**
   * The users of the group that provide a product as a service (`servicesId`): at most {@link MAX_REPORTED_PRODUCTS}, trashed users included (a user taken out of the trash would have a service that is gone).
   *
   * @param access Verified access to the group.
   * @param id Id of the product.
   * @returns The ids, hexadecimal.
   */
  serviceUsers(access: GroupAccess, id: ObjectId): Promise<string[]>;
}

/**
 * Builds the repository of the products. The collection is the `products` of the group database, opened from the verified access, so a product of another group is never reachable.
 *
 * @param databases Database accessor.
 */
export function createProductsRepository(databases: Databases): ProductsRepository {
  const products = (principal: AuthPrincipal, access: GroupAccess) => groupDatabaseFor(principal, access, databases).collection('products');
  const idsOf = (documents: readonly Document[]): ObjectId[] => documents.map((document) => document['_id'] as ObjectId);
  const either = (id: ObjectId): { $in: Array<ObjectId | string> } => ({ $in: [id, id.toHexString()] });
  const read = <T>(work: () => Promise<T>): Promise<T> => bounded(work);
  const base = createEntityRepository(databases, {
    open: (db) => db.collection('products'),
    ownedFields: PRODUCTS_OWNED_FIELDS,
    summary: ROW_PROJECTION,
    trees: PRODUCTS_OWNED_TREES,
    visible: categoriesVisibleTo,
    owns: (path) => STOCK_LEAF.test(path),
    insertOnly: PRODUCTS_INSERT_ONLY_FIELDS,
    readFields: ['quantity', 'lastAveragePrice'],
  });
  const usersFilter = (id: ObjectId, kind: ProductUserKind): Filter<Document> => {
    switch (kind) {
      case 'bundles':
        return { 'bundleProducts._id': either(id) };
      case 'menus':
        return { 'selectableBundleProducts.products._id': either(id) };
      case 'modifierChoices':
        return { 'selectableVariantsBundleProducts.products._id': either(id) };
      case 'modifierLists':
        return { $or: [{ variantsRequired: either(id) }, { variants: either(id) }, { variantsExcluded: either(id) }] };
    }
  };

  return {
    ...base,

    usingValues: async (principal, access, id, query) => {
      const conditions: Filter<Document>[] = [
        ...(query.code === null ? [] : [{ code: query.code }]),
        ...(query.plu === null ? [] : [{ plu: query.plu }]),
        ...(query.barcodes.length === 0 ? [] : [{ 'barcode.value': { $in: [...query.barcodes] } }]),
      ];
      if (conditions.length === 0) {
        return [];
      }
      return read(() =>
        products(principal, access)
          .find({ _id: { $ne: id }, trash: { $ne: true }, $or: conditions }, { projection: { code: 1, plu: 1, 'barcode.value': 1, placesAvailability: 1 }, limit: MAX_DUPLICATE_SCAN, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
    },

    invalid: async (principal, access, ids, use, scoped) => {
      const wanted = [...new Set(ids)].map((id) => ObjectId.createFromHexString(id));
      const found = await read(() =>
        products(principal, access)
          .find(withScope(scoped ? categoriesVisibleTo(principal) : {}, { _id: { $in: wanted }, trash: { $ne: true }, 'variant.status': use === 'modifier' ? true : { $ne: true } }), { projection: { _id: 1 }, limit: wanted.length, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      const valid = new Set(idsOf(found).map((id) => id.toHexString()));
      return ids.flatMap((id, index) => (valid.has(id) ? [] : [index]));
    },

    componentsOf: async (principal, access, ids) => {
      const found = await read(() =>
        products(principal, access)
          .find({ _id: { $in: ids.map((id) => ObjectId.createFromHexString(id)) } }, { projection: { 'bundleProducts._id': 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      return new Map(
        found.map((document) => [
          (document['_id'] as ObjectId).toHexString(),
          (Array.isArray(document['bundleProducts']) ? (document['bundleProducts'] as unknown[]) : []).flatMap((component) => {
            const componentId = (component as Document | null)?.['_id'] as unknown;
            return componentId instanceof ObjectId ? [componentId.toHexString()] : typeof componentId === 'string' && /^[0-9a-f]{24}$/.test(componentId) ? [componentId] : [];
          }),
        ]),
      );
    },

    users: async (principal, access, id, kind) =>
      (
        await read(() =>
          products(principal, access)
            .find({ _id: { $ne: id }, trash: { $ne: true }, ...usersFilter(id, kind) }, { projection: { placesAvailability: 1 }, limit: MAX_REPORTED_PRODUCTS, maxTimeMS: LIST_MAX_TIME_MS })
            .toArray(),
        )
      ).map((document) => ({ id: (document['_id'] as ObjectId).toHexString(), placesAvailability: document['placesAvailability'] as unknown })),

    categoriesWithModifier: async (principal, access, id) =>
      (
        await read(() =>
          groupDatabaseFor(principal, access, databases).collection('products_categories').find({ variants: either(id) }, { projection: { placesAvailability: 1 }, limit: MAX_REPORTED_PRODUCTS, maxTimeMS: LIST_MAX_TIME_MS }).toArray(),
        )
      ).map((document) => ({ id: (document['_id'] as ObjectId).toHexString(), placesAvailability: document['placesAvailability'] as unknown })),

    setTrash: async (principal, access, id, to, now, state) => {
      const update: Document = to === 'trashed' ? { $set: { trash: true, trashDate: now, updateDate: now } } : { $set: { trash: false, updateDate: now }, $unset: { trashDate: '' } };
      const guard: Filter<Document> = { _id: id, ...sameAs('updateDate', state.updateDate), ...sameAs('trash', state.trash), ...sameAs('placesAvailability', state.placesAvailability) };
      return (await products(principal, access).updateOne(guard, update)).matchedCount === 1;
    },

    removeTrashed: async (principal, access, id, state) =>
      (await products(principal, access).deleteOne({ _id: id, trash: true, ...sameAs('updateDate', state.updateDate), ...sameAs('placesAvailability', state.placesAvailability) })).deletedCount === 1,

    trashedIds: async (principal, access, limit, after) =>
      idsOf(
        await read(() =>
          products(principal, access)
            .find(withScope(categoriesVisibleTo(principal), { trash: true, ...(after === null ? {} : { _id: { $gt: after } }) }), { projection: { _id: 1 }, sort: { _id: 1 }, limit, maxTimeMS: LIST_MAX_TIME_MS })
            .toArray(),
        ),
      ),

    countTrashed: (principal, access) => read(() => products(principal, access).countDocuments(withScope(categoriesVisibleTo(principal), { trash: true }), { maxTimeMS: LIST_MAX_TIME_MS })),

    supplierNames: async (principal, access, ids) => {
      const wanted = ids.map((id) => ObjectId.createFromHexString(id));
      const found = await read(() =>
        groupDatabaseFor(principal, access, databases)
          .collection('contacts')
          .aggregate([{ $match: { _id: { $in: wanted }, trash: { $ne: true } } }, { $limit: wanted.length }, { $project: { companyName: 1, name: 1, surname: 1 } }, { $addFields: { __name: contactName() } }, { $project: { __name: 1 } }], { maxTimeMS: LIST_MAX_TIME_MS })
          .toArray(),
      );
      return new Map(found.map((contact) => [(contact['_id'] as ObjectId).toHexString(), typeof contact['__name'] === 'string' ? contact['__name'] : null]));
    },

    serviceUsers: async (access, id) =>
      idsOf(await read(() => databases.common().collection('users').find({ groupId: access.groupId, servicesId: either(id) }, { projection: { _id: 1 }, limit: MAX_REPORTED_PRODUCTS, maxTimeMS: LIST_MAX_TIME_MS }).toArray())).map((userId) => userId.toHexString()),
  };
}
