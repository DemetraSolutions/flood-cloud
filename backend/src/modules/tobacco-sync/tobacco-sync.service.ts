import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { inGroupTransaction, sessionDatabases } from '../../db/session-databases.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import { recordDataChange } from '../../shared/activity-log/data-change.ts';
import { createCatalogLock } from '../../shared/locks/catalog-lock.ts';
import type { CatalogLock, CatalogLockHandle } from '../../shared/locks/catalog-lock.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { ErrorDetail } from '../../shared/http/errors.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { CatalogsService } from '../groups/catalogs/catalogs.service.ts';
import { newElementId } from '../groups/catalogs/kit.ts';
import { priceLists } from '../groups/catalogs/price-lists.ts';
import type { PriceList } from '../groups/catalogs/price-lists.ts';
import { taxes } from '../groups/catalogs/taxes.ts';
import type { Tax } from '../groups/catalogs/taxes.ts';
import { actorOfCaller } from '../product-catalog/caller.ts';
import type { CatalogCaller } from '../product-catalog/caller.ts';
import { planSync } from './tobacco-sync.plan.ts';
import type { SyncCounts, SyncPlan } from './tobacco-sync.plan.ts';
import { createTobaccoSyncGroupStore, createTobaccoSyncReads } from './tobacco-sync.repository.ts';
import type { TobaccoSyncGroupStore } from './tobacco-sync.repository.ts';
import type { SyncPlace, SyncReadLimits } from './tobacco-sync.repository.ts';
import { MAX_SYNC_PLACES } from './tobacco-sync.schemas.ts';
import type { SyncBody } from './tobacco-sync.schemas.ts';

/** Longest a synchronization may run inside its transaction, in milliseconds: well below the lifetime MongoDB gives a transaction (60 seconds). */
export const MAX_SYNC_MS = 15_000;

/** The message of the `413` of an operation that takes too long. */
const SLOW_MESSAGE = 'The synchronization takes too long';

/** Why the synchronization cannot start in a group. */
export const UNAVAILABLE_REASONS = Object.freeze(['featureDisabled', 'noTobaccoPlace', 'noZeroTaxRate', 'noPriceList', 'emptyList'] as const);

/** A reason the synchronization cannot start. */
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** The state of the synchronization in a group. */
export interface SyncStatus {
  /** Whether a synchronization can start now. */
  readonly available: boolean;
  /** Why not, empty when it can. */
  readonly reasons: readonly UnavailableReason[];
  /** The group may move the products in the warehouse (the `warehouse` option is accepted). */
  readonly warehouseAllowed: boolean;
  /** The points of sale of the group with the tobaccos on (at most {@link MAX_SYNC_PLACES}). */
  readonly tobaccoPlaces: readonly SyncPlace[];
  /** The national price list: how many products it has and when it was imported (`null` when it is empty). */
  readonly list: { readonly entries: number; readonly importedAt: string | null };
  /** The newest synchronization of the group that wrote (from the activity log, which keeps its entries for a limited time), `null` when there is none. */
  readonly lastSync: { readonly at: string; readonly counts: Readonly<Record<string, string | number | boolean | null>> } | null;
}

/** What a synchronization answers with. */
export interface SyncOutcome extends SyncCounts {
  /** `true` when nothing was written: the counts are what would be. */
  readonly dryRun: boolean;
}

/** The synchronization of the national tobacco price list into the products of a group. */
export interface TobaccoSyncService {
  /**
   * Whether the synchronization can start in the group, why not, and what it will read and what it last did.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   */
  status(principal: CatalogCaller, access: GroupAccess): Promise<SyncStatus>;
  /**
   * Synchronizes the price list into the group, all or nothing, in one transaction. See {@link planSync} for the rules.
   *
   * @param principal The authenticated caller.
   * @param access Verified access to the group.
   * @param body The parameters.
   * @param dryRun Compute and count, write nothing.
   * @param client Request context, for the activity log.
   * @throws {AppError} `FEATURE_DISABLED` (the group lacks the tobaccos function), `VALIDATION_ERROR` (`warehouse` without the function, a point of sale that does not exist), `CONFLICT` (already running, or
   *   the group lacks a point of sale with the tobaccos, a tax rate of 0 %, a price list, or the price list is empty), `PAYLOAD_TOO_LARGE` (too big, or too slow).
   */
  sync(principal: CatalogCaller, access: GroupAccess, body: SyncBody, dryRun: boolean, client: ClientContext): Promise<SyncOutcome>;
}

