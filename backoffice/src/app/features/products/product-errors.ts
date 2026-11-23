import { ApiError } from '../../core/api/api-error';
import { LookupKind, ReferenceApi } from '../../core/reference/reference-api';

/** What can still refer to a product (the first segment of the `field` of a `409` detail), in the order the server looks for it. */
export const PRODUCT_REFERENCE_KINDS = [
  'productBundles',
  'productMenus',
  'productModifierChoices',
  'productModifierLists',
  'categoryModifiers',
  'serviceUsers',
  'favorites',
  'promotions',
] as const;

/** A kind of reference a product can have. */
export type ProductReferenceKind = (typeof PRODUCT_REFERENCE_KINDS)[number];

/** Where the names of the elements of a kind are read; none for a kind that has no compact read. */
const NAME_SOURCES: Readonly<Record<ProductReferenceKind, LookupKind | null>> = {
  productBundles: 'products',
  productMenus: 'products',
  productModifierChoices: 'products',
  productModifierLists: 'products',
  categoryModifiers: 'product-categories',
  serviceUsers: null,
  favorites: null,
  promotions: null,
};

/** One kind of reference of a product that cannot be deleted. */
export interface ProductReferenceGroup {
  readonly kind: ProductReferenceKind;
  /** Names of the elements (the id of one whose name cannot be read). */
  readonly items: readonly string[];
  /** Some more elements the user cannot see are referring to the product. */
  readonly hidden: boolean;
}

/** The product that stopped a deletion, as the page shows it. */
export interface ProductBlock {
  /** Name of the product that cannot be deleted. */
  readonly product: string;
  readonly groups: readonly ProductReferenceGroup[];
}

/** The kind and the id of a reference (`<kind>.<id>`); `id` is `null` for the anonymous detail of a kind. */
function parse(field: string): { kind: ProductReferenceKind; id: string | null } | null {
  const [kind, ...rest] = field.split('.');
  const known = PRODUCT_REFERENCE_KINDS.find((candidate) => candidate === kind);
  return known === undefined ? null : { kind: known, id: rest.length === 0 ? null : rest.join('.') };
}

/**
 * The references a `409` points at, grouped by kind in the order of {@link PRODUCT_REFERENCE_KINDS},
 * with the names read from the compact reads of the group. Never rejects: a failed read is logged
 * (with its code, never the ids) and the ids are shown.
 *
 * @param reference Reference reads of the group.
 * @param groupId Group of the product.
 * @param error The `409`.
 */
export async function productReferenceGroups(
  reference: ReferenceApi,
  groupId: string,
  error: ApiError,
): Promise<ProductReferenceGroup[]> {
  const found = error.details.filter((detail) => detail.issue === 'referenced').flatMap((detail) => parse(detail.field) ?? []);
  const groups: ProductReferenceGroup[] = [];
  for (const kind of PRODUCT_REFERENCE_KINDS) {
    const entries = found.filter((entry) => entry.kind === kind);
    if (entries.length > 0) {
      const ids = entries.flatMap((entry) => entry.id ?? []);
      groups.push({ kind, items: await namesOf(reference, groupId, kind, ids), hidden: entries.some((entry) => entry.id === null) });
    }
  }
  return groups;
}

/** The names of some ids of a kind; the ids when the names cannot be read. */
async function namesOf(
  reference: ReferenceApi,
  groupId: string,
  kind: ProductReferenceKind,
  ids: readonly string[],
): Promise<string[]> {
  const source = NAME_SOURCES[kind];
  if (source === null || ids.length === 0) {
    return [...ids];
  }
  try {
    const names = await reference.lookupNames(groupId, source, ids);
    return ids.map((id) => names[id] ?? id);
  } catch (failure) {
    console.warn('Cannot read the names of what refers to the product', failure instanceof ApiError ? failure.code : 'unexpected');
    return [...ids];
  }
}
