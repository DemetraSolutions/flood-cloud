import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { findPlacesUsingCategory, readPlaceSetups } from '../../shared/security/scope/group-mirror.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import { recordsOf, textOf } from '../groups/catalogs/kit.ts';
import { MAX_REPORTED_CATEGORIES } from './categories.repository.ts';

/** What a place has that a category refers to: its print stations and its production centers. */
export interface PlaceSetup {
  /** The ids of the print stations of the place (`printStations[].id`). */
  readonly stationIds: ReadonlySet<string>;
  /** The ids of the production centers of the place (`productionCenter[].id`). */
  readonly centerIds: ReadonlySet<string>;
  /** The ids of the storages of the place (`storages[].id`, `ObjectId`s), hexadecimal: the stock of a product is kept by place and storage. */
  readonly storageIds: ReadonlySet<string>;
}

/** The places of a group, as the categories need them (read from the copies in the common database). */
export interface CategoryPlaces {
  /**
   * The print stations, the production centers and the storages of some places. A place the group database has no document of has none.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param placeIds The places, hexadecimal (at most the 200 a category may name).
   * @returns The setup of each place asked for.
   */
  setupOf(principal: AuthPrincipal, access: GroupAccess, placeIds: readonly string[]): Promise<ReadonlyMap<string, PlaceSetup>>;
  /**
   * The places that still refer to a category: in the categories a print station makes a summary for (`printStations[].summaryCategoriesIds`), in the kiosk (`kiosk.upsellingCategoryId`,
   * `kiosk.productsCategories`), in the self ordering of any price list (`selfOrdering.priceListsConfig.<id>.productsCategories`) and in the map to the categories of TS Hospitality
   * (`integrations.tsh.categoriesMap`). One query limited to {@link MAX_REPORTED_CATEGORIES} places, with only the id projected, `maxTimeMS` and `503`.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param id Id of the category.
   * @returns The ids of the places, hexadecimal.
   */
  using(principal: AuthPrincipal, access: GroupAccess, id: ObjectId): Promise<string[]>;
}

/** The ids of the items of a list of a place, read tolerantly: the items that are objects with a text `id`. */
const itemIds = (raw: unknown): Set<string> => new Set(recordsOf(raw).flatMap((item) => (textOf(item['id']) === null ? [] : [item['id'] as string])));

/** The ids of the storages of a list of a place, read tolerantly: the items that are objects with an `ObjectId` `id`. */
const storageIds = (raw: unknown): Set<string> => new Set(recordsOf(raw).flatMap((item) => (item['id'] instanceof ObjectId ? [item['id'].toHexString()] : [])));

/**
 * Builds the reads of the places the categories need, over the copies of the places in the common database (through the central reads of `group-mirror.ts`).
 *
 * @param databases Database accessor.
 */
export function createCategoryPlaces(databases: Databases): CategoryPlaces {
  return {
    setupOf: async (principal, access, placeIds) => {
      if (placeIds.length === 0) {
        return new Map();
      }
      const found = await bounded(() => readPlaceSetups(principal, access, databases, placeIds.map((id) => ObjectId.createFromHexString(id))));
      const setups = new Map<string, PlaceSetup>(placeIds.map((id) => [id, { stationIds: new Set(), centerIds: new Set(), storageIds: new Set() }]));
      for (const place of found) {
        setups.set((place['_id'] as ObjectId).toHexString(), { stationIds: itemIds(place['printStations']), centerIds: itemIds(place['productionCenter']), storageIds: storageIds(place['storages']) });
      }
      return setups;
    },

    using: async (principal, access, id) => (await bounded(() => findPlacesUsingCategory(principal, access, databases, id, MAX_REPORTED_CATEGORIES))).map((place) => place.toHexString()),
  };
}
