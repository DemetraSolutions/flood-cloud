import { ACTION_CATALOG, ACTIVITY_CATEGORIES, ACTIVITY_OUTCOMES } from '../../shared/activity-log/catalog.ts';
import { MAX_CURSOR_LENGTH, MAX_LIMIT } from '../../shared/http/list.ts';
import { enumOf, integerString, isoDate, object, objectId, optional, string } from '../../shared/validation/schema.ts';
import type { Infer } from '../../shared/validation/schema.ts';

/**
 * Query of `GET /v1/activity-log`: the cursor parameters (`limit`, `cursor`; the order is fixed, so no
 * `sort` and no `q`) and the optional filters. Everything is validated and typed; nothing reaches the
 * database as the client wrote it.
 */
export const activityLogQuery = object({
  limit: optional(integerString({ min: 1, max: MAX_LIMIT })),
  cursor: optional(string({ min: 1, max: MAX_CURSOR_LENGTH, normalize: false })),
  category: optional(enumOf(ACTIVITY_CATEGORIES)),
  action: optional(enumOf([...ACTION_CATALOG.keys()])),
  /** `true` selects the alert actions the server defines (`ACTIVITY_ALERT_ACTIONS`); no other value. */
  alerts: optional(enumOf(['true'])),
  outcome: optional(enumOf(ACTIVITY_OUTCOMES)),
  actorId: optional(objectId()),
  groupId: optional(objectId()),
  requestId: optional(string({ min: 1, max: 128 })),
  from: optional(isoDate()),
  to: optional(isoDate()),
});

/** Validated query of the activity log list. */
export type ActivityLogQuery = Infer<typeof activityLogQuery>;

/** Query of `GET /v1/activity-log/alerts/count`: `since` is required (how far back it may go is checked by the service). */
export const activityAlertsCountQuery = object({ since: isoDate() });

/** Validated query of the alert count. */
export type ActivityAlertsCountQuery = Infer<typeof activityAlertsCountQuery>;