/** The collaborators of {@link createTobaccoSyncService}. */
export interface TobaccoSyncDeps {
  readonly databases: Databases;
  readonly catalogs: Pick<CatalogsService, 'list'>;
  readonly activityLog: ActivityLog;
  readonly now: () => number;
  readonly logger: Logger;
  /** The lock of the catalog of a group (tests replace it); by default the one shared with the import of the workbook, in `common.settings`. */
  readonly lock?: CatalogLock;
  readonly newId?: () => ObjectId;
  /** Limits (tests lower them). */
  readonly limits?: SyncReadLimits & { readonly maxSyncMs?: number };
}

/** The refusal of a synchronization that would disable more than 20 % (`MASS_DISABLE_PERCENT`) of the enabled tobaccos of the group without `confirmMassDisable`: nothing was written. The controller answers `409` with the numbers. */
export class MassDisableRefusal extends Error {
  /** How many tobaccos the synchronization would disable. */
  readonly disabled: number;
  /** How many tobaccos the group has enabled. */
  readonly active: number;

  /**
   * @param disabled How many it would disable.
   * @param active How many are enabled.
   */
  constructor(disabled: number, active: number) {
    super('The synchronization would disable many tobaccos');
    this.name = 'MassDisableRefusal';
    this.disabled = disabled;
    this.active = active;
  }
}

/** The closed reason a failure inside the operation is recorded with. */
function reasonOf(error: unknown): string {
  if (error instanceof MassDisableRefusal) {
    return 'massDisable';
  }
  if (error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE') {
    return error.message === SLOW_MESSAGE ? 'tooSlow' : 'tooLarge';
  }
  return 'error';
}

/**
 * The tax rate of 0 % the prices carry: the one with a VAT nature when there is one (a rate of 0 % without a nature would not be accepted on an invoice), else the first.
 *
 * @param list The tax rates of the group.
 * @returns The rate, `undefined` when the group has none of 0 %.
 */
export function zeroTaxOf(list: readonly Tax[]): Tax | undefined {
  const zero = list.filter((tax) => tax.rate === 0);
  return zero.find((tax) => tax.vatNature !== null) ?? zero[0];
}

/**
 * Builds the synchronization service.
 *
 * @param deps The collaborators.
 */
