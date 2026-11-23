import { CoreModel, toModel } from '../app/features/products/product-model';

/** The core model of a new product with some fields replaced, for the specs of the tabs of the product page. */
export function coreModelOf(patch: Partial<CoreModel> = {}): CoreModel {
  const { core } = toModel(null, ['it'], { type: 'product', prices: [], places: [] });
  return { ...core, ...patch };
}
