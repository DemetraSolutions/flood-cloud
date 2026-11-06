import { ObjectId } from 'mongodb';
import { array, integer, nullable, object, optional, personName, string } from '../../../shared/validation/schema.ts';
import type { Infer } from '../../../shared/validation/schema.ts';
import { defineCatalog } from './catalog.ts';
import { MAX_REFERENCES, integerOf, invalid, mergePatch, recordsOf, textOf } from './kit.ts';

/** Most product favorites lists a group may have. */
export const MAX_PRODUCT_FAVORITES = 50;

/** A product in a favorites list: the product (`favorites[]._id`, stored as `ObjectId`) and its position (`null` when not set). */
export interface FavoriteProduct {
  readonly productId: string;
  readonly position: number | null;
}

/**
 * A list of favorite products (legacy `productsFavorites[]`): `{ id, name, favorites: [{ _id, position }] }`, where `favorites` is `products`.
 * Keys the backend does not manage (`count`…) stay as they are. The products must exist in the group.
 */
export interface ProductFavorite {
  readonly id: string;
  readonly name: string;
  readonly products: readonly FavoriteProduct[];
}

const productsSchema = array(object({ productId: string({ min: 24, max: 24, pattern: /^[0-9a-f]{24}$/ }), position: optional(nullable(integer({ min: 0, max: 100000 }))) }), {
  max: MAX_REFERENCES,
});

/** Body of the creation of a favorites list: the name is required; `products` is the whole list in the order to keep. */
export const createProductFavoriteBody = object({ name: personName(200), products: optional(productsSchema) });

/** Body of the modification of a favorites list (JSON Merge Patch): `products`, when present, replaces the list. */
export const patchProductFavoriteBody = object({ name: optional(personName(200)), products: optional(productsSchema) });

type CreateBody = Infer<typeof createProductFavoriteBody>;
type PatchBody = Infer<typeof patchProductFavoriteBody>;

/** The favorites lists (`/product-favorites`). */
export const productFavorites = defineCatalog<ProductFavorite, CreateBody, PatchBody>({
  name: 'productFavorite',
  segment: 'product-favorites',
  path: 'productsFavorites',
  kind: 'array',
  limit: MAX_PRODUCT_FAVORITES,
  idKey: 'id',
  readPermission: 'products:read',
  updatePermission: 'products:update',
  operations: { create: true, patch: 'PATCH', remove: true },
  createSchema: createProductFavoriteBody,
  patchSchema: patchProductFavoriteBody,
  toElement: (id, raw, anomalies) => {
    const products: FavoriteProduct[] = [];
    for (const favorite of recordsOf(raw['favorites'])) {
      if (favorite['_id'] instanceof ObjectId) {
        products.push({ productId: favorite['_id'].toHexString(), position: integerOf(favorite['position']) });
      } else {
        anomalies.push({ kind: 'invalidElement', field: `productsFavorites.${id}.favorites` });
      }
    }
    return { id, name: textOf(raw['name']) ?? '', products };
  },
  defaults: (id) => ({ id, name: '', products: [] }),
  merge: (current, body) => {
    const { products, ...rest } = body;
    const base = mergePatch(current, rest);
    if (products === undefined) {
      return base;
    }
    const seen = new Set<string>();
    return {
      ...base,
      products: products.map((product, index) => {
        if (seen.has(product.productId)) {
          throw invalid(`products.${String(index)}.productId`, 'incorrect');
        }
        seen.add(product.productId);
        return { productId: product.productId, position: product.position ?? null };
      }),
    };
  },
  toRaw: (element, raw) => ({
    ...raw,
    id: element.id,
    name: element.name,
    favorites: element.products.map((product) => {
      const stored = recordsOf(raw?.['favorites']).find((candidate) => candidate['_id'] instanceof ObjectId && candidate['_id'].toHexString() === product.productId);
      return { ...stored, _id: ObjectId.createFromHexString(product.productId), position: product.position };
    }),
  }),
  check: ({ element, body }) => (body.products === undefined ? [] : [{ field: 'products', suffix: '.productId', collection: 'products', ids: element.products.map((product) => product.productId) }]),
});
