import type { ObjectId } from 'mongodb';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';

/** Why the operator of a write was refused: the header is missing or malformed, no such user in the set the store may read (unknown, trashed, of another place or role: one reason, they are told apart by nobody), disabled, or without the write permission on the products. */
export type OperatorRejection = 'missing' | 'malformed' | 'notFound' | 'disabled' | 'noPermission';

/** The token of the counter for a request whose address is unknown. */
const NO_ADDRESS = 'unknown';

/** Seconds of the window of the throttle: one event per hour for a key and a client address. */
const HOUR_SECONDS = 3600;

/** Records that the server of a store sent a write without a usable operator. */
export interface OperatorAudit {
  /**
   * Writes the security event `store.operatorRejected`, at most once an hour for a key and a client address (the counter `storeOperatorRejected:key`, the same mechanism as `store.configurationRead`). It
   * carries the reason and the id the store declared when it was well formed, never anything about the user it names. It never rejects: a failure of the counter is logged and the event is written anyway
   * (bounded by the rate limit of the key), and the write of the event is the activity log's own.
   *
   * @param store The store principal: the actor is the store, never the operator it declared.
   * @param client The request context.
   * @param reason Why the operator was refused.
   * @param declared The operator id the store sent, when it was well formed.
   */
  rejected(store: StorePrincipal, client: ClientContext, reason: OperatorRejection, declared: ObjectId | null): Promise<void>;
}

/**
 * Builds the audit of the refused operators.
 *
 * @param deps The activity log, the counters of the rate limits and the logger.
 */
export function createOperatorAudit(deps: { readonly activityLog: ActivityLog; readonly rateLimiter: Pick<RateLimiter, 'consume'>; readonly logger: Logger }): OperatorAudit {
  const { activityLog, rateLimiter, logger } = deps;
  return {
    rejected: async (store, client, reason, declared) => {
      const keyId = store.keyId.toHexString();
      const first = await rateLimiter.consume('storeOperatorRejected:key', `${keyId}:${client.ip ?? NO_ADDRESS}`, 1, HOUR_SECONDS).then(
        (decision) => decision.allowed,
        (error: unknown) => {
          logger.error('counting the refused operators of a store failed', { error });
          return true;
        },
      );
      if (first) {
        await activityLog.record({
          category: 'security',
          action: 'store.operatorRejected',
          outcome: 'denied',
          actor: { kind: 'store', id: store.keyId },
          groupId: store.groupId,
          resource: { type: 'storeKey', id: keyId },
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
          metadata: { reason, ...(declared === null ? {} : { operatorId: declared.toHexString() }) },
        });
      }
    },
  };
}
