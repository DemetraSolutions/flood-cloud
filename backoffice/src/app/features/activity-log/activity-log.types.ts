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
  'apiKey.created',
  'apiKey.updated',
  'apiKey.revoked',
];
const DATA_RESOURCES = ['user', 'group', 'company', 'place'];
const DATA_VERBS = ['created', 'updated', 'trashed', 'restored', 'deleted'];

/** Every action of the backend catalog (the action filter offers them, each with a label). */
export const ACTIVITY_ACTIONS: readonly string[] = [
  ...new Set([
    ...SECURITY_ACTIONS,
    ...DATA_RESOURCES.flatMap((resource) => DATA_VERBS.map((verb) => `${resource}.${verb}`)),
    'request.failed',
    'client.error',
  ]),
];

/** Dictionary key of an action label: `auth.loginSucceeded` is `ACTIVITY.ACTION.AUTH_LOGIN_SUCCEEDED`. */
export function actionLabelKey(action: string): string {
  return `ACTIVITY.ACTION.${action
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace('.', '_')
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
