import type { FeatureFlags } from '../groups/features.ts';
import type { Category } from '../product-categories/categories.service.ts';
import type { PatchCategoryBody } from '../product-categories/categories.schemas.ts';
import type { PatchProductBody } from '../products/products.schemas.ts';
import { centsOf } from './public-catalog.mapper.ts';
import type { ProductSource } from './public-catalog.mapper.ts';

/**
 * The list of references to send to a service: the ones the client sent plus, each at the position it had, the stored ones the key does not reach (they were never shown, so the client cannot have sent them back).
 *
 * @param sent The ids the client sent.
 * @param stored The ids the entry has now, all of them.
 * @param reachable The ids among the stored ones that the key reaches.
 */
export function withHiddenIds(sent: readonly string[], stored: readonly string[], reachable: ReadonlySet<string>): string[] {
  const merged = [...sent];
  stored.forEach((id, index) => {
    if (!reachable.has(id) && !merged.includes(id)) {
      merged.splice(Math.min(index, merged.length), 0, id);
    }
  });
  return merged;
}

/** The stored choices of a menu or of a group of modifiers, by category: the first not used yet is the one a sent choice of that category stands for. */
function takeByCategory<T extends { readonly categoryId: string | null }>(stored: readonly T[]): (categoryId: string) => T | undefined {
  const used = new Set<T>();
  return (categoryId) => {
    const found = stored.find((choice) => choice.categoryId === categoryId && !used.has(choice));
    if (found !== undefined) {
      used.add(found);
    }
    return found;
  };
}

/**
 * Completes a modification of a product with what the key does not see, so that what it does not send stays as it is: the loading quantity of a barcode (by value), the production center and the handheld favorite of a
 * place (by place), the course of a menu choice (by category), the products the key does not reach in the lists of modifiers, menus and choices, and a price amount that is the same cent as the one stored (a fraction of a cent
 * of the legacy is not rounded away). Only the fields the body names are touched.
 *
 * @param body The internal body made from the public one.
 * @param stored The product as it is now, for the same key.
 * @param reachable The ids of the products the stored lists name that the key reaches.
 * @param features The functions of the group (a hidden field of a function the group does not have is not sent back).
 */
export function preserveProduct(body: PatchProductBody, stored: ProductSource, reachable: ReadonlySet<string>, features: Pick<FeatureFlags, 'rooms' | 'warehouse'>): PatchProductBody {
  const next: PatchProductBody = { ...body };
  if (body.barcodes !== undefined) {
    next.barcodes = body.barcodes.map((barcode) => {
      const old = stored.barcodes.find((candidate) => candidate.value === barcode.value);
      return barcode.loadQuantity === undefined && features.warehouse && old?.loadQuantity !== undefined ? { ...barcode, loadQuantity: old.loadQuantity } : barcode;
    });
  }
  if (body.places !== undefined) {
    next.places = body.places.map((place) => {
      const old = stored.places.find((candidate) => candidate.placeId === place.placeId);
      return {
        ...place,
        ...(old === undefined || old.productionCenterId === null ? {} : { productionCenterId: old.productionCenterId }),
        ...(old === undefined || !old.favoriteHandheld || !features.rooms ? {} : { favoriteHandheld: true }),
      };
    });
  }
  if (body.prices !== undefined) {
    next.prices = body.prices.map((price) => {
      const old = price.id == null ? undefined : stored.prices.find((candidate) => candidate.id === price.id);
      return old !== undefined && old.gross !== null && price.gross !== undefined && centsOf(old.gross) === centsOf(price.gross) ? { ...price, gross: old.gross } : price;
    });
  }
  const lists = [
    ['requiredModifierIds', stored.requiredModifierIds],
    ['modifierIds', stored.modifierIds],
    ['excludedModifierIds', stored.excludedModifierIds],
  ] as const;
  for (const [field, current] of lists) {
    const sent = body[field];
    if (sent !== undefined) {
      next[field] = withHiddenIds(sent, current ?? [], reachable);
    }
  }
  if (body.menu !== undefined) {
    const take = takeByCategory(stored.menu ?? []);
    next.menu = body.menu.map((choice) => {
      const old = take(choice.categoryId);
      return {
        ...choice,
        ...(old === undefined || !features.rooms || choice.course !== undefined || old.course == null ? {} : { course: old.course }),
        ...(choice.productIds === undefined ? {} : { productIds: withHiddenIds(choice.productIds, old?.productIds ?? [], reachable) }),
      };
    });
  }
  if (body.modifierChoices !== undefined) {
    const take = takeByCategory(stored.modifierChoices ?? []);
    next.modifierChoices = body.modifierChoices.map((choice) => {
      const old = take(choice.categoryId);
      return choice.productIds === undefined ? choice : { ...choice, productIds: withHiddenIds(choice.productIds, old?.productIds ?? [], reachable) };
    });
  }
  return next;
}

/**
 * Completes a modification of a category with what the key does not see: the production center of a place (by place) and the modifiers it does not reach.
 *
 * @param body The internal body made from the public one.
 * @param stored The category as it is now, for the same key.
 * @param reachable The ids of the modifiers the stored list names that the key reaches.
 */
export function preserveCategory(body: PatchCategoryBody, stored: Category, reachable: ReadonlySet<string>): PatchCategoryBody {
  const next: PatchCategoryBody = { ...body };
  if (body.places !== undefined) {
    next.places = body.places.map((place) => {
      const old = stored.places.find((candidate) => candidate.placeId === place.placeId);
      return place.productionCenterId === undefined && old?.productionCenterId != null ? { ...place, productionCenterId: old.productionCenterId } : place;
    });
  }
  if (body.modifierIds !== undefined) {
    next.modifierIds = withHiddenIds(body.modifierIds, stored.modifierIds ?? [], reachable);
  }
  return next;
}
