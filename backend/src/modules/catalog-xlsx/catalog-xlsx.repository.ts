import { ObjectId } from 'mongodb';
import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { AppError } from '../../shared/http/errors.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import { readCatalogPlaces } from '../../shared/security/scope/group-mirror.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import { withScope } from '../../shared/security/scope/scope-filters.ts';
import { recordsOf, textOf } from '../groups/catalogs/kit.ts';
import { categoriesVisibleTo } from '../product-categories/categories.availability.ts';
import { perimeterOf } from '../product-catalog/availability.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';

/** Most points of sale the workbook has columns for: each has one column in each of the two sheets of products and three in the sheet of the categories, and the reader of the import is told so. */
export const MAX_PLACE_COLUMNS = 60;

/** A point of sale of the perimeter of the caller, with its print stations. */
export interface CatalogPlace {
  readonly id: string;
  readonly name: string;
  readonly stations: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

/** The reads the workbook needs that the catalog services do not offer. */
export interface CatalogXlsxRepository {
  /**
   * The points of sale of the group that are not in the trash and that the caller reaches (all of them for the roles that are not limited to places, his own ones for a company or place administrator), by name.
   *
   * @throws {AppError} `PAYLOAD_TOO_LARGE` when there are more than {@link MAX_PLACE_COLUMNS}.
   */
  places(principal: CatalogCaller, access: GroupAccess): Promise<CatalogPlace[]>;
  /** How many documents of the `products` collection the caller reaches match a filter, counted up to `cap + 1`. */
  countProducts(principal: CatalogCaller, access: GroupAccess, filter: Filter<Document>, cap: number): Promise<number>;
}

/**
 * Builds the reads of the workbook. The group database is opened from the verified access; the points of sale are read from the `places` of the group database (the copies in the common database, through the central read of `group-mirror.ts`), only with the projection of what the workbook shows.
 *
 * @param databases Database accessor.
 */
export function createCatalogXlsxRepository(databases: Databases): CatalogXlsxRepository {
  return {
    places: async (principal, access) => {
      const allowed = perimeterOf(principal);
      const found = await bounded(() => readCatalogPlaces(principal, access, databases, allowed === null ? null : [...allowed].map((id) => ObjectId.createFromHexString(id)), MAX_PLACE_COLUMNS + 1));
      if (found.length > MAX_PLACE_COLUMNS) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: `The group has more than ${String(MAX_PLACE_COLUMNS)} points of sale: the workbook cannot hold them` });
      }
      return found.flatMap((place) => {
        const name = textOf(place['name'])?.trim() ?? '';
        return name === ''
          ? []
          : [
              {
                id: (place['_id'] as ObjectId).toHexString(),
                name,
                stations: recordsOf(place['printStations']).flatMap((station) => {
                  const id = textOf(station['id']);
                  const stationName = textOf(station['name'])?.trim() ?? '';
                  return id === null || stationName === '' ? [] : [{ id, name: stationName }];
                }),
              },
            ];
      });
    },

    countProducts: (principal, access, filter, cap) =>
      bounded(() => groupDatabaseFor(principal, access, databases).collection('products').countDocuments(withScope(categoriesVisibleTo(principal), filter), { limit: cap + 1, maxTimeMS: LIST_MAX_TIME_MS })),
  };
}
