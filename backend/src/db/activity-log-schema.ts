import { ACTIVITY_ACTION_NAMES, ACTIVITY_CATEGORIES, ACTIVITY_OUTCOMES, ACTOR_KINDS, ACTOR_ROLES } from '../shared/activity-log/catalog.ts';
import type { IndexSpec } from './collections.ts';

/** Indexes of `common.activityLog`: by group, by actor and by category (newest first), by request, and the TTL. */
export const ACTIVITY_LOG_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'groupId_1_at_-1', key: { groupId: 1, at: -1 } },
  { name: 'actor.id_1_at_-1', key: { 'actor.id': 1, at: -1 } },
  { name: 'category_1_at_-1', key: { category: 1, at: -1 } },
  { name: 'requestId_1', key: { requestId: 1 } },
  { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);

/**
 * `$jsonSchema` of `common.activityLog`: the shape the service writes, enforced by the database
 * as well (no unknown top-level field, closed enums, bounded strings).
 */
export const ACTIVITY_LOG_VALIDATOR: Readonly<Record<string, unknown>> = Object.freeze({
  bsonType: 'object',
  required: ['at', 'category', 'action', 'outcome', 'actor', 'expiresAt'],
  additionalProperties: false,
  properties: {
    _id: { bsonType: 'objectId' },
    at: { bsonType: 'date' },
    category: { enum: [...ACTIVITY_CATEGORIES] },
    action: { enum: [...ACTIVITY_ACTION_NAMES] },
    outcome: { enum: [...ACTIVITY_OUTCOMES] },
    actor: {
      bsonType: 'object',
      required: ['kind'],
      additionalProperties: false,
      // A user actor needs its id; anonymous and system actors have none.
      anyOf: [{ properties: { kind: { enum: ['anonymous', 'system'] } } }, { required: ['id'] }],
      properties: {
        kind: { enum: [...ACTOR_KINDS] },
        id: { bsonType: 'objectId' },
        role: { enum: [...ACTOR_ROLES] },
      },
    },
    groupId: { bsonType: 'objectId' },
    resource: {
      bsonType: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: {
        type: { bsonType: 'string', maxLength: 32 },
        id: { bsonType: 'string', maxLength: 64 },
      },
    },
    changes: {
      bsonType: 'array',
      maxItems: 200,
      items: {
        bsonType: 'object',
        required: ['field'],
        additionalProperties: false,
        properties: {
          field: { bsonType: 'string', maxLength: 256 },
          before: {},
          after: {},
          redacted: { bsonType: 'bool' },
          truncated: { bsonType: 'bool' },
        },
      },
    },
    requestId: { bsonType: 'string', maxLength: 128 },
    ip: { bsonType: 'string', maxLength: 64 },
    metadata: {
      bsonType: 'object',
      maxProperties: 20,
      additionalProperties: {
        anyOf: [{ bsonType: 'string', maxLength: 256 }, { bsonType: ['int', 'long', 'double', 'bool', 'null'] }],
      },
    },
    expiresAt: { bsonType: 'date' },
  },
});
