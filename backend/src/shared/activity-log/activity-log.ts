import { ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { isPersonalDataKey, isSecretKey, redact } from '../logging/logger.ts';
import type { Logger } from '../logging/logger.ts';
import type { Role } from '../security/rbac/permissions.ts';
import { ACTION_CATALOG, ACTIVITY_OUTCOMES, ACTOR_KINDS, ACTOR_ROLES } from './catalog.ts';
import type { ActivityAction, ActivityCategory, ActivityOutcome, ActorKind } from './catalog.ts';
import type { ChangeValue, FieldChange } from './changes.ts';

/** Maximum length of the `resource.type`. */
export const MAX_RESOURCE_TYPE_LENGTH = 32;
/** Maximum length of the `resource.id`; longer values are cut. */
export const MAX_RESOURCE_ID_LENGTH = 64;
/** Maximum number of metadata keys. */
export const MAX_METADATA_KEYS = 20;
/** Maximum length of a metadata string; longer values are cut. */
export const MAX_METADATA_STRING_LENGTH = 256;
/** Maximum number of changes of one entry. */
export const MAX_CHANGES = 200;

const DAY_MS = 86_400_000;

/** Who performed an activity. */
export interface ActivityActor {
  readonly kind: ActorKind;
  /** The user id, for `user` actors. */
  readonly id?: ObjectId;
  readonly role?: Role;
}

/** The resource an activity acted on. */
export interface ActivityResource {
  readonly type: string;
  readonly id?: string;
}

/** A scalar metadata value. */
export type MetadataValue = string | number | boolean | null;

/** What a caller reports to {@link ActivityLog.record}. */
export interface ActivityEntry {
  readonly category: ActivityCategory;
  readonly action: ActivityAction;
  readonly outcome: ActivityOutcome;
  readonly actor: ActivityActor;
  readonly groupId?: ObjectId;
  readonly resource?: ActivityResource;
  readonly changes?: readonly FieldChange[];
  readonly requestId?: string;
  readonly ip?: string;
  /** Scalar values under the keys the action allows (`ACTION_CATALOG`). */
  readonly metadata?: Readonly<Record<string, MetadataValue>>;
}

/** The stored document: an entry plus its time and expiry. */
export interface ActivityLogDocument extends ActivityEntry {
  readonly at: Date;
  readonly expiresAt: Date;
}

/** Writes the activity log. */
export interface ActivityLog {
  /**
   * Validates, redacts and stores an entry. It never rejects: a failed write sends the redacted
   * entry to stdout through the logger, and a malformed entry (a programming error: unknown action,
   * wrong category, unknown metadata key, bad actor) is logged as `activity log entry rejected` with
   * its action, category and reason, never the raw entry.
   *
   * @param entry What happened.
   */
  record(entry: ActivityEntry): Promise<void>;
}

/** Collaborators of {@link createActivityLog}. */
export interface ActivityLogDeps {
  readonly databases: Databases;
  readonly logger: Logger;
  /** Days `data` and `security` entries are kept (`ACTIVITY_LOG_RETENTION_DAYS`). */
  readonly retentionDays: number;
  /** Days `error` entries are kept (`ACTIVITY_LOG_ERROR_RETENTION_DAYS`). */
  readonly errorRetentionDays: number;
  /** Clock in epoch milliseconds. */
  readonly now?: () => number;
}

/** Redacts a string with the logger rules (credential-looking values become `[REDACTED]`) and cuts it. */
function clean(value: string, maxLength: number): string {
  return (redact(value) as string).slice(0, maxLength);
}

/** Hides secrets in a change value: credential-looking strings and secret keys at any depth (personal data stays). */
function cleanValue(value: ChangeValue): ChangeValue {
  if (typeof value === 'string') {
    return redact(value) as string;
  }
  if (Array.isArray(value)) {
    return value.map((item: ChangeValue) => cleanValue(item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSecretKey(key) ? '[REDACTED]' : cleanValue(item)]));
  }
  return value;
}

function cleanChange(change: FieldChange): FieldChange {
  return {
    field: clean(change.field, 256),
    ...(change.before === undefined ? {} : { before: cleanValue(change.before) }),
    ...(change.after === undefined ? {} : { after: cleanValue(change.after) }),
    ...(change.redacted === undefined ? {} : { redacted: change.redacted }),
    ...(change.truncated === undefined ? {} : { truncated: change.truncated }),
  };
}

function invalid(reason: string): never {
  throw new TypeError(`Invalid activity log entry: ${reason}`);
}

function cleanMetadata(action: string, metadata: Readonly<Record<string, MetadataValue>>, allowed: readonly string[]): Record<string, MetadataValue> {
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_KEYS) {
    invalid('too many metadata keys');
  }
  const result: Record<string, MetadataValue> = {};
  for (const key of keys) {
    const value = metadata[key];
    if (!allowed.includes(key)) {
      invalid(`metadata key "${key}" is not allowed for ${action}`);
    }
    if (typeof value === 'string') {
      result[key] = clean(value, MAX_METADATA_STRING_LENGTH);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      result[key] = value;
    } else {
      invalid(`metadata "${key}" must be a scalar`);
    }
  }
  return result;
}

