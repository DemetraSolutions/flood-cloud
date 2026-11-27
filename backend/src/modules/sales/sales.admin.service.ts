import { ObjectId } from 'mongodb';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { GroupDirectoryRepository } from '../users/group-directory.repository.ts';
import { idOf } from './sales.mapper.ts';
import { salesPerimeter } from './sales.filters.ts';
import type { SalesRepository } from './sales.repository.ts';
import type { StoreSaleRefund, StoreSaleView } from './sales.store-view.ts';
import type { AdminCreateSaleBody, CancelSaleBody, CreateSaleBody, PatchSaleBody, RefundSaleBody } from './sales.write.schemas.ts';
import type { SaleCreated, SalesWriteContext, SalesWriteService } from './sales.write.service.ts';

/** Whether a sale that is not fiscal can be reached by the request (the `nonFiscal=include` signal of the UM mode of the backoffice). */
export type NonFiscalMode = 'exclude' | 'include';

/**
 * The writes of the sales from the backoffice (`doc/Tasks.md` step VS4b): the same rules and the same transaction as the writes of the point of sale (the {@link SalesWriteService}), with the differences of a user who corrects a record. The
 * operator of a sale is the authenticated user; the company and the point of sale of a new sale are verified in the group and in the perimeter of the user; a sale outside his perimeter (a company administrator reaches the sales of his
 * companies, a place administrator those of his places) is `404`, like the sale of another group, of another place of the group or the one that is not fiscal without `nonFiscal=include`. Unlike the till, the backoffice is refused
 * for a state that does not allow the write: `409 CONFLICT` for a sale that is canceled (refund, amendment), a refund beyond what was sold (`refundExceeds`), a customer or a card changed on a sale gathered in an invoice (`invoiced`) and the
 * deletion of a sale that is fiscal.
 */
export interface SalesAdminService {
  /**
   * Creates a sale (idempotent on the `timestampId`, which the server makes up when the body has none): the answer is the original sale, with `created: false`, when the key was already used.
   *
   * @throws {AppError} `VALIDATION_ERROR` (`placeId`/`incorrect`) when the point of sale does not exist in the group, is in the trash, is outside the perimeter of the user or is not of the company named: the same answer in every case; `CONFLICT`
   * (`timestampId`/`deleted`) when the key is the one of a quote that was deleted; `SERVICE_UNAVAILABLE` when the unique index of the key could not be created.
   */
  create(principal: AuthPrincipal, access: GroupAccess, body: AdminCreateSaleBody, client: ClientContext): Promise<{ readonly created: boolean; readonly result: SaleCreated }>;
  /** @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` (`fiscalState`/`canceled`, `status`/`invoiced`). */
  amend(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, body: PatchSaleBody, expected: string, nonFiscal: NonFiscalMode, client: ClientContext): Promise<StoreSaleView>;
  /** @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `VALIDATION_ERROR`, `CONFLICT` (`fiscalState`/`canceled`, `products`/`refundExceeds`, `refund`/`refundsLimit`). */
  refund(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, body: RefundSaleBody, expected: string, nonFiscal: NonFiscalMode, client: ClientContext): Promise<{ readonly created: boolean; readonly sale: StoreSaleView; readonly refund: StoreSaleRefund }>;
  /** @throws {AppError} `NOT_FOUND`, `PRECONDITION_FAILED`, `CONFLICT` (`refund`/`refundsLimit`). */
  cancel(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, body: CancelSaleBody, expected: string, nonFiscal: NonFiscalMode, client: ClientContext): Promise<{ readonly created: boolean; readonly sale: StoreSaleView }>;
  /**
   * Deletes for good a sale that is not fiscal, reversing everything it did to the warehouse and to the loyalty cards. The route asks for `nonFiscal=include`.
   *
   * @throws {AppError} `NOT_FOUND` (also a sale that is not fiscal when `nonFiscal` is not `include`), `PRECONDITION_FAILED`, `CONFLICT` (`nonFiscal`/`fiscal`, `status`/`invoiced`).
   */
  remove(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, expected: string, nonFiscal: NonFiscalMode, client: ClientContext): Promise<void>;
}

/** Collaborators of {@link createSalesAdminService}. */
export interface SalesAdminDeps {
  readonly writer: SalesWriteService;
  /** The reads of the sales: the sale of an operation is looked for inside the perimeter of the user. */
  readonly repository: Pick<SalesRepository, 'findOne'>;
  /** The places of the group (in the copies of the common database), inside the perimeter of the user. */
  readonly directory: Pick<GroupDirectoryRepository, 'findPlaces'>;
  readonly newId?: () => ObjectId;
}

/**
 * Builds the service of the writes of the sales from the backoffice.
 *
 * @param deps The service of the writes, the reads and the directory of the places.
 */
export function createSalesAdminService(deps: SalesAdminDeps): SalesAdminService {
  const { writer, repository, directory } = deps;
  const newId = deps.newId ?? (() => new ObjectId());

  const contextOf = (principal: AuthPrincipal, access: GroupAccess, companyId: ObjectId, placeId: ObjectId, request: ClientContext): SalesWriteContext => ({ caller: principal, access, companyId, placeId, request, store: null });

  /** The context of an operation on an existing sale: its company and point of sale, read from the sale inside the perimeter of the user (a sale outside it, of another group, the parent bill of a split table or one that is not fiscal without the signal is `404`). */
  const contextOfSale = async (principal: AuthPrincipal, access: GroupAccess, id: ObjectId, nonFiscal: NonFiscalMode, request: ClientContext): Promise<SalesWriteContext> => {
    const found = await repository.findOne(principal, access, { $and: [salesPerimeter(principal.scope), { _id: id, receiptType: { $ne: 'partitioned' } }, ...(nonFiscal === 'include' ? [] : [{ sType: { $in: [false, null] } }])] });
    const company = idOf(found?.['companyId']);
    const place = idOf(found?.['placeId']);
    if (company === null || place === null) {
      throw new AppError('NOT_FOUND');
    }
    return contextOf(principal, access, ObjectId.createFromHexString(company), ObjectId.createFromHexString(place), request);
  };

  return {
    create: async (principal, access, body, client) => {
      const { companyId, placeId, timestampId, ...rest } = body;
      const [place] = await directory.findPlaces(principal, access, [placeId]);
      // The same answer whether the point of sale does not exist, is of another group, is outside the perimeter or belongs to another company: no way to tell them apart.
      if (place === undefined || place.companyId === null || !place.companyId.equals(companyId)) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'placeId', issue: 'incorrect' }] });
      }
      const sale: CreateSaleBody = { ...rest, timestampId: timestampId ?? `bo-${newId().toHexString()}` };
      const { created, result } = await writer.create(contextOf(principal, access, companyId, placeId, client), sale);
      if ('status' in result) {
        throw new AppError('CONFLICT', { details: [{ field: 'timestampId', issue: 'deleted' }] });
      }
      return { created, result };
    },
    amend: async (principal, access, id, body, expected, nonFiscal, client) => writer.amend(await contextOfSale(principal, access, id, nonFiscal, client), id, body, expected),
    refund: async (principal, access, id, body, expected, nonFiscal, client) => writer.refund(await contextOfSale(principal, access, id, nonFiscal, client), id, body, expected),
    cancel: async (principal, access, id, body, expected, nonFiscal, client) => writer.cancel(await contextOfSale(principal, access, id, nonFiscal, client), id, body, expected),
    remove: async (principal, access, id, expected, nonFiscal, client) => writer.remove(await contextOfSale(principal, access, id, nonFiscal, client), id, expected),
  };
}
