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

/** Kinds of actor: a backoffice user, an anonymous caller, the system itself and the server of a point of sale (identified by the id of its store key) and an integration with a public API key (identified by the id of the key). */
export const ACTOR_KINDS = Object.freeze(['user', 'anonymous', 'system', 'store', 'apiKey'] as const);

/** The kind of the party that performed an activity. */
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Security actions (`doc/Security-Model.md` section 10). */
export const SECURITY_ACTIONS = Object.freeze([
  'auth.loginSucceeded',
  'auth.loginFailed',
  'auth.refreshFailed',
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
  'rateLimit.sustainedExceeded',
  'request.nonBrowser',
  'settings.securityPolicyUpdated',
  'store.activationCodeCreated',
  'store.activationCodeCancelled',
  'store.activated',
  'store.activationFailed',
  'store.keyRevoked',
  'store.activationCodeForActivePlace',
  'store.activeKeyReplaced',
  'store.activeKeyRevoked',
  'store.revokedKeyPresented',
  'store.configurationRead',
  'store.operatorRejected',
  'apiKey.created',
  'apiKey.updated',
  'apiKey.revoked',
] as const);

/**
 * The closed set of actions the backoffice shows as an alert (the badge of the activity log menu entry, counted by
 * `GET /v1/activity-log/alerts/count`). Defined here, in the server, so the client never decides what is an alert; add an
 * action to the array to raise one more kind of alert. Every action must be a security action.
 */
export const ACTIVITY_ALERT_ACTIONS: readonly (typeof SECURITY_ACTIONS)[number][] = Object.freeze(['rateLimit.sustainedExceeded', 'request.nonBrowser', 'settings.securityPolicyUpdated', 'store.activationCodeForActivePlace', 'store.activeKeyReplaced', 'store.activeKeyRevoked'] as const);

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

/** The data actions that are not a verb of every resource: a place is also duplicated (`place.duplicated`, with the id of the source place in its metadata), and the e-mail templates of a group are created, updated and deleted (never trashed; their content is never logged), and the tobacco price list is imported (`tobaccos.imported`, with the counts of documents only, or with the reason `file` or `rows` when the file was refused), and the countries of the platform and their areas (provinces) are created, updated and deleted by the PSA (`country.*` and `countryArea.*`, with the codes in the metadata), and a company is looked up by its VAT number on Cerved (`vatLookup.performed`, with the outcome `found`, `notFound` or `unavailable` and the VAT number as the id of the resource: business data of a company, never a key), and the bulk operations of the trash page (`trash.bulkRestored`, `trash.bulkDeleted` and `trash.emptied`, one entry per call with the kind and the counts, never the ids: the entries of the single items already carry them), and the departments, the brands, the groups of attributes and the categories of the product catalog of a group (`productDepartment.*`, `productBrand.*`, `productAttributeGroup.*` and `productCategory.*`, created, updated and deleted for good, with the fields of the entry and never anything else), and the realignment of a tax rate that did not complete outside a transaction (`group.tax.realignmentIncomplete`, outcome `failure`, with the id of the rate, the blocks left or `null` and whether it was skipped, never a value), and the products of a group (`product.*`: created, updated, trashed, restored, deleted for good and duplicated, with the id of the source product in the metadata of a duplicate, and the changed fields only, every list cut and counted), and the workbook of the catalog of a group (`catalog.exported`, with how references were written and the counts of the rows of each sheet, and `catalog.imported`, with the counts of the documents written, or the number of problems and the reason `file` or `rows` when the workbook was refused, and `dryRun`; never the content of the file, a name or a price: the entries of the single products are not written), and the purge of a trashed group by the command line tool (`group.purged`, written with the system actor: the counts of what was deleted, never a value), and the billing of the activations, all of the PSA (`priceList.updated`, `dealer.priceOverridesUpdated` with the dealer as the resource, `activations.renewalBaseFrozen` and `activations.renewalBaseUnfrozen` with the year, `activations.monthClosed` and `activations.monthReopened` with the invoice month, the counts of dealers and lines in the metadata). */
export const DATA_EXTRA_ACTIONS = Object.freeze(['place.duplicated', 'emailTemplate.created', 'emailTemplate.updated', 'emailTemplate.deleted', 'tobaccos.imported', 'vatLookup.performed', 'country.created', 'country.updated', 'country.deleted', 'countryArea.created', 'countryArea.updated', 'countryArea.deleted', 'trash.bulkRestored', 'trash.bulkDeleted', 'trash.emptied', 'priceList.updated', 'dealer.priceOverridesUpdated', 'activations.renewalBaseFrozen', 'activations.renewalBaseUnfrozen', 'activations.monthClosed', 'activations.monthReopened', 'group.purged', 'productDepartment.created', 'productDepartment.updated', 'productDepartment.deleted', 'productBrand.created', 'productBrand.updated', 'productBrand.deleted', 'productAttributeGroup.created', 'productAttributeGroup.updated', 'productAttributeGroup.deleted', 'productCategory.created', 'productCategory.updated', 'productCategory.deleted', 'product.created', 'product.updated', 'product.trashed', 'product.restored', 'product.deleted', 'product.duplicated', 'group.tax.realignmentIncomplete', 'catalog.exported', 'catalog.imported', 'tobaccos.synced'] as const);

