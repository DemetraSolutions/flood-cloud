import type { Catalog } from './catalog.ts';
import { cardTypes } from './card-types.ts';
import { currencies } from './currencies.ts';
import { fidelityCardRules } from './fidelity-card-rules.ts';
import { measureUnits } from './measure-units.ts';
import { pointsCollections } from './points-collections.ts';
import { priceLists } from './price-lists.ts';
import { prizeCatalogues } from './prize-catalogues.ts';
import { productFavorites } from './product-favorites.ts';
import { promotions } from './promotions.ts';
import { taxes } from './taxes.ts';
import { warehouseRules } from './warehouse-rules.ts';

/**
 * Every catalog kept in the document of a group, each with its own sub-resource under `/groups/{groupId}`. The first six are the ones of the
 * group form of the legacy backoffice (permissions `groups:read` and `groups:update`); the loyalty ones follow `fidelity:*`, the favorites and the
 * promotions follow `products:*`.
 */
export const CATALOGS: readonly Catalog[] = [
  priceLists,
  taxes,
  currencies,
  measureUnits,
  warehouseRules,
  fidelityCardRules,
  cardTypes,
  pointsCollections,
  prizeCatalogues,
  productFavorites,
  promotions,
];

/** The stored paths the detail of a group reads: the catalogs of the group form, and the currencies the loyalty rules follow. */
export const DETAIL_CATALOG_PATHS: readonly string[] = Object.freeze(['priceLists', 'taxes', 'currencies', 'measureUnits', 'warehouseRules', 'fidelityCardRules']);
