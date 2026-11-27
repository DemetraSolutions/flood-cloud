import { MongoServerError } from 'mongodb';
import type { Collection, Document } from 'mongodb';
import type { Databases } from '../../db/databases.ts';
import { LIST_MAX_TIME_MS } from '../../shared/http/list.ts';
import type { ObjectId } from 'mongodb';
import type { AccountTarget, ArubaAccount } from './aruba-account.ts';

/** The key of the integrations settings of the platform in `common.settings`. */
export const INTEGRATIONS_KEY = 'INTEGRATIONS';

/** Case-insensitive comparison of user names (the names are printable ASCII, so `en` strength 2 is exact); a query option, no index involved. */
const CASE_INSENSITIVE = { locale: 'en', strength: 2 } as const;

/** MongoDB's duplicate key error code: a second document with the same `key`. */
const DUPLICATE_KEY = 11000;

/** What a read of an account found. */
export interface AccountRead {
  /** The value stored under `aruba`, exactly as the database holds it; `undefined` when there is none. */
  readonly raw: unknown;
  /** Whether the document that holds the account exists (always for a dealer that was found; for the platform once any integration setting was saved). */
  readonly exists: boolean;
}

/** Reads and writes the Aruba accounts: `common.dealers.<id>.integrations.aruba` and `common.settings` (`INTEGRATIONS`, `value.aruba`). Only that key is ever set or unset. */
export interface EInvoicingAccountsRepository {
  /**
   * Reads an account as stored (one read, `maxTimeMS`).
   *
   * @param target The account.
   * @returns `null` when the dealer does not exist; otherwise what was found.
   */
  read(target: AccountTarget): Promise<AccountRead | null>;
  /**
   * Saves an account, only if it is still the one that was read: an account saved meanwhile is never overwritten. When the platform document does not exist it is inserted and its unique key decides between two saves at once.
   *
   * @param target The account.
   * @param read What {@link read} returned.
   * @param next The whole new account.
   * @returns Whether the account was still as read.
   */
  replace(target: AccountTarget, read: AccountRead, next: ArubaAccount): Promise<boolean>;
  /**
   * Removes an account (`$unset`), only if it is still the one that was read.
   *
   * @param target The account.
   * @param read What {@link read} returned.
   * @param by The administrator (stamped on the platform document).
   * @param at Time of the change.
   * @returns Whether the account was still as read.
   */
  remove(target: AccountTarget, read: AccountRead, by: ObjectId, at: Date): Promise<boolean>;
  /**
   * Tells whether an Aruba user name is already used by another account, a dealer's or the platform's.
   *
   * @param username The user name; the comparison ignores the case (`Mario` and `mario` are the same name).
   * @param except The account being saved, which may keep its own name.
   */
  isUsernameTaken(username: string, except: AccountTarget): Promise<boolean>;
}

/**
 * Builds the repository of the Aruba accounts over `common.dealers` and `common.settings`.
 *
 * @param databases Database accessor.
 */
export function createEInvoicingAccountsRepository(databases: Databases): EInvoicingAccountsRepository {
  const dealers = (): Collection<Document> => databases.common().collection('dealers');
  const settings = (): Collection<Document> => databases.common().collection('settings');
  /** The guard of a write: the value that was read, or its absence. */
  const guardOf = (read: AccountRead): unknown => (read.raw === undefined ? { $exists: false } : read.raw);
  return {
    read: async (target) => {
      if (target.kind === 'dealer') {
        const document = await dealers().findOne({ _id: target.dealerId }, { projection: { 'integrations.aruba': 1 }, maxTimeMS: LIST_MAX_TIME_MS });
        return document === null ? null : { raw: (document['integrations'] as { aruba?: unknown } | undefined)?.aruba, exists: true };
      }
      const document = await settings().findOne({ key: INTEGRATIONS_KEY }, { projection: { 'value.aruba': 1 }, maxTimeMS: LIST_MAX_TIME_MS });
      return { raw: (document?.['value'] as { aruba?: unknown } | undefined)?.aruba, exists: document !== null };
    },

    replace: async (target, read, next) => {
      if (target.kind === 'dealer') {
        return (await dealers().updateOne({ _id: target.dealerId, 'integrations.aruba': guardOf(read) }, { $set: { 'integrations.aruba': next } })).matchedCount === 1;
      }
      if (!read.exists) {
        try {
          await settings().insertOne({ key: INTEGRATIONS_KEY, value: { aruba: next }, updatedAt: next.updatedAt, updatedBy: next.updatedBy });
          return true;
        } catch (error) {
          if (error instanceof MongoServerError && error.code === DUPLICATE_KEY) {
            return false;
          }
          throw error;
        }
      }
      return (await settings().updateOne({ key: INTEGRATIONS_KEY, 'value.aruba': guardOf(read) }, { $set: { 'value.aruba': next, updatedAt: next.updatedAt, updatedBy: next.updatedBy } })).matchedCount === 1;
    },

    remove: async (target, read, by, at) =>
      target.kind === 'dealer'
        ? (await dealers().updateOne({ _id: target.dealerId, 'integrations.aruba': guardOf(read) }, { $unset: { 'integrations.aruba': '' } })).matchedCount === 1
        : (await settings().updateOne({ key: INTEGRATIONS_KEY, 'value.aruba': guardOf(read) }, { $unset: { 'value.aruba': '' }, $set: { updatedAt: at, updatedBy: by } })).matchedCount === 1,

    isUsernameTaken: async (username, except) => {
      const otherDealer = await dealers().findOne({ 'integrations.aruba.username': username, ...(except.kind === 'dealer' ? { _id: { $ne: except.dealerId } } : {}) }, { projection: { _id: 1 }, collation: CASE_INSENSITIVE, maxTimeMS: LIST_MAX_TIME_MS });
      if (otherDealer !== null) {
        return true;
      }
      return except.kind === 'dealer' && (await settings().findOne({ key: INTEGRATIONS_KEY, 'value.aruba.username': username }, { projection: { _id: 1 }, collation: CASE_INSENSITIVE, maxTimeMS: LIST_MAX_TIME_MS })) !== null;
    },
  };
}
