import type { IndexSpec } from './collections.ts';

/**
 * Indexes of `common.activityEvents`: newest first with `_id` as the tie-breaker (the order of the monitor, so no
 * blocking sort is needed), alone and by group, by actor and by category; by request; and the TTL.
 *
 * Every entry is checked by the application before the insert (`buildActivityDocument`: closed action, category,
 * outcome, actor kind and role, bounded lengths).
 */
export const ACTIVITY_EVENTS_INDEXES: readonly IndexSpec[] = Object.freeze([
  { name: 'at_-1__id_-1', key: { at: -1, _id: -1 } },
  { name: 'groupId_1_at_-1__id_-1', key: { groupId: 1, at: -1, _id: -1 } },
  { name: 'actor.id_1_at_-1__id_-1', key: { 'actor.id': 1, at: -1, _id: -1 } },
  { name: 'category_1_at_-1__id_-1', key: { category: 1, at: -1, _id: -1 } },
  { name: 'requestId_1', key: { requestId: 1 } },
  { name: 'expiresAt_1', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
]);
