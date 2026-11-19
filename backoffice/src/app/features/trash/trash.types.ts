import { ApiError } from '../../core/api/api-error';
import { CompanyListItem } from '../companies/company.types';
import { GroupListItem } from '../groups/group.types';
import { PlaceListItem, placeRoute } from '../places/place.types';
import { userRoute, UserRecord } from '../users/user.types';

/** The tabs of the trash page, in order. */
export const TRASH_KINDS = ['companies', 'places', 'users', 'groups'] as const;

/** A kind of item the trash holds. */
export type TrashKind = (typeof TRASH_KINDS)[number];

/** The kinds of the group (their trash is bulk-managed under `/v1/groups/{groupId}/trash/{kind}`). */
export type GroupTrashKind = Exclude<TrashKind, 'groups'>;

/** Permission that shows the tab of a kind. */
export const READ_PERMISSION: Readonly<Record<TrashKind, string>> = {
  companies: 'companies:read',
  places: 'places:read',
  users: 'users:read',
  groups: 'groups:trash',
};

/** Permission to restore the items of a kind (the same as the `trash` action of its list). */
export const RESTORE_PERMISSION: Readonly<Record<TrashKind, string>> = {
  companies: 'companies:trash',
  places: 'places:trash',
  users: 'users:trash',
  groups: 'groups:trash',
};

/** Permission to delete the items of a group kind for good (groups are never deleted). */
export const DELETE_PERMISSION: Readonly<Record<GroupTrashKind, string>> = {
  companies: 'companies:delete',
  places: 'places:delete',
  users: 'users:delete',
};

/** Permission to empty the trash of a kind (platform administrators only). */
export const EMPTY_PERMISSION = 'trash:empty';

/** Most ids one bulk call takes (the pages of the lists never exceed it). */
export const MAX_BULK_IDS = 100;

/** What happened to an item of a bulk call. */
export type TrashOutcome = 'restored' | 'deleted' | 'skipped';

/** Why an item was skipped. */
export type TrashIssue =
  'notFound' | 'notTrashed' | 'referenced' | 'taken' | 'forbidden' | 'hasGroups';

/** The issues, in the order the summary lists them. */
export const TRASH_ISSUES: readonly TrashIssue[] = [
  'referenced',
  'taken',
  'forbidden',
  'hasGroups',
  'notTrashed',
  'notFound',
];

/** Result of one item of a bulk call (`issue` only when it was skipped). */
export interface TrashItemResult {
  readonly id: string;
  readonly outcome: TrashOutcome;
  readonly issue?: TrashIssue;
}

/** Response of `restore` and `delete`: one result per requested id, in the order of the request. */
export interface TrashResponse {
  readonly results: readonly TrashItemResult[];
}

/** Response of `empty`: the results of the call and how many items are still in the trash. */
export interface TrashEmptyResponse extends TrashResponse {
  readonly remaining: number;
  /** Id to send as `after` in the next call; `null` when the kind was walked to the end. */
  readonly next: string | null;
}

/** What a trashed item adds to its list representation: when it was trashed (`null` when unknown). */
export interface Trashed {
  readonly trashedAt: string | null;
}

/** A trashed company, place, user or group as the lists return it with `trashed=true`. */
export type TrashedCompany = CompanyListItem & Trashed;
export type TrashedPlace = PlaceListItem & Trashed;
export type TrashedUser = UserRecord & Trashed;
export type TrashedGroup = GroupListItem & Trashed;

/** A row of any tab. */
export type TrashRow = TrashedCompany | TrashedPlace | TrashedUser | TrashedGroup;

/** The totals a bulk operation reports to the user. */
export interface TrashSummary {
  readonly restored: number;
  readonly deleted: number;
  /** Skipped items by id: the reason and, when the item was selected, its name. */
  readonly skipped: readonly { readonly id: string; readonly issue: TrashIssue }[];
  /** Groups whose request failed in a bulk call across groups (their items were not handled). */
  readonly failedGroups: readonly string[];
}

/**
 * Totals of the results of one or more bulk calls. An item that comes back skipped more than once
 * (the `empty` calls meet the items they cannot delete again) is counted once, with its last issue,
 * unless a later result restored or deleted it.
 *
 * @param results Results of the calls, in order.
 */
export function summarize(results: readonly TrashItemResult[]): TrashSummary {
  let restored = 0;
  let deleted = 0;
  const skipped = new Map<string, TrashIssue>();
  for (const result of results) {
    if (result.outcome === 'restored') {
      restored++;
      skipped.delete(result.id);
    } else if (result.outcome === 'deleted') {
      deleted++;
      skipped.delete(result.id);
    } else {
      skipped.set(result.id, result.issue ?? 'notFound');
    }
  }
  return {
    restored,
    deleted,
    skipped: [...skipped].map(([id, issue]) => ({ id, issue })),
    failedGroups: [],
  };
}

/** Router commands of the detail page of a row. */
export function trashRowRoute(kind: TrashKind, groupId: string, row: TrashRow): string[] {
  switch (kind) {
    case 'companies':
      return ['/groups', groupId, 'companies', row.id];
    case 'places':
      return placeRoute(groupId, row.id);
    case 'users':
      return userRoute(row as TrashedUser);
    case 'groups':
      return ['/groups', row.id, 'settings'];
  }
}

/** The text that names a row in the labels and in the summary. */
export function trashRowLabel(kind: TrashKind, row: TrashRow): string {
  return kind === 'users' ? (row as TrashedUser).username : (row as { name: string }).name;
}

/**
 * The reason a platform user could not be restored or deleted (`POST /v1/users/{id}/restore`,
 * `DELETE /v1/users/{id}`), or `null` for an error that is not about the user itself: `403` is
 * not allowed (also acting on oneself), `404` gone, `409` on `groups` a dealer that still has
 * groups.
 *
 * @param error What the call threw.
 */
export function platformIssue(error: unknown): TrashIssue | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  if (error.status === 403) {
    return 'forbidden';
  }
  if (error.status === 404) {
    return 'notFound';
  }
  const hasGroups = error.details.some((d) => d.field === 'groups' && d.issue === 'referenced');
  return error.status === 409 && hasGroups ? 'hasGroups' : null;
}
