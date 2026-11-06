import type { ObjectId } from 'mongodb';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { CatalogsRepository } from '../groups/catalogs/catalogs.repository.ts';
import { newElementId } from '../groups/catalogs/kit.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { productFavorites } from '../groups/catalogs/product-favorites.ts';
import type { PosOptions, PosOptionsPatch, PosPriceList } from './pos.catalog.ts';

/** What a group offers to the POS options of its users: the price lists and the favorites lists. */
export interface GroupOptionLists {
  readonly priceLists: readonly PriceList[];
  /** Ids of the favorites lists (`productsFavorites[].id`). */
  readonly favoriteIds: ReadonlySet<string>;
}

/** Reads the lists of a group the POS options of a user refer to, through the catalogs of the group (no logic of its own about their shape). */
export interface GroupOptionsReader {
  /**
   * Reads the price lists and the favorites lists of a group.
   *
   * @param groupId Id of the group (from a verified access, or the group of the authenticated user).
   * @returns The lists, or `null` when the group does not exist.
   */
  read(groupId: ObjectId): Promise<GroupOptionLists | null>;
}

/**
 * Builds the reader over the catalogs repository: the stored containers are read once and turned into elements by the definitions of the
 * `priceLists` and `productFavorites` catalogs, so a malformed element is tolerated exactly as the catalogs of the group tolerate it.
 *
 * @param catalogs Reads the containers of the group document.
 */
export function createGroupOptionsReader(catalogs: Pick<CatalogsRepository, 'read'>): GroupOptionsReader {
  return {
    read: async (groupId) => {
      const stored = await catalogs.read(groupId, ['priceLists', 'productsFavorites']);
      if (stored === null) {
        return null;
      }
      const state = { raw: (path: string) => stored.values[path], newId: newElementId };
      return {
        priceLists: priceLists.list(state, []),
        favoriteIds: new Set(productFavorites.list(state, []).map((favorite) => favorite.id)),
      };
    },
  };
}

/**
 * The price lists a new user starts with: every price list of the group, enabled, with the default one of the group selected. A user without a
 * group has none.
 *
 * @param group The lists of the user's group, `null` for a user without one.
 */
export function defaultPriceLists(group: GroupOptionLists | null): PosPriceList[] {
  return (group?.priceLists ?? []).map((list) => ({ priceListId: list.id, enabled: true, isDefault: list.isDefault }));
}

/**
 * Whether a patch of the options refers to the lists of the group, so that the group must be read.
 *
 * @param options The patch of preferences, if any.
 * @returns `true` when the patch refers to the lists of the group.
 */
export function referencesGroupLists(options: PosOptionsPatch | undefined): boolean {
  return options !== undefined && (options.priceLists !== undefined || options.favoritesId != null || options.defaultPriceListId != null);
}

/**
 * Checks the references of a POS options patch against the lists of the user's group: the price lists must exist in the group, without
 * repetitions and with at most one default; the favorites list and the default price list must exist too. A reference the user already had
 * is not checked again, so an unrelated change does not fail because a list was deleted since. A user without a group can refer to nothing.
 *
 * @param options What the request sets.
 * @param before The options the user has (`null` for a creation).
 * @param group The lists of the user's group, `null` for a user without one.
 * @param prefix Where the options sit in the request.
 * @returns One detail per problem, empty when all is fine.
 */
export function optionReferenceIssues(options: PosOptionsPatch | undefined, before: PosOptions | null, group: GroupOptionLists | null, prefix = 'pos.options'): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  const listIds = new Set((group?.priceLists ?? []).map((list) => list.id));
  const knownLists = new Set((before?.priceLists ?? []).map((list) => list.priceListId));
  const changedRef = (current: string | null | undefined, wanted: string | null | undefined): wanted is string => typeof wanted === 'string' && wanted !== current;

  if (options?.priceLists !== undefined) {
    const seen = new Set<string>();
    let defaults = 0;
    options.priceLists.forEach((list, index) => {
      const at = `${prefix}.priceLists.${String(index)}`;
      if (seen.has(list.priceListId) || (!knownLists.has(list.priceListId) && !listIds.has(list.priceListId))) {
        issues.push({ field: `${at}.priceListId`, issue: 'incorrect' });
      }
      seen.add(list.priceListId);
      if (list.isDefault && ++defaults > 1) {
        issues.push({ field: `${at}.isDefault`, issue: 'incorrect' });
      }
    });
  }
  const favorites = options?.favoritesId;
  if (changedRef(before?.favoritesId, favorites) && !(group?.favoriteIds.has(favorites) ?? false)) {
    issues.push({ field: `${prefix}.favoritesId`, issue: 'incorrect' });
  }
  const started = options?.defaultPriceListId;
  if (changedRef(before?.defaultPriceListId, started) && !listIds.has(started)) {
    issues.push({ field: `${prefix}.defaultPriceListId`, issue: 'incorrect' });
  }
  return issues;
}
