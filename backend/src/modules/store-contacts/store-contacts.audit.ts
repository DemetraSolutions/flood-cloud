import type { ActivityLog } from '../../shared/activity-log/activity-log.ts';
import type { ClientContext } from '../../shared/http/client-context.ts';
import type { Logger } from '../../shared/logging/logger.ts';
import type { RateLimiter } from '../../shared/security/rate-limit/rate-limiter.ts';
import type { StorePrincipal } from '../../shared/security/scope/principal.ts';
import type { StoreOperator } from '../product-catalog/caller.ts';

/** Seconds of the hour of the trace of the reads of the contacts and of the day of the sum of the credits. */
const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;

/** A limit no counter of reads reaches (the counter only adds; the limit is how its value is read back). */
const READ_COUNTER_LIMIT = 1_000_000_000;

/** Seconds a counter of the reads of an hour is kept (the counters of the rate limits live for the window they count in; this one is read back in the next hours, so its window is long). */
const READ_RETENTION_SECONDS = 30 * DAY_SECONDS;

/** How many hours back the first read of an hour looks for reads not yet written. */
const READ_LOOKBACK_HOURS = 24;

/** The limits at which a credit raises an alert, in currency units (`STORE_CREDIT_ALERT_PER_OPERATION` and `STORE_CREDIT_ALERT_PER_DAY`). */
export interface CreditAlertLimits {
  readonly perOperation: number;
  readonly perDay: number;
}

/**
 * The signals the server of a store raises with the contacts and the loyalty cards: they are alerts or traces, never a refusal, and the audit never rejects (a failure of a counter or of the log is logged and the request that
 * caused it stays a success, bounded by the rate limit of the key).
 */
export interface StoreContactsAudit {
  /**
   * Alert `store.creditAlert` when the credit a store key added to a card (the initial credit of a new card or a positive adjustment) is above the limit of one operation (`reason` `operation`) or takes the credits the key added in the
   * UTC day over the daily limit (`reason` `daily`, written once for the day: the counter is atomic and adds the cents of every positive credit). Nothing about a credit that is not positive.
   *
   * @param store The store principal: the actor.
   * @param operator The verified operator of the write.
   * @param client The request context.
   * @param cardId The card (hexadecimal).
   * @param amount The credit added, in currency units.
   */
  creditAdded(store: StorePrincipal, operator: StoreOperator, client: ClientContext, cardId: string, amount: number): Promise<void>;
  /**
   * Alert `store.advancedCardRelinked`: a store linked to a contact the code of an advanced card that other contacts already had.
   *
   * @param otherContacts How many other contacts had the code (at least one).
   */
  cardRelinked(store: StorePrincipal, operator: StoreOperator, client: ClientContext, contactId: string, cardId: string, otherContacts: number): Promise<void>;
  /**
   * Trace `store.contactsRead`, at most once an hour for a key: counts the contacts a read gave (one atomic counter per key and hour) and, at the first read of an hour, writes how many the key read in the hours before, up to
   * {@link READ_LOOKBACK_HOURS}, that no entry has told yet (normally the previous hour; nothing when it read none). The entry is written by the first read **after** the hour, so a key that reads and then stays silent is told by its
   * next read. Only the count: no contact, no name, no datum. The count of an hour is lost only if the hour falls across a 30 day boundary of the counters (once in 720 hours).
   *
   * @param count How many contacts the read gave.
   */
  contactsRead(store: StorePrincipal, client: ClientContext, count: number): Promise<void>;
}

/**
 * Builds the audit of the contacts and loyalty cards of a store.
 *
 * @param deps The activity log, the counters of the rate limits, the logger, the limits of the credit alerts and the clock in epoch milliseconds.
 */
export function createStoreContactsAudit(deps: { readonly activityLog: ActivityLog; readonly rateLimiter: Pick<RateLimiter, 'consume' | 'peek'>; readonly logger: Logger; readonly limits: CreditAlertLimits; readonly now: () => number }): StoreContactsAudit {
  const { activityLog, rateLimiter, logger, limits, now } = deps;
  const record = (store: StorePrincipal, client: ClientContext, action: 'store.creditAlert' | 'store.advancedCardRelinked' | 'store.contactsRead', metadata: Record<string, string | number>) =>
    activityLog.record({
      category: 'security',
      action,
      outcome: 'success',
      actor: { kind: 'store', id: store.keyId },
      groupId: store.groupId,
      resource: { type: 'storeKey', id: store.keyId.toHexString() },
      requestId: client.requestId,
      ...(client.ip === null ? {} : { ip: client.ip }),
      metadata,
    });
  /** Runs a signal so that it never rejects. */
  const guarded = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      logger.error(`writing the signal of ${what} of a store failed`, { error });
    }
  };
  return {
    creditAdded: (store, operator, client, cardId, amount) =>
      guarded('a credit', async () => {
        if (!(amount > 0)) {
          return;
        }
        const base = { amount, cardId, operatorId: operator.id.toHexString() };
        if (amount > limits.perOperation) {
          await record(store, client, 'store.creditAlert', { reason: 'operation', threshold: limits.perOperation, ...base });
        }
        const day = await rateLimiter.consume('storeCreditDaily:key', store.keyId.toHexString(), limits.perDay * 100, DAY_SECONDS, Math.round(amount * 100));
        if (day.firstExcess) {
          await record(store, client, 'store.creditAlert', { reason: 'daily', threshold: limits.perDay, ...base });
        }
      }),

    cardRelinked: (store, operator, client, contactId, cardId, otherContacts) =>
      guarded('a card code', () => record(store, client, 'store.advancedCardRelinked', { contactId, cardId, otherContacts, operatorId: operator.id.toHexString() })),

    contactsRead: (store, client, count) =>
      guarded('the contacts read', async () => {
        if (count === 0) {
          return;
        }
        const keyId = store.keyId.toHexString();
        const hour = Math.floor(now() / (HOUR_SECONDS * 1000));
        const at = (index: number) => `${keyId}:${String(index)}`;
        await rateLimiter.consume('storeContactsRead:count', at(hour), READ_COUNTER_LIMIT, READ_RETENTION_SECONDS, count);
        if (!(await rateLimiter.consume('storeContactsRead:hour', at(hour), 1, 2 * HOUR_SECONDS)).allowed) {
          return;
        }
        let told = 0;
        for (let back = 1; back <= READ_LOOKBACK_HOURS; back += 1) {
          const read = READ_COUNTER_LIMIT - (await rateLimiter.peek('storeContactsRead:count', at(hour - back), READ_COUNTER_LIMIT, READ_RETENTION_SECONDS)).remaining;
          if (read > 0 && (await rateLimiter.consume('storeContactsRead:told', at(hour - back), 1, READ_RETENTION_SECONDS)).allowed) {
            told += read;
          }
        }
        if (told > 0) {
          await record(store, client, 'store.contactsRead', { count: told, hour: new Date(hour * HOUR_SECONDS * 1000).toISOString() });
        }
      }),
  };
}
