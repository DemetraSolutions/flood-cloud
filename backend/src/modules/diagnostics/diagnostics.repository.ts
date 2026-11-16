import type { Document, Filter, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import { countMirrorDevices, readMirrorDevices, trashedCompanyIds } from '../../shared/security/scope/group-mirror.ts';
import type { DeviceAfter, DeviceRowsQuery, GroupSelection } from '../../shared/security/scope/mirror-devices.ts';

/** Most groups one read of the diagnostics covers (the groups of a platform, at most); more is an error, because the read would be incomplete. */
export const MAX_DIAGNOSTIC_GROUPS = 20_000;

/** Most companies in the trash one read of the diagnostics excludes. */
export const MAX_TRASHED_COMPANIES = 20_000;

/** Limits of the repository; the defaults are the constants above. */
export interface DiagnosticsLimits {
  readonly maxGroups?: number;
  readonly maxTrashedCompanies?: number;
}

/** The reads of the diagnostics: the groups of a perimeter and the device rows of the copies of the places. */
export interface DiagnosticsRepository {
  /**
   * The ids of the groups that match a filter (already combined with the perimeter of the caller).
   *
   * @param filter The perimeter and the conditions on the groups.
   * @returns The ids.
   * @throws {Error} If there are {@link MAX_DIAGNOSTIC_GROUPS} of them or more.
   */
  groupIds(filter: Filter<Document>): Promise<ObjectId[]>;
  /**
   * The names of some groups, those of one page of rows.
   *
   * @param ids The groups, at most a page of rows.
   * @returns The names by hexadecimal id (a name that is not a text is `''`).
   */
  groupNames(ids: readonly ObjectId[]): Promise<Map<string, string>>;
  /**
   * The ids of the companies in the trash of the groups of a read, or just whether `companyId` is one of them.
   *
   * @param groups The groups.
   * @param companyId The company the read is narrowed to, if any.
   */
  trashedCompanies(groups: GroupSelection, companyId: ObjectId | undefined): Promise<ObjectId[]>;
  /**
   * A page of device rows.
   *
   * @param query The perimeter and the filters.
   * @param after Where to continue from, `null` for the first page.
   * @param limit How many rows to read.
   */
  devices(query: DeviceRowsQuery, after: DeviceAfter | null, limit: number): Promise<Document[]>;
  /**
   * How many device rows a query has, counted up to `cap + 1`.
   *
   * @param query The perimeter and the filters.
   * @param cap The largest count that matters.
   */
  countDevices(query: DeviceRowsQuery, cap: number): Promise<number>;
}

/**
 * Builds the repository of the diagnostics. The device rows are read from the copies of the places in the common database, through `group-mirror.ts`; the group databases are never read.
 *
 * @param databases Database accessor.
 * @param limits Overrides of the limits (tests).
 */
export function createDiagnosticsRepository(databases: Databases, limits: DiagnosticsLimits = {}): DiagnosticsRepository {
  const maxGroups = limits.maxGroups ?? MAX_DIAGNOSTIC_GROUPS;
  const maxTrashed = limits.maxTrashedCompanies ?? MAX_TRASHED_COMPANIES;
  return {
    groupIds: async (filter) => {
      const found = await databases.common().collection('groups').find(filter, { projection: { _id: 1 }, limit: maxGroups, maxTimeMS: LIST_MAX_TIME_MS }).toArray();
      if (found.length >= maxGroups) {
        throw new Error('Too many groups for one read of the diagnostics');
      }
      return found.map((group) => group['_id'] as ObjectId);
    },
    groupNames: async (ids) => {
      const found = await databases.common().collection('groups').find({ _id: { $in: [...ids] } }, { projection: { name: 1 }, limit: ids.length, maxTimeMS: LIST_MAX_TIME_MS }).toArray();
      return new Map(found.map((group) => [(group['_id'] as ObjectId).toHexString(), typeof group['name'] === 'string' ? group['name'] : '']));
    },
    trashedCompanies: (groups, companyId) => trashedCompanyIds(databases, groups, companyId, maxTrashed),
    devices: (query, after, limit) => readMirrorDevices(databases, query, after, limit),
    countDevices: (query, cap) => countMirrorDevices(databases, query, cap),
  };
}