/** A data action: `<resource>.<verb>`, for example `user.created`, an action of one resource only (`place.duplicated`), or an action on a catalog of a group. */
export type DataAction = `${(typeof DATA_RESOURCES)[number]}.${(typeof DATA_VERBS)[number]}` | (typeof DATA_EXTRA_ACTIONS)[number] | GroupCatalogAction;

/** Error actions: a server error that became a `500`, and a JavaScript error reported by the backoffice in the browser. */
export const ERROR_ACTIONS = Object.freeze(['request.failed', 'client.error'] as const);

/** Every action the log accepts. */
export type ActivityAction = (typeof SECURITY_ACTIONS)[number] | DataAction | (typeof ERROR_ACTIONS)[number];

const DATA_ACTIONS: readonly DataAction[] = [
  ...DATA_RESOURCES.flatMap((resource) => DATA_VERBS.map((verb) => `${resource}.${verb}` as DataAction)),
  ...DATA_EXTRA_ACTIONS,
  ...GROUP_CATALOG_NAMES.flatMap((name) => GROUP_CATALOG_VERBS.map((verb) => `group.${name}.${verb}` as DataAction)),
];

const SECURITY_METADATA: Readonly<Record<(typeof SECURITY_ACTIONS)[number], readonly string[]>> = {
  'auth.loginSucceeded': [],
  'auth.loginFailed': ['reason'],
  // A refresh refused although the refresh token was good (today only `browserRequired`: the policy blocks the requests that do not look like a browser's). The token is not consumed.
  'auth.refreshFailed': ['reason'],
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
  // A user went over the hourly or daily limit on `/v1` (once per user and window): the bucket, the window (`hour` or `day`), the limit and the mode that applied to this user (`report`: the request passed; `enforce`: it was refused).
  'rateLimit.sustainedExceeded': ['bucket', 'window', 'limit', 'mode'],
  // A request of a user that does not look like a browser's (a signal, falsifiable, never a block): why (`noOrigin`, `foreignOrigin`, `inconsistentFetchMetadata`), where it was seen (`source`: `login`, `refresh` or `api`), what was done (`outcome`: `reported` or `blocked`) and the `User-Agent`, printable and cut at 120 characters.
  // The security policy of the platform was changed by the PSA: the entry carries the field changes (before and after) and no metadata.
  'settings.securityPolicyUpdated': [],
  'request.nonBrowser': ['reason', 'source', 'outcome', 'userAgent'],
  'store.activationCodeCreated': [],
  'store.activationCodeCancelled': [],
  'store.activated': ['replacedKeyId'],
  'store.activationFailed': ['reason'],
  'store.keyRevoked': ['reason', 'keyHint'],
  // Alerts of the store key. An activation code was made for a place that already has an active key (the administrator confirmed the replacement): the four character hint of that key, never the code. Resource: the place.
  'store.activationCodeForActivePlace': ['keyHint'],
  // An activation replaced the active key of a place: the hint and the id of the key that was replaced, never a key. Actor: the new key, as for `store.activated`. Resource: the place.
  'store.activeKeyReplaced': ['keyHint', 'replacedKeyId'],
  // An administrator revoked the active key of a place by hand (the revocation because the place was trashed or deleted is not an alert): the hint and the id of the key, never a key. Actor: who revoked. Resource: the place.
  'store.activeKeyRevoked': ['keyHint', 'keyId'],
  'store.revokedKeyPresented': [],
  // The server of a store read the configuration that carries credentials: which one (`group`, `place` or `users`) and the ids of its company and place, never a value.
  'store.configurationRead': ['resource', 'companyId', 'placeId'],
  // The server of a store sent a write of the catalog without a usable operator (`reason`: `missing`, `malformed`, `notFound`, `disabled` or `noPermission`) and the id it declared, when it was well formed; the response never says which.
  'store.operatorRejected': ['reason', 'operatorId'],
  // A public API key is recorded by its name and the characters of its prefix after `fc_pk_` (`keyHint`: the log redacts any text that starts like a key), never the key; an update lists the names of the fields it changed.
  'apiKey.created': ['name', 'keyHint'],
  'apiKey.updated': ['name', 'keyHint', 'fields'],
  'apiKey.revoked': ['name', 'keyHint'],
};

