import { ROLES } from '../security/rbac/permissions.ts';
import type { Role } from '../security/rbac/permissions.ts';

/** Categories of the activity log: business writes, security events and server errors. */
export const ACTIVITY_CATEGORIES = Object.freeze(['data', 'security', 'error'] as const);

/** A category of the activity log. */
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/** Outcomes of an activity. */
export const ACTIVITY_OUTCOMES = Object.freeze(['success', 'failure', 'denied'] as const);

/** The outcome of an activity: it happened, it failed, it was refused. */
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Kinds of actor. */
export const ACTOR_KINDS = Object.freeze(['user', 'anonymous', 'system'] as const);

/** The kind of the party that performed an activity. */
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Security actions (`doc/Security-Model.md` section 10). */
export const SECURITY_ACTIONS = Object.freeze([
  'auth.loginSucceeded',
  'auth.loginFailed',
  'auth.refreshed',
  'auth.refreshReuseDetected',
  'auth.refreshRaceTolerated',
  'auth.passwordCheckFailed',
  'session.revoked',
  'user.roleChanged',
  'user.scopeChanged',
  'user.statusChanged',
  'user.permissionsChanged',
  'group.crossAccess',
  'group.suspended',
  'group.reactivated',
  'group.trashed',
  'group.restored',
  'rateLimit.exceeded',
] as const);

/** Resources whose writes are logged. */
export const DATA_RESOURCES = Object.freeze(['user', 'group', 'dealer', 'company', 'place'] as const);

/** Verbs of a data action. */
export const DATA_VERBS = Object.freeze(['created', 'updated', 'trashed', 'restored', 'deleted'] as const);

/** The catalogs kept in the document of a group, as the part of the action name between `group.` and the verb (`group.priceList.created`). */
export const GROUP_CATALOG_NAMES = Object.freeze([
  'priceList',
  'tax',
  'currency',
  'measureUnit',
  'warehouseRule',
  'fidelityCardRule',
  'cardType',
  'pointsCollection',
  'prizeCatalogue',
  'productFavorite',
  'promotion',
] as const);

/** A catalog kept in the document of a group. */
export type GroupCatalogName = (typeof GROUP_CATALOG_NAMES)[number];

/** Verbs of the actions on the elements of a group catalog (an element is never trashed). */
export const GROUP_CATALOG_VERBS = Object.freeze(['created', 'updated', 'deleted'] as const);

/** An action on an element of a group catalog: `group.<catalog>.<verb>`, for example `group.priceList.created`. */
export type GroupCatalogAction = `group.${GroupCatalogName}.${(typeof GROUP_CATALOG_VERBS)[number]}`;

/** A data action: `<resource>.<verb>`, for example `user.created`, or an action on a catalog of a group. */
export type DataAction = `${(typeof DATA_RESOURCES)[number]}.${(typeof DATA_VERBS)[number]}` | GroupCatalogAction;

/** Error actions: a server error that became a `500`, and a JavaScript error reported by the backoffice in the browser. */
export const ERROR_ACTIONS = Object.freeze(['request.failed', 'client.error'] as const);

/** Every action the log accepts. */
export type ActivityAction = (typeof SECURITY_ACTIONS)[number] | DataAction | (typeof ERROR_ACTIONS)[number];

const DATA_ACTIONS: readonly DataAction[] = [
  ...DATA_RESOURCES.flatMap((resource) => DATA_VERBS.map((verb) => `${resource}.${verb}` as DataAction)),
  ...GROUP_CATALOG_NAMES.flatMap((name) => GROUP_CATALOG_VERBS.map((verb) => `group.${name}.${verb}` as DataAction)),
];

const SECURITY_METADATA: Readonly<Record<(typeof SECURITY_ACTIONS)[number], readonly string[]>> = {
  'auth.loginSucceeded': [],
  'auth.loginFailed': ['reason'],
  'auth.refreshed': [],
  'auth.refreshReuseDetected': [],
  'auth.refreshRaceTolerated': [],
  'auth.passwordCheckFailed': [],
  'session.revoked': ['reason'],
  'user.roleChanged': ['from', 'to'],
  'user.scopeChanged': [],
  'user.statusChanged': ['from', 'to'],
  'user.permissionsChanged': [],
  'group.crossAccess': [],
  'group.suspended': [],
  'group.reactivated': [],
  'group.trashed': [],
  'group.restored': [],
  'rateLimit.exceeded': ['bucket'],
};

const DATA_METADATA: readonly string[] = ['changesTotal', 'changesTruncated'];

/** Extra metadata keys of some data actions: a permanent deletion keeps no field changes, only the role of the user it removed (the group is the entry's `groupId`). */
const DATA_EXTRA_METADATA: Readonly<Partial<Record<DataAction, readonly string[]>>> = { 'user.deleted': ['role'] };

/** Definition of one action: its categories and the metadata keys it may carry (anything else is rejected). */
export interface ActionDefinition {
  readonly categories: readonly ActivityCategory[];
  readonly metadataKeys: readonly string[];
  /** `true` when the entry carries the dedicated `error` field (name, message, stack of a browser error). */
  readonly hasErrorDetails?: true;
}

/**
 * The catalog: action to definition. `group.trashed` and `group.restored` are both a security
 * event and a data write, so they accept both categories.
 */
export const ACTION_CATALOG: ReadonlyMap<string, ActionDefinition> = (() => {
  const catalog = new Map<string, ActionDefinition>();
  for (const action of SECURITY_ACTIONS) {
    catalog.set(action, { categories: ['security'], metadataKeys: SECURITY_METADATA[action] });
  }
  for (const action of DATA_ACTIONS) {
    const security = catalog.get(action);
    catalog.set(action, {
      categories: security === undefined ? ['data'] : ['security', 'data'],
      metadataKeys: [...(security?.metadataKeys ?? []), ...DATA_METADATA, ...(DATA_EXTRA_METADATA[action] ?? [])],
    });
  }
  catalog.set('request.failed', { categories: ['error'], metadataKeys: ['method', 'route', 'errorName', 'errorCode'] });
  catalog.set('client.error', { categories: ['error'], metadataKeys: ['route', 'appVersion', 'userAgent'], hasErrorDetails: true });
  return catalog;
})();

/** Every action name, for the database validator. */
export const ACTIVITY_ACTION_NAMES: readonly string[] = Object.freeze([...ACTION_CATALOG.keys()]);

/** Roles an actor may have. */
export const ACTOR_ROLES: readonly Role[] = ROLES;
