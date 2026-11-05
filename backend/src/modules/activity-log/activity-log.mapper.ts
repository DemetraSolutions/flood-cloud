import type { Document, ObjectId } from 'mongodb';
import { ROLE_RANK, isRole } from '../../shared/security/rbac/permissions.ts';
import type { Role } from '../../shared/security/rbac/permissions.ts';

/** A change of one field as the activity log list shows it. */
export interface ActivityChangeView {
  readonly field: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly redacted?: true;
  readonly truncated?: true;
}

/** The JavaScript error of a `client.error` entry. */
export interface ActivityErrorView {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
}

/** An activity log entry as the list shows it: this and nothing else is ever returned. */
export interface ActivityEntryView {
  readonly id: string;
  /** ISO date-time. */
  readonly at: string;
  readonly category: string;
  readonly action: string;
  readonly outcome: string;
  readonly actor: {
    readonly kind: string;
    readonly id: string | null;
    readonly role: string | null;
    /** User name of a `user` actor, `null` for the others or when the user no longer exists. */
    readonly username: string | null;
  };
  readonly groupId: string | null;
  readonly resource: { readonly type: string; readonly id: string | null } | null;
  readonly changes: ActivityChangeView[];
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly metadata: Record<string, string | number | boolean | null>;
  /** Present only on `client.error` entries. */
  readonly error?: ActivityErrorView;
}

/** Fields of the stored entry the list reads (`expiresAt` is never one of them). */
export const ACTIVITY_LOG_PROJECTION = Object.freeze({
  at: 1,
  category: 1,
  action: 1,
  outcome: 1,
  actor: 1,
  groupId: 1,
  resource: 1,
  changes: 1,
  requestId: 1,
  ip: 1,
  metadata: 1,
  error: 1,
} as const);

const hexOf = (value: unknown): string | null => (value === undefined || value === null ? null : (value as ObjectId).toHexString());
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function toChange(change: Document): ActivityChangeView {
  return {
    field: change['field'] as string,
    ...(Object.hasOwn(change, 'before') ? { before: change['before'] as unknown } : {}),
    ...(Object.hasOwn(change, 'after') ? { after: change['after'] as unknown } : {}),
    ...(change['redacted'] === true ? { redacted: true as const } : {}),
    ...(change['truncated'] === true ? { truncated: true as const } : {}),
  };
}

/**
 * Tells whether the actor of an entry has a higher role than the viewer (PSA > D > SA > CA > PA > E). Such an
 * actor stays anonymous to the viewer: no id, no user name, no address.
 *
 * @param document The stored entry.
 * @param viewer Role of the caller.
 */
export function outranksViewer(document: Document, viewer: Role): boolean {
  const role: unknown = (document['actor'] as Document)['role'];
  return isRole(role) && ROLE_RANK[role] > ROLE_RANK[viewer];
}

/**
 * Maps a stored entry to its list representation, field by field (allowlist). Absent optional values
 * become `null`, `[]` or `{}`; `error` is present only when the entry has one.
 *
 * @param document The projected entry.
 * @param usernames User name by hex user id, for the actors of the page.
 * @param viewer Role of the caller: the id and user name of an actor with a higher role, and the address, are hidden (the role stays).
 */
export function toActivityEntry(document: Document, usernames: ReadonlyMap<string, string>, viewer: Role): ActivityEntryView {
  const actor = document['actor'] as Document;
  const hidden = outranksViewer(document, viewer);
  const actorId = hidden ? null : hexOf(actor['id']);
  const resource = document['resource'] as Document | undefined;
  const error = document['error'] as Document | undefined;
  return {
    id: (document['_id'] as ObjectId).toHexString(),
    at: (document['at'] as Date).toISOString(),
    category: document['category'] as string,
    action: document['action'] as string,
    outcome: document['outcome'] as string,
    actor: {
      kind: actor['kind'] as string,
      id: actorId,
      role: textOf(actor['role']),
      username: actorId === null ? null : (usernames.get(actorId) ?? null),
    },
    groupId: hexOf(document['groupId']),
    resource: resource === undefined ? null : { type: resource['type'] as string, id: textOf(resource['id']) },
    changes: ((document['changes'] as Document[] | undefined) ?? []).map(toChange),
    requestId: textOf(document['requestId']),
    ip: hidden ? null : textOf(document['ip']),
    metadata: { ...((document['metadata'] as Record<string, string | number | boolean | null> | undefined) ?? {}) },
    ...(error === undefined ? {} : { error: { name: error['name'] as string, message: error['message'] as string, stack: textOf(error['stack']) } }),
  };
}
