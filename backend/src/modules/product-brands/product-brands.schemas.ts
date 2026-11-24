import { object } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';
import type { ListConfig } from '../../shared/http/list.ts';
import { localizedName } from '../../db/localized-name.ts';
import { atLeastOne, commonCreateShape, commonPatchShape, entityQuery } from '../product-catalog/entity.schemas.ts';

/** How the brands are sorted and searched: by name (the text in the language of the caller, or the first one the entry has); `q` is looked for in the name, in every language, as literal text. */
export const BRANDS_LIST: ListConfig = Object.freeze({
  sorts: Object.freeze({ name: Object.freeze({ field: 'name', kind: 'string' as const }) }),
  defaultSort: 'name',
  searchFields: Object.freeze(['name']),
});

/**
 * The sorts of the brands for the language of the caller.
 *
 * @param language The language of the caller.
 */
export function brandsListFor(language: string): ListConfig {
  return { ...BRANDS_LIST, sorts: { name: { field: 'name', kind: 'string', expression: localizedName(language) } } };
}

/** Query of the list of the brands. */
export const brandsQuery = entityQuery(BRANDS_LIST);

/** Body of `POST /v1/groups/{groupId}/product-brands`: only the name is required. The three switches the old form showed and never saved do not exist. */
export const createBrandBody = object(commonCreateShape());

/** Validated body of a creation. */
export type CreateBrandBody = Infer<typeof createBrandBody>;

/** Body of `PATCH /v1/groups/{groupId}/product-brands/{id}`: any of the fields, at least one (`required` on the body otherwise). */
export const patchBrandBody = atLeastOne(object(commonPatchShape()));

/** Validated body of a modification. */
export type PatchBrandBody = Infer<typeof patchBrandBody>;

/** What a store never sends: the image of a brand (the library of images is the group's). */
const STORE_EXCLUDED_BRAND_FIELDS = ['image'] as const;

const withoutStoreFields = <T extends Record<string, unknown>>(shape: T): Omit<T, (typeof STORE_EXCLUDED_BRAND_FIELDS)[number]> => {
  const { image: _image, ...kept } = shape;
  return kept;
};

/** Body of `POST /v1/store-context/catalog/brands`: the one of the backoffice without the `image`, which is `422` for a store. */
export const storeCreateBrandBody = object(withoutStoreFields(commonCreateShape())) as unknown as typeof createBrandBody;

/** Body of `PATCH /v1/store-context/catalog/brands/{id}`: the one of the backoffice without the `image`, which is `422` for a store. */
export const storePatchBrandBody = atLeastOne(object(withoutStoreFields(commonPatchShape()))) as unknown as typeof patchBrandBody;
