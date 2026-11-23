import type { ObjectId } from 'mongodb';
import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';

/** What a store read that carries credentials: the group, the place or the users (with their PIN); the company has none today: revisit when it does. */
export type ConfigurationResource = 'group' | 'place' | 'users';

/** The token of the counter for a request whose address is unknown. */
const NO_ADDRESS = 'unknown';

/** Seconds of the window of the throttle: one event per hour for a key and a resource. */
const HOUR_SECONDS = 3600;

/** Records that the server of a store read a configuration with credentials. */
export interface ConfigurationReadAudit {
  /**
   * Writes the security event `store.configurationRead`, at most once an hour for a key, a resource and a client address (a read from a new address is a new event; the counter `storeConfigurationRead:key`, the same mechanism as
   * `store.revokedKeyPresented`). It carries which resource was read and the ids of the company and the place, never a value of the configuration or the tag. It never rejects: a
   * failure of the counter is logged and the event is written anyway (the audit fails open, bounded by the rate limit of the key), and the write of the event is the activity log's own
   * (it never rejects either), so a read that succeeded stays a success.
   *
   * @param store The store principal.
   * @param client The request context.
   * @param resource Which configuration was read.
   * @param companyId The company the read actually used, when it is not the one of the principal (the users filter reads the place document); the principal's by default.
   */
  record(store: StorePrincipal, client: ClientContext, resource: ConfigurationResource, companyId?: ObjectId): Promise<void>;
}

/**
 * Builds the audit of the reads of the configuration.
 *
 * @param deps The activity log, the counters of the rate limits and the logger.
 */
export function createConfigurationReadAudit(deps: { readonly activityLog: ActivityLog; readonly rateLimiter: Pick<RateLimiter, 'consume'>; readonly logger: Logger }): ConfigurationReadAudit {
  const { activityLog, rateLimiter, logger } = deps;
  return {
    record: async (store, client, resource, companyId = store.companyId) => {
      const keyId = store.keyId.toHexString();
      const first = await rateLimiter.consume('storeConfigurationRead:key', `${keyId}:${resource}:${client.ip ?? NO_ADDRESS}`, 1, HOUR_SECONDS).then(
        (decision) => decision.allowed,
        (error: unknown) => {
          logger.error('counting the reads of the configuration of a store failed', { error });
          return true;
        },
      );
      if (first) {
        await activityLog.record({
          category: 'security',
          action: 'store.configurationRead',
          outcome: 'success',
          actor: { kind: 'store', id: store.keyId },
          groupId: store.groupId,
          resource: { type: 'storeKey', id: keyId },
          requestId: client.requestId,
          ...(client.ip === null ? {} : { ip: client.ip }),
          metadata: { resource, companyId: companyId.toHexString(), placeId: store.placeId.toHexString() },
        });
      }
    },
  };
}
