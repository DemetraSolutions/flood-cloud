import { ObjectId } from 'mongodb';
import { actorOf } from '../../shared/activity-log/actor.ts';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { GroupAccess } from '../../shared/security/scope/group-access.ts';
import type { AuthPrincipal } from '../../shared/security/scope/principal.ts';
import type { TrashIssue, TrashItemOutcome } from '../../shared/trash/trash.ts';
import type { CompaniesService } from '../companies/companies.service.ts';
import type { GroupsService } from '../groups/groups.service.ts';
import type { PlacesService } from '../places/places.service.ts';
import type { UsersService } from '../users/users.service.ts';
import { EMPTY_BATCH_SIZE } from './trash.schemas.ts';
import type { TrashKind } from './trash.schemas.ts';

/** What became of one item of a bulk call. `issue` is present only when it was skipped. */
export type TrashResultItem =
  | { readonly id: string; readonly outcome: 'restored' | 'deleted' }
  | { readonly id: string; readonly outcome: 'skipped'; readonly issue: TrashIssue };

/** The answer of a bulk restore or deletion: one result per item, in the order of the request. */
export interface TrashResults {
  readonly results: readonly TrashResultItem[];
}

/** The answer of the emptying of a tab: the results of this call, how many items are still in the trash (all of them, whatever the cursor), and the cursor of the next call. */
export interface EmptyResults extends TrashResults {
  readonly remaining: number;
  /** The id to send as `after` in the next call: the last item processed, when the call was full and there may be more beyond it; `null` when the walk is over. */
  readonly next: string | null;
}

/** The bulk operations of the trash page. Every item goes through the same service function as its single-item route, so nothing here repeats a rule of a domain. */
export interface TrashService {
  /**
   * Restores items of a kind: each one as the single-item restore does (scope, anti-escalation, `409` checks, side effects, events); one that cannot be restored is skipped, never
   * aborts the others. Records one `trash.bulkRestored` entry.
   *
   * @param principal The caller (already checked for `<kind>:trash`).
   * @param access Verified access to the group.
   * @param kind The kind of the items.
   * @param ids The ids (1 to 100, without duplicates).
   * @param client Request context for the activity log.
   */
  restore(principal: AuthPrincipal, access: GroupAccess, kind: TrashKind, ids: readonly ObjectId[], client: ClientContext): Promise<TrashResults>;
  /**
   * Deletes items of a kind from the trash for good, each as the single-item deletion does. Records one `trash.bulkDeleted` entry.
   *
   * @param principal The caller (already checked for `<kind>:delete`).
   * @param access Verified access to the group.
   * @param kind The kind of the items.
   * @param ids The ids (1 to 100, without duplicates).
   * @param client Request context for the activity log.
   */
  remove(principal: AuthPrincipal, access: GroupAccess, kind: TrashKind, ids: readonly ObjectId[], client: ClientContext): Promise<TrashResults>;
  /**
   * Deletes the items of a kind in the trash of the group that come after a cursor (at most {@link EMPTY_BATCH_SIZE}, in `_id` order), each as the single-item deletion does, and tells how
   * many are left and where to go on: items that cannot be deleted are walked past, never met again by the next call. Records one `trash.emptied` entry. The caller is a PSA (`trash:empty`).
   *
   * @param principal The caller (already checked for `trash:empty` and `<kind>:delete`).
   * @param access Verified access to the group.
   * @param kind The kind of the items.
   * @param after Only the items with an id greater than this one; `null` for the first call.
   * @param client Request context for the activity log.
   */
  empty(principal: AuthPrincipal, access: GroupAccess, kind: TrashKind, after: ObjectId | null, client: ClientContext): Promise<EmptyResults>;
  /**
   * Restores groups from the trash, platform-wide (a PSA). A group that does not exist is `notFound`. Groups are never deleted for good. Records one `trash.bulkRestored` entry.
   *
   * @param principal The caller (already checked for `groups:trash`).
   * @param ids The ids (1 to 100, duplicates allowed: they are removed).
   * @param accesses The verified access of each id (verified by the route), `null` for a group the caller cannot reach.
   * @param client Request context for the activity log.
   */
  restoreGroups(principal: AuthPrincipal, ids: readonly ObjectId[], accesses: ReadonlyMap<string, GroupAccess | null>, client: ClientContext): Promise<TrashResults>;
}

/** Collaborators of {@link createTrashService}. */
export interface TrashServiceDeps {
  readonly companies: Pick<CompaniesService, 'restoreFromTrash' | 'deleteFromTrash' | 'trashedIds' | 'countTrashed'>;
  readonly places: Pick<PlacesService, 'restoreFromTrash' | 'deleteFromTrash' | 'trashedIds' | 'countTrashed'>;
  readonly users: Pick<UsersService, 'restoreFromTrash' | 'deleteFromTrash' | 'trashedIds' | 'countTrashed'>;
  readonly groups: Pick<GroupsService, 'restoreFromTrash'>;
  readonly activityLog: ActivityLog;
}

/** What the trash page does with the items of one kind, through the domain service that owns them. */
interface Domain {
  restore(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  remove(principal: AuthPrincipal, access: GroupAccess, id: ObjectId, client: ClientContext): Promise<TrashItemOutcome>;
  ids(principal: AuthPrincipal, access: GroupAccess, limit: number, after: ObjectId | null): Promise<ObjectId[]>;
  count(principal: AuthPrincipal, access: GroupAccess): Promise<number>;
}

/** The ids without the repeated ones, in order of appearance. */
function distinct(ids: readonly ObjectId[]): ObjectId[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const hex = id.toHexString();
    return seen.has(hex) ? false : (seen.add(hex), true);
  });
}

