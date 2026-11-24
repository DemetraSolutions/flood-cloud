import type { I18nService } from '../../core/i18n/i18n.service';
import { Role } from '../../core/session/session.types';

/** Categories of the activity log. */
export const ACTIVITY_CATEGORIES = ['data', 'security', 'error'] as const;
/** A category of the activity log. */
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/** Outcomes of an activity. */
export const ACTIVITY_OUTCOMES = ['success', 'failure', 'denied'] as const;
/** The outcome of an activity. */
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

const SECURITY_ACTIONS = [
  'auth.loginSucceeded',
  'auth.loginFailed',
  'auth.refreshed',
  'auth.refreshFailed',
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
  'store.configurationRead',
  'store.operatorRejected',
  'store.activationCodeForActivePlace',
  'store.activeKeyReplaced',
  'store.activeKeyRevoked',
  'request.nonBrowser',
  'settings.securityPolicyUpdated',
  'apiKey.created',
  'apiKey.updated',
  'apiKey.revoked',
  'country.created',
  'country.updated',
  'country.deleted',
  'countryArea.created',
  'countryArea.updated',
  'countryArea.deleted',
];
const DATA_RESOURCES = ['user', 'group', 'company', 'place'];
const DATA_VERBS = ['created', 'updated', 'trashed', 'restored', 'deleted'];
/** Actions of the product catalog of a group: the products, then the entries that are only deleted for good. */
const CATALOG_ACTIONS = [
  ...['created', 'updated', 'trashed', 'restored', 'deleted', 'duplicated'].map(
    (verb) => `product.${verb}`,
  ),
  ...['productCategory', 'productDepartment', 'productBrand', 'productAttributeGroup'].flatMap(
    (resource) => ['created', 'updated', 'deleted'].map((verb) => `${resource}.${verb}`),
  ),
  'group.tax.realignmentIncomplete',
];

/** Every action of the backend catalog (the action filter offers them, each with a label). */
export const ACTIVITY_ACTIONS: readonly string[] = [
  ...new Set([
    ...SECURITY_ACTIONS,
    ...DATA_RESOURCES.flatMap((resource) => DATA_VERBS.map((verb) => `${resource}.${verb}`)),
    ...CATALOG_ACTIONS,
    'request.failed',
    'client.error',
  ]),
];

/** Dictionary key of an action label: `auth.loginSucceeded` is `ACTIVITY.ACTION.AUTH_LOGIN_SUCCEEDED`. */
export function actionLabelKey(action: string): string {
  return `ACTIVITY.ACTION.${action
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replaceAll('.', '_')
    .toUpperCase()}`;
}

/**
 * Who performed an activity: a backoffice user, an anonymous caller, the system, the server of a
 * store (`store`, by its store key) or an integration with a public API key (`apiKey`, by the id
 * of the key).
 */
export interface ActivityActor {
  readonly kind: 'user' | 'anonymous' | 'system' | 'store' | 'apiKey';
  readonly id: string | null;
  readonly role: Role | null;
  readonly username: string | null;
}

/** Label of an actor that is not a user: "Sistema", "Anonimo", "Negozio", "Chiave API …abc123". */
export function otherActorLabel(i18n: Pick<I18nService, 't'>, actor: ActivityActor): string {
  return actor.kind === 'apiKey'
    ? i18n.t('ACTIVITY.ACTOR.API_KEY', { id: actor.id === null ? '' : abbreviateId(actor.id) })
    : i18n.t(`ACTIVITY.ACTOR.${actor.kind.toUpperCase()}`);
}

/** One changed field of a data write; secret fields carry no values. */
export interface ActivityChange {
  readonly field: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly redacted?: boolean;
  readonly truncated?: boolean;
}

/** JavaScript error reported by a client (`client.error` entries only). */
export interface ActivityClientError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string | null;
}

/** An entry of the activity log as returned by `GET /v1/activity-log`. */
export interface ActivityEntry {
  readonly id: string;
  readonly at: string;
  readonly category: ActivityCategory;
  readonly action: string;
  readonly outcome: ActivityOutcome;
  readonly actor: ActivityActor;
  readonly groupId: string | null;
  readonly resource: { readonly type: string; readonly id?: string | null } | null;
  readonly changes: readonly ActivityChange[] | null;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly error?: ActivityClientError | null;
}

/** Short form of an id for table cells (the last characters differ the most). */
export function abbreviateId(id: string): string {
  return `…${id.slice(-6)}`;
}

/** Text of a change value; `undefined` (the field was absent on that side) is an empty text. */
export function formatChangeValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Store key alerts that name the key by its first characters, with the dictionary key of their sentence. */
const KEY_ALERTS: Readonly<Record<string, string>> = {
  'store.activationCodeForActivePlace': 'ACTIVITY.ALERTS.CODE_FOR_ACTIVE',
  'store.activeKeyReplaced': 'ACTIVITY.ALERTS.KEY_REPLACED',
  'store.activeKeyRevoked': 'ACTIVITY.ALERTS.KEY_REVOKED',
};

