import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { withScope } from '../../shared/security/scope/scope-filters.ts';
import { recordsOf, textOf } from '../groups/catalogs/kit.ts';
import { visibleTo } from '../product-catalog/availability.ts';
import { categoriesVisibleTo } from '../product-categories/categories.availability.ts';

/** The kinds of thing a product refers to, other than products and places. */
export type ProductLinkKind = 'categories' | 'brands' | 'attributes' | 'suppliers';

/** What a product links to (a category, a brand, an attribute, a supplier), checked in the group database. */
export interface ProductLinks {
  /**
   * Tells which of some ids cannot be used by the caller: a category or a brand that does not exist (or, for a company or place administrator, that is for places outside his perimeter: judged exactly like one
   * that does not exist), an attribute that is in no group of attributes, a contact that is not a supplier (or is in the trash). One query limited to the list.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param kind What the ids are.
   * @param ids The ids to check (hexadecimal for everything but the attributes, whose ids are texts), at most a few hundred.
   * @returns The positions, in the list, of the ids that cannot be used.
   */
  invalid(principal: AuthPrincipal, access: GroupAccess, kind: ProductLinkKind, ids: readonly string[]): Promise<number[]>;
}

/**
 * Builds the checks of the references of a product (a category, a brand, an attribute, a supplier), over the group database of the verified access. A supplier is a contact with `supplier: true`, the filter the legacy backoffice
 * uses to offer the suppliers; the registry does not describe the flag, so it is one thing to confirm.
 *
 * @param databases Database accessor.
 */
export function createProductLinks(databases: Databases): ProductLinks {
  const found = (principal: AuthPrincipal, access: GroupAccess, collection: 'categories' | 'brands' | 'suppliers', ids: readonly string[]): Promise<Document[]> => {
    const wanted = [...new Set(ids)].map((id) => ObjectId.createFromHexString(id));
    const db = groupDatabaseFor(principal, access, databases);
    const options = { projection: { _id: 1 }, limit: wanted.length, maxTimeMS: LIST_MAX_TIME_MS };
    const target = { _id: { $in: wanted } } satisfies Filter<Document>;
    switch (collection) {
      case 'categories':
        return bounded(() => db.collection('products_categories').find(withScope(categoriesVisibleTo(principal), { ...target, trash: { $ne: true } }), options).toArray());
      case 'brands':
        return bounded(() => db.collection('products_brands').find(withScope(visibleTo(principal), target), options).toArray());
      case 'suppliers':
        return bounded(() => db.collection('contacts').find({ ...target, supplier: true, trash: { $ne: true } }, options).toArray());
    }
  };
  return {
    invalid: async (principal, access, kind, ids) => {
      let valid: Set<string>;
      if (kind === 'attributes') {
        // The ids of the attributes are the ones of the elements of the groups of attributes (a handful of groups, each with at most two hundred elements).
        const groups = await bounded(() =>
          groupDatabaseFor(principal, access, databases)
            .collection('products_attributes')
            .find({ 'attributes.id': { $in: [...ids] } }, { projection: { 'attributes.id': 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS })
            .toArray(),
        );
        valid = new Set(groups.flatMap((group) => recordsOf(group['attributes']).flatMap((attribute) => textOf(attribute['id']) ?? [])));
      } else {
        valid = new Set((await found(principal, access, kind, ids)).map((document) => (document['_id'] as ObjectId).toHexString()));
      }
      return ids.flatMap((id, index) => (valid.has(id) ? [] : [index]));
    },
  };
}