/**
 * Builds the service of the bulk operations of the trash. It owns no rule of the domains: for each item it calls the `restoreFromTrash` or `deleteFromTrash` of the domain service, which
 * is the single-item operation with its refusals as an issue, and it adds only the order of the results, the cap of the emptying and the activity entry of the call.
 *
 * @param deps The domain services, the group resolver and the activity log.
 */
export function createTrashService(deps: TrashServiceDeps): TrashService {
  const { companies, places, users, groups, activityLog } = deps;
  const domains: Readonly<Record<TrashKind, Domain>> = {
    companies: {
      restore: (principal, access, id, client) => companies.restoreFromTrash(principal, access, id, client),
      remove: (principal, access, id, client) => companies.deleteFromTrash(principal, access, id, client),
      ids: (principal, access, limit, after) => companies.trashedIds(principal, access, limit, after),
      count: (principal, access) => companies.countTrashed(principal, access),
    },
    places: {
      restore: (principal, access, id, client) => places.restoreFromTrash(principal, access, id, client),
      remove: (principal, access, id, client) => places.deleteFromTrash(principal, access, id, client),
      ids: (principal, access, limit, after) => places.trashedIds(principal, access, limit, after),
      count: (principal, access) => places.countTrashed(principal, access),
    },
    users: {
      restore: (principal, access, id, client) => users.restoreFromTrash(principal, { kind: 'group', access }, id, client),
      remove: (principal, access, id, client) => users.deleteFromTrash(principal, { kind: 'group', access }, id, client),
      ids: (principal, access, limit, after) => users.trashedIds(principal, access, limit, after),
      count: (principal, access) => users.countTrashed(principal, access),
    },
  };

  /** Runs the items one after the other (a bulk call is bounded, and the writes of a group are not to be hammered): each result keeps its place and goes in `results` as soon as it is known. */
  const process = async (ids: readonly ObjectId[], done: 'restored' | 'deleted', run: (id: ObjectId) => Promise<TrashItemOutcome>, results: TrashResultItem[]): Promise<void> => {
    for (const id of ids) {
      const outcome = await run(id);
      results.push(outcome.done ? { id: id.toHexString(), outcome: done } : { id: id.toHexString(), outcome: 'skipped', issue: outcome.issue });
    }
  };

  /**
   * Runs a bulk call and records its one entry whatever happens: kind, how many items were asked for and how many ended each way (never an id). If the call fails half-way (a fault, not a
   * refusal of an item) the entry has the outcome `failure` and the counts so far, and the error goes on; the entries of the items already done are there too.
   */
  const recorded = async <T>(
    principal: AuthPrincipal,
    access: GroupAccess | null,
    client: ClientContext,
    action: 'trash.bulkRestored' | 'trash.bulkDeleted' | 'trash.emptied',
    kind: string,
    requested: () => number,
    work: (results: TrashResultItem[]) => Promise<T>,
  ): Promise<T> => {
    const results: TrashResultItem[] = [];
    let succeeded = false;
    try {
      const answer = await work(results);
      succeeded = true;
      return answer;
    } finally {
      const count = (outcome: TrashResultItem['outcome']): number => results.filter((item) => item.outcome === outcome).length;
      await activityLog.record({
        category: 'data',
        action,
        outcome: succeeded ? 'success' : 'failure',
        actor: actorOf(principal),
        ...(access === null ? {} : { groupId: access.groupId }),
        resource: { type: 'trash', id: kind },
        requestId: client.requestId,
        ...(client.ip === null ? {} : { ip: client.ip }),
        metadata: { kind, requested: requested(), ...(action === 'trash.bulkRestored' ? { restored: count('restored') } : { deleted: count('deleted') }), skipped: count('skipped') },
      });
    }
  };

  return {
    restore: async (principal, access, kind, ids, client) => {
      const wanted = distinct(ids);
      return recorded(principal, access, client, 'trash.bulkRestored', kind, () => wanted.length, async (results) => {
        await process(wanted, 'restored', (id) => domains[kind].restore(principal, access, id, client), results);
        return { results };
      });
    },

    remove: async (principal, access, kind, ids, client) => {
      const wanted = distinct(ids);
      return recorded(principal, access, client, 'trash.bulkDeleted', kind, () => wanted.length, async (results) => {
        await process(wanted, 'deleted', (id) => domains[kind].remove(principal, access, id, client), results);
        return { results };
      });
    },

    empty: async (principal, access, kind, after, client) => {
      let asked = 0;
      return recorded(principal, access, client, 'trash.emptied', kind, () => asked, async (results) => {
        const ids = await domains[kind].ids(principal, access, EMPTY_BATCH_SIZE, after);
        asked = ids.length;
        await process(ids, 'deleted', (id) => domains[kind].remove(principal, access, id, client), results);
        return { results, remaining: await domains[kind].count(principal, access), next: ids.length === EMPTY_BATCH_SIZE ? ids[ids.length - 1]!.toHexString() : null };
      });
    },

    restoreGroups: async (principal, ids, accesses, client) => {
      const wanted = distinct(ids);
      return recorded(principal, null, client, 'trash.bulkRestored', 'groups', () => wanted.length, async (results) => {
        await process(
          wanted,
          'restored',
          async (id) => {
            const access = accesses.get(id.toHexString()) ?? null;
            return access === null ? { done: false, issue: 'notFound' } : groups.restoreFromTrash(principal, access, client);
          },
          results,
        );
        return { results };
      });
    },
  };
}
