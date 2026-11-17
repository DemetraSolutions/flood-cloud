import { ObjectId } from 'mongodb';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { DealerGroupsRepository } from '../../shared/security/scope/dealer-groups.repository.ts';
import { decodeErrorDocumentCursor, encodeErrorDocumentCursor } from './error-documents.cursor.ts';
import { toErrorDocument } from './error-documents.mapper.ts';
import type { ErrorDocumentView } from './error-documents.mapper.ts';
import type { ErrorDocumentsFilter, ErrorDocumentsRepository } from './error-documents.repository.ts';
import { ERROR_DOCUMENTS_DEFAULT_LIMIT } from './error-documents.schemas.ts';
import type { ErrorDocumentsCsvQuery, ErrorDocumentsQuery } from './error-documents.schemas.ts';

/** Most rows one CSV export holds; more is `413`. */
export const MAX_EXPORT_ROWS = 50_000;

/** Rows read and written at a time while the CSV is streamed. */
export const EXPORT_BATCH_ROWS = 500;

/** One page of rows. */
export interface ErrorDocumentsPage {
  readonly items: ErrorDocumentView[];
  readonly page: PageInfo;
}

/** An export that passed its checks: how many rows it has and the generator of its batches, which reads the database as it is consumed. */
export interface ErrorDocumentsExport {
  readonly total: number;
  batches(): AsyncGenerator<ErrorDocumentView[]>;
}

/** Business rules of the documents in error. */
export interface ErrorDocumentsService {
  /**
   * A page of the electronic documents in error of the groups in the caller's perimeter: the platform administrator reads every group (and may narrow to the groups of one dealer with
   * `dealerId`), a dealer only the groups whose `dealerId` is he (resolved by the server). A `groupId` outside the perimeter yields an empty page. Read only.
   *
   * @param principal The authenticated caller (the route already requires `errorDocuments:read`).
   * @param query Validated query.
   * @throws {AppError} `FORBIDDEN` when a dealer sends `dealerId`; `VALIDATION_ERROR` on `cursor`/`format` for a cursor this server did not issue; `SERVICE_UNAVAILABLE` on a read that exceeds its time limit.
   */
  list(principal: AuthPrincipal, query: ErrorDocumentsQuery): Promise<ErrorDocumentsPage>;
  /**
   * The CSV export: the same rows, in the same order, without pagination.
   *
   * @param principal The authenticated caller.
   * @param query Validated filters.
   * @throws {AppError} `FORBIDDEN` when a dealer sends `dealerId`; `PAYLOAD_TOO_LARGE` when the result has more than {@link MAX_EXPORT_ROWS} rows.
   */
  export(principal: AuthPrincipal, query: ErrorDocumentsCsvQuery): Promise<ErrorDocumentsExport>;
}

/** Dependencies of {@link createErrorDocumentsService}. */
export interface ErrorDocumentsDeps {
  readonly repository: ErrorDocumentsRepository;
  /** The groups of a dealer (for the filter `dealerId` of the platform administrator). */
  readonly dealerGroups: Pick<DealerGroupsRepository, 'listDealerGroupIds'>;
  /** Limits of the export (tests lower them). */
  readonly limits?: { readonly maxExportRows?: number; readonly batchRows?: number };
}

/** The filters both queries share. */
type Filters = Pick<ErrorDocumentsQuery, 'groupId' | 'dealerId' | 'documentType' | 'errorCode'>;

/**
 * Builds the service of the documents in error.
 *
 * @param deps Repository, dealer groups and limits.
 */
export function createErrorDocumentsService(deps: ErrorDocumentsDeps): ErrorDocumentsService {
  const { repository, dealerGroups } = deps;
  const maxExportRows = deps.limits?.maxExportRows ?? MAX_EXPORT_ROWS;
  const batchRows = deps.limits?.batchRows ?? EXPORT_BATCH_ROWS;

  /**
   * The perimeter of the caller, narrowed by the filters: `null` when nothing can match (the queue is not read at all). The `groupId` and the `dealerId` of the queue documents are never
   * the perimeter: the groups come from the authentication (a dealer) or from `common.groups` (the dealer filter of the platform administrator).
   */
  const resolve = async (principal: AuthPrincipal, filters: Filters): Promise<ErrorDocumentsFilter | null> => {
    const { scope } = principal;
    let groupIds: ObjectId[] | null;
    if (scope.kind === 'platform') {
      groupIds = filters.dealerId === undefined ? null : await dealerGroups.listDealerGroupIds(filters.dealerId);
    } else if (scope.kind === 'dealer') {
      if (filters.dealerId !== undefined) {
        throw new AppError('FORBIDDEN');
      }
      groupIds = [...scope.groupIds].map((hex) => ObjectId.createFromHexString(hex));
    } else {
      return null;
    }
    if (filters.groupId !== undefined) {
      const wanted = filters.groupId;
      groupIds = groupIds === null ? [wanted] : groupIds.filter((id) => id.equals(wanted));
    }
    if (groupIds !== null && groupIds.length === 0) {
      return null;
    }
    return {
      groupIds,
      ...(filters.documentType === undefined ? {} : { type: filters.documentType === 'invoice' ? ('invoice' as const) : ('credit-note' as const) }),
      ...(filters.errorCode === undefined ? {} : { errorCode: filters.errorCode }),
    };
  };

  /** A page of rows after a position: one more than asked is read, to know whether another page follows. */
  const read = async (filter: ErrorDocumentsFilter, after: ObjectId | null, limit: number): Promise<{ rows: ErrorDocumentView[]; last: ObjectId | null; more: boolean }> => {
    const documents = await repository.find(filter, after, limit + 1);
    const kept = documents.slice(0, limit);
    const groupIds = [...new Map(kept.filter((document) => document['groupId'] instanceof ObjectId).map((document) => [(document['groupId'] as ObjectId).toHexString(), document['groupId'] as ObjectId])).values()];
    const groupNames = groupIds.length === 0 ? new Map<string, string>() : await repository.groupNames(groupIds);
    const final = kept[kept.length - 1];
    return { rows: kept.map((document) => toErrorDocument(document, groupNames)), last: final === undefined ? null : (final['_id'] as ObjectId), more: documents.length > limit };
  };

  return {
    list: async (principal, query) => {
      const limit = query.limit ?? ERROR_DOCUMENTS_DEFAULT_LIMIT;
      const after = query.cursor === undefined ? null : decodeErrorDocumentCursor(query.cursor);
      const filter = await resolve(principal, query);
      if (filter === null) {
        return { items: [], page: { limit, next: null } };
      }
      const { rows, last, more } = await read(filter, after, limit);
      return { items: rows, page: { limit, next: more ? encodeErrorDocumentCursor(last!) : null } };
    },

    export: async (principal, query) => {
      const filter = await resolve(principal, query);
      if (filter === null) {
        return { total: 0, batches: async function* () {} };
      }
      const total = await repository.count(filter, maxExportRows);
      if (total > maxExportRows) {
        throw new AppError('PAYLOAD_TOO_LARGE', { message: `The export has more than ${String(maxExportRows)} rows: narrow the filters` });
      }
      return {
        total,
        batches: async function* () {
          // The count was made before: rows added since then must not make the file larger than the limit.
          let emitted = 0;
          let after: ObjectId | null = null;
          for (;;) {
            const { rows, last, more } = await read(filter, after, Math.min(batchRows, maxExportRows - emitted));
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