const DATA_METADATA: readonly string[] = ['changesTotal', 'changesTruncated'];

/** What an entry of a bulk operation of the trash carries: the kind (`companies`, `places`, `users`, `groups`), how many items were asked for and how many ended each way. */
const TRASH_METADATA: readonly string[] = ['kind', 'requested', 'restored', 'deleted', 'skipped'];

/** What the entries of the billing of the activations carry: the period (`2026` or `2026-06`) and how many dealer documents and place lines the operation touched. */
const BILLING_METADATA: readonly string[] = ['period', 'dealers', 'lines'];

/** What the entry of a purged group carries: how many documents of each kind the tool deleted in that run (counts only), and `resumed` when the group database was already gone (a repeated run: the counts are those of the last run alone). */
const PURGE_METADATA: readonly string[] = ['collections', 'documents', 'users', 'companies', 'places', 'apiKeys', 'apiUsage', 'storeKeys', 'activationCodes', 'reserveWithGoogle', 'idempotencyKeys', 'resumed'];

/** The data actions the server of a point of sale may perform on the product catalog (products, categories and brands): their entries also say which operator stood at the till (`operatorId`, declared by the store and verified, never the actor). */
const STORE_WRITE_ACTIONS: ReadonlySet<string> = new Set(['product.created', 'product.updated', 'product.trashed', 'product.restored', 'product.duplicated', 'productCategory.created', 'productCategory.updated', 'productCategory.deleted', 'productBrand.created', 'productBrand.updated', 'productBrand.deleted']);

/** The data actions a public API key may perform on the product catalog (`catalog:write`): their entries also carry the indicator of the key (`keyHint`, the six characters after `fc_pk_`, never the secret: the log redacts any text that starts like a key). The actor is the key itself. */
const API_KEY_WRITE_ACTIONS: ReadonlySet<string> = new Set(['product.created', 'product.updated', 'product.trashed', 'product.restored', 'productCategory.created', 'productCategory.updated', 'productCategory.deleted']);

/** Extra metadata keys of some data actions: a permanent deletion keeps no field changes, only the role of the user it removed (the group is the entry's `groupId`), and a duplicated place the id of the place it was copied from. */
const DATA_EXTRA_METADATA: Readonly<Partial<Record<DataAction, readonly string[]>>> = { 'user.deleted': ['role'], 'place.duplicated': ['sourceId'], 'product.duplicated': ['sourceId'], 'group.tax.realignmentIncomplete': ['taxId', 'remainingBlocks', 'skipped'], 'tobaccos.imported': ['inserted', 'previous', 'reason'], 'catalog.exported': ['references', 'products', 'variants', 'categories'], 'catalog.imported': ['dryRun', 'reason', 'inserted', 'updated', 'removed', 'unchanged', 'errors'], 'tobaccos.synced': ['dryRun', 'reason', 'warehouse', 'noDiscount', 'confirmMassDisable', 'massDisableExceeded', 'active', 'places', 'inserted', 'updated', 'disabled', 'reactivated', 'unchanged', 'skipped', 'categoriesInserted', 'duplicateCodes', 'duplicateCategoryNames', 'entries', 'entriesOmitted'], 'vatLookup.performed': ['outcome'], 'country.created': ['countryCode'], 'country.updated': ['countryCode'], 'country.deleted': ['countryCode'], 'countryArea.created': ['countryCode', 'areaCode'], 'countryArea.updated': ['countryCode', 'areaCode'], 'countryArea.deleted': ['countryCode', 'areaCode'], 'trash.bulkRestored': TRASH_METADATA, 'trash.bulkDeleted': TRASH_METADATA, 'trash.emptied': TRASH_METADATA, 'activations.renewalBaseFrozen': BILLING_METADATA, 'activations.renewalBaseUnfrozen': BILLING_METADATA, 'activations.monthClosed': BILLING_METADATA, 'activations.monthReopened': BILLING_METADATA, 'group.purged': PURGE_METADATA };

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
      metadataKeys: [...(security?.metadataKeys ?? []), ...DATA_METADATA, ...(DATA_EXTRA_METADATA[action] ?? []), ...(STORE_WRITE_ACTIONS.has(action) ? ['operatorId'] : []), ...(API_KEY_WRITE_ACTIONS.has(action) ? ['keyHint'] : [])],
    });
  }
  catalog.set('request.failed', { categories: ['error'], metadataKeys: ['method', 'route', 'errorName', 'errorCode'] });
  catalog.set('client.error', { categories: ['error'], metadataKeys: ['route', 'appVersion', 'userAgent'], hasErrorDetails: true });
  return catalog;
})();

/** Roles an actor may have. */
export const ACTOR_ROLES: readonly Role[] = ROLES;