/**
 * Checks an entry against the allowlists and returns the document to store, with every string
 * redacted and bounded.
 *
 * @param entry The entry.
 * @param at Event time.
 * @param retentionDays Days the entry is kept.
 * @returns The document.
 * @throws {TypeError} If the entry is malformed.
 */
export function buildActivityDocument(entry: ActivityEntry, at: Date, retentionDays: number): ActivityLogDocument {
  const definition = ACTION_CATALOG.get(entry.action);
  if (definition === undefined) {
    invalid(`unknown action "${String(entry.action)}"`);
  }
  if (!definition.categories.includes(entry.category)) {
    invalid(`action ${entry.action} does not belong to category ${String(entry.category)}`);
  }
  if (!(ACTIVITY_OUTCOMES as readonly string[]).includes(entry.outcome)) {
    invalid('unknown outcome');
  }
  const { actor } = entry;
  if (!(ACTOR_KINDS as readonly string[]).includes(actor.kind)) {
    invalid('unknown actor kind');
  }
  if ((actor.id !== undefined && !(actor.id instanceof ObjectId)) || (actor.kind !== 'user' && actor.id !== undefined)) {
    invalid('actor id must be an ObjectId and only for user actors');
  }
  if (actor.role !== undefined && !ACTOR_ROLES.includes(actor.role)) {
    invalid('unknown actor role');
  }
  if (actor.kind === 'user' && actor.id === undefined) {
    invalid('a user actor needs an id');
  }
  if (entry.groupId !== undefined && !(entry.groupId instanceof ObjectId)) {
    invalid('groupId must be an ObjectId');
  }
  if (entry.resource !== undefined && (entry.resource.type === '' || entry.resource.type.length > MAX_RESOURCE_TYPE_LENGTH)) {
    invalid('resource type must be 1 to 32 characters');
  }
  if ((entry.changes?.length ?? 0) > MAX_CHANGES) {
    invalid('too many changes');
  }
  return {
    at,
    category: entry.category,
    action: entry.action,
    outcome: entry.outcome,
    actor: {
      kind: actor.kind,
      ...(actor.id === undefined ? {} : { id: actor.id }),
      ...(actor.role === undefined ? {} : { role: actor.role }),
    },
    ...(entry.groupId === undefined ? {} : { groupId: entry.groupId }),
    ...(entry.resource === undefined
      ? {}
      : {
          resource: {
            type: entry.resource.type,
            ...(entry.resource.id === undefined ? {} : { id: clean(entry.resource.id, MAX_RESOURCE_ID_LENGTH) }),
          },
        }),
    ...(entry.changes === undefined ? {} : { changes: entry.changes.map(cleanChange) }),
    ...(entry.requestId === undefined ? {} : { requestId: clean(entry.requestId, 128) }),
    ...(entry.ip === undefined ? {} : { ip: clean(entry.ip, 64) }),
    ...(entry.metadata === undefined ? {} : { metadata: cleanMetadata(entry.action, entry.metadata, definition.metadataKeys) }),
    expiresAt: new Date(at.getTime() + retentionDays * DAY_MS),
  };
}

/**
 * Copy of a document for the log line on stdout: ids as hex (so the logger does not flatten them to
 * `{}`), and the values of every change on a secret or personal data field hidden (stdout, unlike the
 * activity log, never shows personal data).
 */
function loggable(document: ActivityLogDocument): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(document)) as { changes?: FieldChange[] } & Record<string, unknown>;
  if (copy.changes !== undefined) {
    copy.changes = copy.changes.map((change) =>
      change.field.split('.').some((segment) => isSecretKey(segment) || isPersonalDataKey(segment)) ? { ...change, ...(change.before === undefined ? {} : { before: '[REDACTED]' }), ...(change.after === undefined ? {} : { after: '[REDACTED]' }) }
        : change,
    );
  }
  return copy;
}

/**
 * Creates the activity log service over `common.activityLog`.
 *
 * @param deps Database accessor, logger, retention and clock.
 * @returns The service.
 */
export function createActivityLog(deps: ActivityLogDeps): ActivityLog {
  const now = deps.now ?? Date.now;
  return {
    record: async (entry) => {
      let document: ActivityLogDocument;
      try {
        const days = entry.category === 'error' ? deps.errorRetentionDays : deps.retentionDays;
        document = buildActivityDocument(entry, new Date(now()), days);
      } catch (error) {
        deps.logger.error('activity log entry rejected', {
          action: String(entry.action),
          category: String(entry.category),
          reason: error instanceof Error ? error.message : 'unknown',
        });
        return;
      }
      try {
        await deps.databases.common().collection<ActivityLogDocument>('activityLog').insertOne(document);
      } catch (error) {
        deps.logger.error('activity log write failed', { entry: loggable(document), error });
      }
    },
  };
}
