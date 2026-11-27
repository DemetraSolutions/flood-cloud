import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import { AppError } from '../../shared/http/errors.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';

const DAY_SECONDS = 86_400;

/** The limits of the invoices of a store key: how many it may create per minute (a `429` above) and how many in a UTC day before an alert is raised (nothing is refused). */
export interface InvoiceLimits {
  readonly perMinute: number;
  readonly perDay: number;
}

/** The budget and the alert of the invoices a store key creates: every invoice takes a number and may go to the send queue, so a key that makes them in a flood is stopped and a key that makes too many in a day is reported. */
export interface InvoiceGuard {
  /**
   * Counts one request to create an invoice of a store key in its minute (`RATE_LIMIT_STORE_INVOICES_PER_STORE`).
   *
   * @param store The store principal.
   * @throws {AppError} `RATE_LIMITED` (`429` with `Retry-After`) above the budget; a failure of the counter rejects too (fail closed).
   */
  admit(store: StorePrincipal): Promise<void>;
  /**
   * Counts an invoice a store key created in its UTC day and, when the day goes over `STORE_INVOICE_ALERT_PER_DAY`, writes the alert `store.invoiceAlert` once for the day (the counter is atomic). Never rejects: a failure is logged and the invoice stays created.
   *
   * @param store The store principal: the actor.
   * @param client The request context.
   */
  created(store: StorePrincipal, client: ClientContext): Promise<void>;
}

/**
 * Builds the guard of the invoices of the store keys.
 *
 * @param deps The counters of the rate limits, the activity log, the logger and the limits.
 */
export function createInvoiceGuard(deps: { readonly rateLimiter: Pick<RateLimiter, 'consume'>; readonly activityLog: ActivityLog; readonly logger: Logger; readonly limits: InvoiceLimits }): InvoiceGuard {
  const { rateLimiter, activityLog, logger, limits } = deps;
  return {
    admit: async (store) => {
      const decision = await rateLimiter.consume('storeInvoices:key', store.keyId.toHexString(), limits.perMinute);
      if (!decision.allowed) {
        throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': String(decision.resetSeconds) } });
      }
    },

    created: async (store, client) => {
      try {
        const day = await rateLimiter.consume('storeInvoiceDaily:key', store.keyId.toHexString(), limits.perDay, DAY_SECONDS);
        if (day.firstExcess) {
          await activityLog.record({
            category: 'security',
            action: 'store.invoiceAlert',
            outcome: 'success',
            actor: { kind: 'store', id: store.keyId },
            groupId: store.groupId,
            resource: { type: 'storeKey', id: store.keyId.toHexString() },
            requestId: client.requestId,
            ...(client.ip === null ? {} : { ip: client.ip }),
            metadata: { threshold: limits.perDay },
          });
        }
      } catch (error) {
        logger.error('writing the signal of the invoices of a store failed', { error });
      }
    },
  };
}