/**
 * Readable sentence for the metadata of a security alert entry: for a sustained limit the window
 * that was exceeded, the threshold and whether the request was only reported or also blocked; for
 * the store key alerts the beginning of the key concerned.
 *
 * @param i18n Translator.
 * @param entry Entry of the activity log.
 * @returns The sentence, or `null` for any other action or when the metadata is not as expected.
 */
export function alertSummary(
  i18n: Pick<I18nService, 't'>,
  entry: Pick<ActivityEntry, 'action' | 'metadata'> & Partial<Pick<ActivityEntry, 'changes'>>,
): string | null {
  if (entry.action === 'settings.securityPolicyUpdated') {
    return policySummary(i18n, entry.changes ?? []);
  }
  const { window, limit, mode, keyHint, reason, source, userAgent } = entry.metadata ?? {};
  if (entry.action === 'request.nonBrowser') {
    return nonBrowserSummary(i18n, reason, source, userAgent);
  }
  if (entry.action === 'auth.loginFailed' || entry.action === 'auth.refreshFailed') {
    return reason === 'browserRequired' ? i18n.t('ACTIVITY.ALERTS.BROWSER_REQUIRED') : null;
  }
  if (Object.hasOwn(KEY_ALERTS, entry.action)) {
    return typeof keyHint === 'string' && keyHint !== ''
      ? i18n.t(KEY_ALERTS[entry.action], { hint: keyHint })
      : null;
  }
  if (
    entry.action !== 'rateLimit.sustainedExceeded' ||
    (window !== 'hour' && window !== 'day') ||
    typeof limit !== 'number' ||
    (mode !== 'report' && mode !== 'enforce')
  ) {
    return null;
  }
  return i18n.t('ACTIVITY.ALERTS.DETAIL', {
    limit,
    window: i18n.t(
      window === 'hour' ? 'ACTIVITY.ALERTS.WINDOW_HOUR' : 'ACTIVITY.ALERTS.WINDOW_DAY',
    ),
    mode: i18n.t(
      mode === 'report' ? 'ACTIVITY.ALERTS.MODE_REPORT' : 'ACTIVITY.ALERTS.MODE_ENFORCE',
    ),
  });
}

const NON_BROWSER_REASONS: Readonly<Record<string, string>> = {
  noOrigin: 'ACTIVITY.ALERTS.REASON_NO_ORIGIN',
  foreignOrigin: 'ACTIVITY.ALERTS.REASON_FOREIGN_ORIGIN',
  inconsistentFetchMetadata: 'ACTIVITY.ALERTS.REASON_INCONSISTENT',
};
const NON_BROWSER_SOURCES: Readonly<Record<string, string>> = {
  login: 'ACTIVITY.ALERTS.SOURCE_LOGIN',
  refresh: 'ACTIVITY.ALERTS.SOURCE_REFRESH',
  api: 'ACTIVITY.ALERTS.SOURCE_API',
};

/** Sentence of a `request.nonBrowser` entry; the user agent is plain text (the template never renders it as HTML). */
function nonBrowserSummary(
  i18n: Pick<I18nService, 't'>,
  reason: unknown,
  source: unknown,
  userAgent: unknown,
): string | null {
  if (
    typeof reason !== 'string' ||
    typeof source !== 'string' ||
    !Object.hasOwn(NON_BROWSER_REASONS, reason) ||
    !Object.hasOwn(NON_BROWSER_SOURCES, source)
  ) {
    return null;
  }
  const reasonKey = NON_BROWSER_REASONS[reason];
  const sourceKey = NON_BROWSER_SOURCES[source];
  const sentence = i18n.t('ACTIVITY.ALERTS.NON_BROWSER', {
    source: i18n.t(sourceKey),
    reason: i18n.t(reasonKey),
  });
  return typeof userAgent === 'string' && userAgent !== ''
    ? `${sentence} ${i18n.t('ACTIVITY.ALERTS.PROGRAM', { agent: userAgent })}`
    : sentence;
}

const POLICY_FIELDS: Readonly<Record<string, string>> = {
  nonBrowserRequests: 'ACTIVITY.ALERTS.POLICY_NON_BROWSER',
  sustainedLimits: 'ACTIVITY.ALERTS.POLICY_LIMITS',
};

/** Sentence of a `settings.securityPolicyUpdated` entry: each setting that changed, from which choice to which. */
function policySummary(
  i18n: Pick<I18nService, 't'>,
  changes: readonly ActivityChange[],
): string | null {
  const choice = (value: unknown): string | null =>
    value === 'report'
      ? i18n.t('ACTIVITY.ALERTS.POLICY_REPORT')
      : value === 'block' || value === 'enforce'
        ? i18n.t('ACTIVITY.ALERTS.POLICY_BLOCK')
        : null;
  const parts = changes.flatMap((change) => {
    const before = choice(change.before);
    const after = choice(change.after);
    return Object.hasOwn(POLICY_FIELDS, change.field) && before !== null && after !== null
      ? [
          i18n.t('ACTIVITY.ALERTS.POLICY_CHANGE', {
            field: i18n.t(POLICY_FIELDS[change.field]),
            before,
            after,
          }),
        ]
      : [];
  });
  return parts.length === 0 ? null : parts.join(' ');
}
