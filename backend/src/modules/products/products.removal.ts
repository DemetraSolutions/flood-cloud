import type { ObjectId } from 'mongodb';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { productFavorites } from '../groups/catalogs/product-favorites.ts';
import type { ProductFavorite } from '../groups/catalogs/product-favorites.ts';
import { promotions } from '../groups/catalogs/promotions.ts';
import type { Promotion } from '../groups/catalogs/promotions.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import { isVisibleProduct } from './products.availability.ts';
import type { ProductsRepository, ProductUserKind } from './products.repository.ts';

/** Most references of one kind a refused deletion lists. */
const MAX_REPORTED = 20;

/** What the deletion of a product reads. */
export interface RemovalDeps {
  readonly repository: Pick<ProductsRepository, 'users' | 'categoriesWithModifier' | 'serviceUsers'>;
  /** Reads the favorites and the promotions of the group. */
  readonly catalogs: Pick<CatalogsService, 'list'>;
}

/** The names the four ways a product uses another one are listed under. */
const PRODUCT_KINDS: ReadonlyArray<readonly [string, ProductUserKind]> = [
  ['productBundles', 'bundles'],
  ['productMenus', 'menus'],
  ['productModifierChoices', 'modifierChoices'],
  ['productModifierLists', 'modifierLists'],
];

/**
 * Refuses the definitive deletion of a product that is still used: in the bill of materials, in a menu, in the choices of modifiers or in the lists of modifiers of another product that is not in the trash, in the
 * list of modifiers of a category, as a service of a user, in a group of favorites or in a promotion of the group. The kinds are looked for one after the other, from the cheapest, and the search stops at the first
 * kind found: the `409` lists (at most 20 of) that kind only. A company or place administrator is named only the products he reaches and no user (the rest is one anonymous detail). Moving a product to the
 * trash is never blocked by its references.
 *
 * @param deps The reads.
 * @param principal The authenticated caller.
 * @param access Verified access to the group.
 * @param id Id of the product.
 * @throws {AppError} `CONFLICT` with a `referenced` detail for each user (`<kind>.<id>`) and, for what the caller may not be told, one anonymous `<kind>` detail.
 */
export async function guardProductRemoval(deps: RemovalDeps, principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<void> {
  const restricted = perimeterOf(principal) !== null;
  const wanted = id.toHexString();
  const refuse = (kind: string, shown: readonly string[], hidden: boolean): never => {
    throw new AppError('CONFLICT', { details: [...shown.slice(0, MAX_REPORTED).map((item) => ({ field: `${kind}.${item}`, issue: 'referenced' })), ...(hidden ? [{ field: kind, issue: 'referenced' }] : [])] });
  };
  for (const [kind, use] of PRODUCT_KINDS) {
    const users = await deps.repository.users(principal, access, id, use);
    if (users.length > 0) {
      const shown = users.filter((user) => isVisibleProduct(principal, user.placesAvailability)).map((user) => user.id);
      refuse(kind, shown, shown.length < users.length);
    }
  }
  const categories = await deps.repository.categoriesWithModifier(principal, access, id);
  if (categories.length > 0) {
    const shown = categories.filter((category) => isVisibleProduct(principal, category.placesAvailability)).map((category) => category.id);
    refuse('categoryModifiers', shown, shown.length < categories.length);
  }
  const users = await deps.repository.serviceUsers(access, id);
  if (users.length > 0) {
    refuse('serviceUsers', restricted ? [] : users, restricted);
  }
  const favorites = ((await deps.catalogs.list(productFavorites, access)) as ProductFavorite[]).filter((favorite) => favorite.products.some((product) => product.productId === wanted));
  if (favorites.length > 0) {
    refuse('favorites', favorites.map((favorite) => favorite.id), false);
  }
  const promoted = ((await deps.catalogs.list(promotions, access)) as Promotion[]).filter((promotion) => promotion.conditions.products.productIds.includes(wanted) || promotion.actions.productIds.includes(wanted));
  if (promoted.length > 0) {
    refuse('promotions', promoted.map((promotion) => promotion.id), false);
  }
}