export function createTobaccoSyncService(deps: TobaccoSyncDeps): TobaccoSyncService {
  const { databases, activityLog, now } = deps;
  const maxSyncMs = deps.limits?.maxSyncMs ?? MAX_SYNC_MS;
  const newId = deps.newId ?? (() => new ObjectId());
  const reads = createTobaccoSyncReads(databases, deps.limits);
  const lock = deps.lock ?? createCatalogLock({ databases, logger: deps.logger });

  const groupState = async (principal: CatalogCaller, access: GroupAccess) => {
    const [tobaccoPlaces, taxList, lists] = await Promise.all([reads.tobaccoPlaces(principal, access, MAX_SYNC_PLACES), deps.catalogs.list(taxes, access) as Promise<Tax[]>, deps.catalogs.list(priceLists, access) as Promise<PriceList[]>]);
    return { tobaccoPlaces, tax: zeroTaxOf(taxList), lists };
  };

  return {
    status: async (principal, access) => {
      const [state, list, last] = await Promise.all([groupState(principal, access), reads.listStats(), reads.lastSync(access.groupId)]);
      const reasons: UnavailableReason[] = [
        ...(access.features.tobaccosGamesMonopoly ? [] : (['featureDisabled'] as const)),
        ...(state.tobaccoPlaces.length === 0 ? (['noTobaccoPlace'] as const) : []),
        ...(state.tax === undefined ? (['noZeroTaxRate'] as const) : []),
        ...(state.lists.length === 0 ? (['noPriceList'] as const) : []),
        ...(list.entries === 0 ? (['emptyList'] as const) : []),
      ];
      return {
        available: reasons.length === 0,
        reasons,
        warehouseAllowed: access.features.warehouse,
        tobaccoPlaces: state.tobaccoPlaces,
        list: { entries: list.entries, importedAt: list.importedAt === null ? null : list.importedAt.toISOString() },
        lastSync: last === null ? null : { at: last.at.toISOString(), counts: last.metadata as Record<string, string | number | boolean | null> },
      };
    },

    sync: async (principal, access, body, dryRun, client) => {
      const group = access.groupId.toHexString();
      const confirmed = body.confirmMassDisable ?? false;
      const params = { warehouse: body.warehouse ?? false, noDiscount: body.noDiscount ?? false, placeIds: [...new Map((body.placeIds ?? []).map((id) => [id.toHexString(), id])).values()] };
      const summary = (outcome: 'success' | 'failure', metadata: Record<string, string | number | boolean>): Promise<void> =>
        activityLog.record({
          category: 'data',
          action: 'tobaccos.synced',
          outcome,
          actor: actorOfCaller(principal),
          groupId: access.groupId,
          resource: { type: 'tobaccos' },
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
          metadata: { dryRun, warehouse: params.warehouse, noDiscount: params.noDiscount, confirmMassDisable: confirmed, places: params.placeIds.length, ...metadata },
        });
      /** The failures already written to the log: the outer `catch` writes the ones that are not (`reason: 'error'`). */
      const recorded = new WeakSet<object>();
      const refuse = async (reason: string, error: Error): Promise<never> => {
        recorded.add(error);
        await summary('failure', { reason });
        throw error;
      };
      const conflict = (reason: UnavailableReason, message: string): Promise<never> => refuse(reason, new AppError('CONFLICT', { message, details: [{ field: 'group', issue: reason }] }));

      let held: CatalogLockHandle | null = null;
      const attempt = async (): Promise<SyncOutcome> => {
        try {
          if (!access.features.tobaccosGamesMonopoly) {
            return await refuse('featureDisabled', new AppError('FEATURE_DISABLED'));
          }
          if (params.warehouse && !access.features.warehouse) {
            return await refuse('warehouse', new AppError('VALIDATION_ERROR', { details: [{ field: 'warehouse', issue: 'notAllowed' }] }));
          }
          // One operation at a time on the catalog of a group, on every server: the lock is taken before anything is read for the plan and before the transaction, by a dry run too.
          const at = new Date(now());
          held = await lock.acquire(access.groupId);
          if (held === null) {
            return await refuse('busy', new AppError('CONFLICT', { message: 'An import or a synchronization of this group is already running', details: [{ field: 'group', issue: 'busy' }] }));
          }
          const deadline = now() + maxSyncMs;
          /** The time left to the operation, as a time limit for one read; it throws (`413`) when none is left. */
          const timeLeft = (): number => {
            const left = deadline - now();
            if (left <= 0) {
              throw new AppError('PAYLOAD_TOO_LARGE', { message: SLOW_MESSAGE });
            }
            return Math.max(1, Math.floor(left));
          };
          const tooSlow = (): void => void timeLeft();
          const state = await groupState(principal, access);
          if (state.tobaccoPlaces.length === 0) {
            return await conflict('noTobaccoPlace', 'The group has no point of sale with the tobaccos on');
          }
          if (state.tax === undefined) {
            return await conflict('noZeroTaxRate', 'The group needs a tax rate of 0% in its tax rates');
          }
          if (state.lists.length === 0) {
            return await conflict('noPriceList', 'The group has no price list');
          }
          if (params.placeIds.length > 0) {
            const found = await reads.existingPlaces(principal, access, params.placeIds);
            const wrong: ErrorDetail[] = params.placeIds.flatMap((id, index) => (found.get(id.toHexString()) === true ? [] : [{ field: `placeIds.${String(index)}`, issue: found.has(id.toHexString()) ? 'notTobaccoPlace' : 'notFound' }]));
            if (wrong.length > 0) {
              return await refuse('places', new AppError('VALIDATION_ERROR', { details: wrong }));
            }
          }
          const list = await reads.readList(timeLeft());
          if (list === null) {
            return await refuse('tooLarge', new AppError('PAYLOAD_TOO_LARGE', { message: 'The national price list is too big to be synchronized' }));
          }
          if (list.length === 0) {
            return await conflict('emptyList', 'The national price list is empty: nothing is synchronized');
          }
          await held.renew();
          const tax = state.tax;
          const priceListIds = state.lists.map((item) => item.id);
          const planOver = async (store: TobaccoSyncGroupStore): Promise<SyncPlan> => {
            // One read after the other: a transaction runs one operation at a time.
            const products = await store.tgmProducts(principal, access, timeLeft());
            const categories = await store.categories(principal, access, timeLeft());
            return planSync({ principal, list, products, categories, priceListIds, tax, params, now: at, newId, newElementId });
          };

          let done: SyncPlan;
          try {
            if (dryRun) {
              // Nothing is written, so no transaction: the plan is the answer.
              done = await planOver(createTobaccoSyncGroupStore(databases, deps.limits));
            } else {
              done = await inGroupTransaction(principal, access, databases, async (session) => {
                const store = createTobaccoSyncGroupStore(sessionDatabases(databases, session, access.groupId), deps.limits);
                const plan = await planOver(store);
                if (plan.counts.massDisable.exceeded && !confirmed) {
                  throw new MassDisableRefusal(plan.counts.products.disabled, plan.counts.massDisable.active);
                }
                await store.writeCategories(principal, access, plan.categoryOps, tooSlow);
                await store.writeProducts(principal, access, plan.productOps, tooSlow);
                tooSlow();
                return plan;
              });
            }
          } catch (error) {
            recorded.add(error as object);
            await summary('failure', { reason: reasonOf(error), ...(error instanceof MassDisableRefusal ? { disabled: error.disabled, active: error.active } : {}) });
            throw error;
          }
          if (!dryRun) {
            // After the commit: the entries of the products and the categories, then the summary. The log never rejects: a failed write goes to its logger.
            for (const draft of done.drafts) {
              await recordDataChange(activityLog, {
                actor: actorOfCaller(principal),
                groupId: access.groupId,
                resource: { type: draft.resource, id: draft.id.toHexString() },
                action: draft.action,
                before: draft.before,
                after: draft.after,
                requestId: client.requestId,
                ...(client.ip === null ? {} : { ip: client.ip }),
              });
            }
          }
          const { products, categories } = done.counts;
          await summary('success', {
            inserted: products.inserted,
            updated: products.updated,
            disabled: products.disabled,
            reactivated: products.reactivated,
            unchanged: products.unchanged,
            skipped: products.skipped,
            categoriesInserted: categories.inserted,
            duplicateCodes: done.counts.duplicateCodes,
            duplicateCategoryNames: categories.duplicateNames,
            massDisableExceeded: done.counts.massDisable.exceeded,
            entries: dryRun ? 0 : done.drafts.length,
            entriesOmitted: dryRun ? 0 : done.omitted,
          });
          return { dryRun, ...done.counts };
        } catch (error) {
          if (!recorded.has(error as object)) {
            await summary('failure', { reason: reasonOf(error) });
          }
          throw error;
        }
      };
      // The lock is given back whatever happens.
      return attempt().finally(() => (held === null ? undefined : held.release()));
    },
  };
}

