import { ApiError } from '../../core/api/api-error';
import { LookupKind, ReferenceApi } from '../../core/reference/reference-api';

/** What can still refer to a category (the first segment of the `field` of a `409` detail). */
export const REFERENCE_KINDS = [
  'subcategories',
  'products',
  'productModifierCategories',
  'productBundles',
  'categoryModifierCategories',
  'promotions',
  'places',
] as const;

/** A kind of reference a category can have. */
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** Where the names of the elements of a kind are read; none for a kind that has no compact read. */
const NAME_SOURCES: Readonly<Record<ReferenceKind, LookupKind | 'places' | null>> = {
  subcategories: 'product-categories',
  products: 'products',
  productModifierCategories: 'products',
  productBundles: 'products',
  categoryModifierCategories: 'product-categories',
  promotions: null,
  places: 'places',
};

/** One kind of reference of a category that cannot be deleted. */
export interface ReferenceGroup {
  readonly kind: ReferenceKind;
  /** Names of the elements (the id of one whose name cannot be read). */
  readonly items: readonly string[];
  /** Some more elements the user cannot see are referring to the category. */
  readonly hidden: boolean;
}

/** The categories that stopped a deletion, as the page shows them. */
export interface CategoryBlock {
  /** Name of the category that cannot be deleted. */
  readonly category: string;
  readonly groups: readonly ReferenceGroup[];
}

/** Whether a failure is the `409` that lists what refers to a category. */
export function isReferenced(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.code === 'CONFLICT' &&
    error.details.some((detail) => detail.issue === 'referenced')
  );
}

/** The kind and the id of a reference (`<kind>.<id>`); `id` is `null` for the anonymous detail of a kind. */
function parse(field: string): { kind: ReferenceKind; id: string | null } | null {
  const [kind, ...rest] = field.split('.');
  const known = REFERENCE_KINDS.find((candidate) => candidate === kind);
  return known === undefined ? null : { kind: known, id: rest.length === 0 ? null : rest.join('.') };
}

/**
 * The references a `409` points at, grouped by kind in the order of {@link REFERENCE_KINDS}, with
 * the names read from the compact reads of the group. Never rejects: a failed read is logged and
 * the ids are shown.
 *
 * @param reference Reference reads of the group.
 * @param groupId Group of the category.
 * @param error The `409`.
 */
export async function referenceGroups(
  reference: ReferenceApi,
  groupId: string,
  error: ApiError,
): Promise<ReferenceGroup[]> {
  const found = error.details
    .filter((detail) => detail.issue === 'referenced')
    .flatMap((detail) => parse(detail.field) ?? []);
  const groups: ReferenceGroup[] = [];
  for (const kind of REFERENCE_KINDS) {
    const entries = found.filter((entry) => entry.kind === kind);
    if (entries.length > 0) {
      const ids = entries.flatMap((entry) => entry.id ?? []);
      groups.push({
        kind,
        items: await namesOf(reference, groupId, kind, ids),
        hidden: entries.some((entry) => entry.id === null),
      });
    }
  }
  return groups;
}

/** The names of some ids of a kind; the ids when the names cannot be read. */
async function namesOf(
  reference: ReferenceApi,
  groupId: string,
  kind: ReferenceKind,
  ids: readonly string[],
): Promise<string[]> {
  const source = NAME_SOURCES[kind];
  if (source === null || ids.length === 0) {
    return [...ids];
  }
  try {
    const names =
      source === 'places'
        ? await reference.placeNames(groupId, ids)
        : await reference.lookupNames(groupId, source, ids);
    return ids.map((id) => names[id] ?? id);
  } catch (failure) {
    console.warn('Cannot read the names of what refers to the category', failure);
    return [...ids];
  }
}
