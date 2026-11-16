import type { Document, Filter, ObjectId } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { DeviceAfter, DeviceRowsQuery, GroupSelection } from '../../shared/security/scope/mirror-devices.ts';
import { groupsScopeFilter, withScope } from '../../shared/security/scope/scope-filters.ts';
import type { StoreKeysRepository } from '../store-keys/store-keys.repository.ts';
import type { ActiveKeySummary } from '../store-keys/store-keys.types.ts';
import { decodeDeviceCursor, encodeDeviceCursor } from './diagnostics.cursor.ts';
import { toDeviceRow } from './diagnostics.mapper.ts';
import type { DeviceRowView } from './diagnostics.mapper.ts';
import type { DiagnosticsRepository } from './diagnostics.repository.ts';
import { DIAGNOSTICS_DEFAULT_LIMIT } from './diagnostics.schemas.ts';
import type { DevicesCsvQuery, DevicesQuery } from './diagnostics.schemas.ts';

/** Most rows one CSV export holds; more is `413`. */
export const MAX_EXPORT_ROWS = 50_000;

/** Rows read and written at a time while the CSV is streamed. */
export const EXPORT_BATCH_ROWS = 500;

/** One page of rows. */
export interface DevicesPage {
  readonly items: DeviceRowView[];
  readonly page: PageInfo;
}

/** An export that passed its checks: how many rows it has and the generator of its batches, which reads the database as it is consumed. */
export interface DevicesExport {
  readonly total: number;
  batches(): AsyncGenerator<DeviceRowView[]>;
}

/** Business rules of the diagnostics. */
export interface DiagnosticsService {
  /**
   * A page of the devices of the places in the caller's perimeter. The perimeter is the one of the role: the PSA reads every group (the demo ones left out, unless he names one), a dealer
   * his groups (same), the group administrator his group, a company administrator the places of his companies, a place administrator his places; the places in the trash and those of
   * a company in the trash are left out. A `groupId` outside the perimeter yields an empty page.
   *
   * @param principal The authenticated caller.
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor this server did not issue.
   */
  list(principal: AuthPrincipal, query: DevicesQuery): Promise<DevicesPage>;
  /**
   * The CSV export: the same rows, in the same order, without pagination.
   *
   * @param principal The authenticated caller.
   * @param query Validated filters.
   * @throws {AppError} `PAYLOAD_TOO_LARGE` when the result has more than {@link MAX_EXPORT_ROWS} rows.
   */
  export(principal: AuthPrincipal, query: DevicesCsvQuery): Promise<DevicesExport>;
}

/** Dependencies of {@link createDiagnosticsService}. */
export interface DiagnosticsDeps {
  readonly repository: DiagnosticsRepository;
  readonly storeKeys: Pick<StoreKeysRepository, 'summariesOfPlaces'>;
  /** Limits of the export (tests lower them). */
  readonly limits?: { readonly maxExportRows?: number; readonly batchRows?: number };
}

/** The filters both queries share. */
type Filters = Pick<DevicesQuery, 'groupId' | 'companyId' | 'placeId' | 'type' | 'q'>;

/** What a read resolved: the query for the copies. */
interface Resolved {
  readonly query: DeviceRowsQuery;
}

/**
 * Builds the diagnostics service.
 *
 * @param deps Repository, store keys and limits.
 */
export function createDiagnosticsService(deps: DiagnosticsDeps): DiagnosticsService {
  const { repository, storeKeys } = deps;
  const maxExportRows = deps.limits?.maxExportRows ?? MAX_EXPORT_ROWS;
  const batchRows = deps.limits?.batchRows ?? EXPORT_BATCH_ROWS;

  /**
   * The groups to read: those of the perimeter that are not in the trash. A platform or dealer view leaves the demo groups out (as the legacy), unless the request names the group;
   * a group administrator, a company administrator and a place administrator read their own group whatever it is. The PSA's view of every group is expressed as the groups to leave out
   * (the demo ones and the ones in the trash, few), never as the list of all of them.
   */
  const resolve = async (principal: AuthPrincipal, filters: Filters): Promise<Resolved | null> => {
    const { scope } = principal;
    let groups: GroupSelection;
    if (scope.kind === 'platform' && filters.groupId === undefined) {
      groups = { kind: 'exclude', ids: await repository.groupIds({ $or: [{ demo: true }, { trash: true }] }) };
    } else {
      const conditions: Filter<Document>[] = [{ trash: { $ne: true } }];
      if (filters.groupId !== undefined) {
        conditions.push({ _id: filters.groupId });
      } else if (scope.kind === 'dealer') {
        conditions.push({ demo: { $ne: true } });
      }
      const ids = await repository.groupIds(withScope(groupsScopeFilter(scope), { $and: conditions }));
      if (ids.length === 0) {
        return null;
      }
      groups = { kind: 'include', ids };
    }
    return {
      query: {
        groups,
        scope,
        companyId: filters.companyId,
        placeId: filters.placeId,
        type: filters.type,
        q: filters.q,
        trashedCompanyIds: await repository.trashedCompanies(groups, filters.companyId),
      },
    };
  };

  /** A page of rows after a position: one more than asked is read, to know whether another page follows. */
  const read = async (resolved: Resolved, after: DeviceAfter | null, limit: number): Promise<{ rows: DeviceRowView[]; last: DeviceAfter | null; more: boolean }> => {
    const documents = await repository.devices(resolved.query, after, limit + 1);
    const kept = documents.slice(0, limit);
    const unique = (field: string): ObjectId[] => [...new Map(kept.map((document) => [(document[field] as ObjectId).toHexString(), document[field] as ObjectId])).values()];
    const placeIds = unique('_id');
    const groupIds = unique('groupId');
    const groupNames = placeIds.length === 0 ? new Map<string, string>() : await repository.groupNames(groupIds);
    const summaries = placeIds.length === 0 ? [] : await storeKeys.summariesOfPlaces(groupIds, placeIds);
    const keys = new Map<string, ActiveKeySummary>(summaries.map((summary) => [summary.placeId.toHexString(), summary]));
    const rows = kept.map((document) => toDeviceRow(document, groupNames, keys));
    const final = kept[kept.length - 1];
    return {
      rows,
      last: final === undefined ? null : { placeId: final['_id'] as ObjectId, index: Number(final['index']) },
      more: documents.length > limit,
    };
  };

  return {
    list: async (principal, query) => {
      const limit = query.limit ?? DIAGNOSTICS_DEFAULT_LIMIT;
      const after = query.cursor === undefined ? null : decodeDeviceCursor(query.cursor);
      const resolved = await resolve(principal, query);
      if (resolved === null) {
        return { items: [], page: { limit, next: null } };
      }
      const { rows, last, more } = await read(resolved, after, limit);
      return { items: rows, page: { limit, next: more ? encodeDeviceCursor(last!) : null } };
    },

    export: async (principal, query) => {
      const resolved = await resolve(principal, query);
      if (resolved === null) {
        return { total: 0, batches: async function* () {} };
      }
      const total = await repository.countDevices(resolved.query, maxExportRows);
      if (total > maxExportRows) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: `The export has more than ${String(maxExportRows)} rows: narrow the filters` });
      }
      return {
        total,
        batches: async function* () {
          // The count was made before: rows added since then must not make the file larger than the limit.
          let emitted = 0;
          let after: DeviceAfter | null = null;
          for (;;) {
            const { rows, last, more } = await read(resolved, after, Math.min(batchRows, maxExportRows - emitted));
            emitted += rows.length;
            yield rows;
            if (!more || emitted >= maxExportRows) {
              return;
            }
            after = last;
          }
        },
      };
    },
  };
}
