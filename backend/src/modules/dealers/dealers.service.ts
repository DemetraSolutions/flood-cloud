import { MongoServerError, ObjectId } from 'mongodb';
import { isDeepStrictEqual } from 'node:util';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { PageInfo } from '../../shared/http/envelope.ts';
import { AppError } from '../../shared/http/errors.ts';
import { listParamsOf } from '../../shared/http/list.ts';
import { hasPermission } from '../../shared/security/rbac/policy.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { UsersRepository } from '../users/users.repository.ts';
import type { UsersService } from '../users/users.service.ts';
import { mergeCompany } from './dealer-rules.ts';
import { companyOf, toNewDocument, toResponse } from './dealer.mapper.ts';
import type { Dealer, DealerResponse, DealerUser } from './dealer.types.ts';
import { DEALERS_LIST } from './dealers.list.ts';
import type { DealersRepository } from './dealers.repository.ts';
import type { CreateDealerBody, DealersQuery, PatchDealerBody } from './dealers.schemas.ts';

/** A page of dealers in their response form. */
export interface DealerListing {
  readonly items: readonly DealerResponse[];
  readonly page: PageInfo;
}

/** The dealer registry (D-09): the company data of the dealers, whose `_id` is the id of their `D` user. */
export interface DealersService {
  /**
   * Lists the dealers, each with the user linked to it (read in one query for the whole page).
   *
   * @param query Validated query.
   * @throws {AppError} `VALIDATION_ERROR` on `cursor`/`format` for a cursor that does not fit the sort.
   */
  list(query: DealersQuery): Promise<DealerListing>;
  /**
   * Reads one dealer.
   *
   * @param dealerId Id of the dealer.
   * @throws {AppError} `NOT_FOUND`.
   */
  get(dealerId: ObjectId): Promise<DealerResponse>;
  /**
   * Creates a dealer and his `D` user (same `_id`) in one transaction, with the rules of the creation of platform users.
   *
   * @param principal The authenticated administrator (needs `users:create` as well as `dealers:create`).
   * @param body Validated body.
   * @param client Request context.
   * @throws {AppError} `FORBIDDEN` (no `users:create`), `VALIDATION_ERROR` (company or user), `CONFLICT` (user name or VAT number taken).
   */
  create(principal: AuthPrincipal, body: CreateDealerBody, client: ClientContext): Promise<DealerResponse>;
  /**
   * Modifies the company data of a dealer (JSON Merge Patch).
   *
   * @param principal The authenticated administrator.
   * @param dealerId Id of the dealer.
   * @param patch Validated, non-empty changes.
   * @param client Request context.
   * @throws {AppError} `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT` (VAT number taken).
   */
  update(principal: AuthPrincipal, dealerId: ObjectId, patch: PatchDealerBody, client: ClientContext): Promise<DealerResponse>;
}

/** Collaborators of {@link createDealersService}. */
export interface DealersServiceDeps {
  readonly dealers: DealersRepository;
  readonly users: Pick<UsersRepository, 'findSummaries'>;
  /** The user management: creating the dealer creates his user with the same rules. */
  readonly usersService: Pick<UsersService, 'create'>;
  readonly activityLog: ActivityLog;
  /** Clock in epoch milliseconds. */
  readonly now: () => number;
}

const vatTaken = (field: string): AppError => new AppError('CONFLICT', { details: [{ field, issue: 'taken' }] });

const isDuplicateKey = (error: unknown): boolean => error instanceof MongoServerError && error.code === 11000;

/**
 * Builds the dealer registry service.
 *
 * @param deps Repositories, user management, activity log and clock.
 */
export function createDealersService(deps: DealersServiceDeps): DealersService {
  const { dealers, users, usersService, activityLog } = deps;
  const date = (): Date => new Date(deps.now());

  const respond = async (found: readonly Dealer[]): Promise<DealerResponse[]> => {
    const summaries = await users.findSummaries(found.map((dealer) => dealer.id));
    return found.map((dealer) => {
      const summary = summaries.get(dealer.id.toHexString());
      return toResponse(dealer, summary === undefined ? null : { id: dealer.id.toHexString(), ...summary });
    });
  };

  const logChange = (principal: AuthPrincipal, client: ClientContext, id: ObjectId, action: 'dealer.created' | 'dealer.updated', before: Dealer | undefined, after: Dealer) =>
    recordDataChange(activityLog, {
      actor: actorOf(principal),
      resource: { type: 'dealer', id: id.toHexString() },
      action,
      before: before === undefined ? undefined : { ...companyOf(before) },
      after: { ...companyOf(after) },
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
    });

  return {
    list: async (query) => {
      const { dealers: found, page } = await dealers.list(listParamsOf(query, DEALERS_LIST));
      return { items: await respond(found), page };
    },

    get: async (dealerId) => {
      const dealer = await dealers.findById(dealerId);
      if (dealer === null) {
        throw new AppError('NOT_FOUND');
      }
      return (await respond([dealer]))[0]!;
    },

    create: async (principal, body, client) => {
      // Creating a dealer creates a user: both permissions are needed, whatever the route asked, and only a PSA does it.
      if (principal.role !== 'PSA' || !hasPermission(principal, 'dealers:create') || !hasPermission(principal, 'users:create')) {
        throw new AppError('FORBIDDEN');
      }
      const company = mergeCompany(null, body.company, 'company.');
      if (company.vatNumber !== null && (await dealers.isVatTaken(company.vatNumber))) {
        throw vatTaken('company.vatNumber');
      }
      const now = date();
      const created = await usersService.create(principal, { kind: 'platform' }, { ...body.user, role: 'D' }, client, async (session, userId) => {
        try {
          await dealers.insert(toNewDocument(userId, company, 'manual', principal.userId, now), session);
        } catch (error) {
          // Two creations with the same VAT number at once: the unique index decides.
          throw isDuplicateKey(error) ? vatTaken('company.vatNumber') : error;
        }
      });
      const user: DealerUser = { id: created.id, username: created.username, status: created.status };
      const dealer: Dealer = { id: ObjectId.createFromHexString(created.id), ...company, createdAt: now, updatedAt: now, createdBy: principal.userId, source: 'manual' };
      await logChange(principal, client, dealer.id, 'dealer.created', undefined, dealer);
      return toResponse(dealer, user);
    },

    update: async (principal, dealerId, patch, client) => {
      if (Object.keys(patch).length === 0) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: '(body)', issue: 'required' }] });
      }
      const before = await dealers.findById(dealerId);
      if (before === null) {
        throw new AppError('NOT_FOUND');
      }
      const company = mergeCompany(before, patch);
      if (isDeepStrictEqual(company, companyOf(before))) {
        return (await respond([before]))[0]!;
      }
      if (company.vatNumber !== null && company.vatNumber !== before.vatNumber && (await dealers.isVatTaken(company.vatNumber, dealerId))) {
        throw vatTaken('vatNumber');
      }
      const now = date();
      let found: boolean;
      try {
        found = await dealers.update(dealerId, company, now);
      } catch (error) {
        throw isDuplicateKey(error) ? vatTaken('vatNumber') : error;
      }
      if (!found) {
        throw new AppError('NOT_FOUND');
      }
      const after: Dealer = { ...before, ...company, updatedAt: now };
      await logChange(principal, client, dealerId, 'dealer.updated', before, after);
      return (await respond([after]))[0]!;
    },
  };
}
