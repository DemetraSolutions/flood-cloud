import type { Document, Filter } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { bounded } from '../../shared/security/scope/bounded.ts';
import { groupDatabaseFor } from '../../shared/security/scope/group-access.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { ScopeHolder } from '../../shared/security/scope/principal.ts';
import { PUBLIC_SALE_PROJECTION } from './public-sales.mapper.ts';

/** The reads of the sales for the public API: nothing is written, and only the fields of {@link PUBLIC_SALE_PROJECTION} are read. */
export interface PublicSalesRepository {
  /**
   * A page of sales, the newest first (by date, then by id).
   *
   * @param caller The caller built from the key (its scope is the perimeter the filter was made from).
   * @param access Verified access to the group.
   * @param filter The perimeter, the filters and the position of the page.
   * @param limit How many sales to read.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  find(caller: ScopeHolder, access: GroupAccess, filter: Filter<Document>, limit: number): Promise<Document[]>;
  /**
   * One sale.
   *
   * @param filter The perimeter and the id.
   * @returns The stored sale, or `null` when no sale matches.
   * @throws {AppError} `SERVICE_UNAVAILABLE` when the read exceeds its time limit.
   */
  findOne(caller: ScopeHolder, access: GroupAccess, filter: Filter<Document>): Promise<Document | null>;
}

/**
 * Builds the read repository of the sales of the public API, over the group database of the verified access, with a time limit and a bound on every read.
 *
 * @param databases Database accessor.
 */
export function createPublicSalesRepository(databases: Databases): PublicSalesRepository {
  const sales = (caller: ScopeHolder, access: GroupAccess) => groupDatabaseFor(caller, access, databases).collection('sales');
  return {
    find: (caller, access, filter, limit) => bounded(() => sales(caller, access).find(filter, { projection: { ...PUBLIC_SALE_PROJECTION }, sort: { date: -1, _id: -1 }, limit, maxTimeMS: LIST_MAX_TIME_MS }).toArray()),
    findOne: (caller, access, filter) => bounded(() => sales(caller, access).findOne(filter, { projection: { ...PUBLIC_SALE_PROJECTION }, maxTimeMS: LIST_MAX_TIME_MS })),
  };
}
