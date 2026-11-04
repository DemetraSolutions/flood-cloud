import type { Collection, ObjectId } from 'mongodb';
import type { Databases } from '../../db/databases.ts';

/** Failed logins in a row after which the account starts to be locked. */
export const LOCK_THRESHOLD = 5;

/** Longest lock, in minutes. */
export const MAX_LOCK_MINUTES = 15;

const MINUTE_MS = 60_000;

/** The credential data of a user that is not in the legacy document (`common.userCredentials`). */
export interface UserCredentials {
  readonly userId: ObjectId;
  /** scrypt hash, `null` until the first login that computes it. */
  readonly passwordHash: string | null;
  /** Fingerprint of the legacy hash it was computed from, `null` when it comes from a password change. */
  readonly legacyHashFingerprint: string | null;
  readonly passwordChangedAt: Date | null;
  /** Consecutive failed logins. */
  readonly failedLogins: number;
  /** End of the current lock, `null` when not locked. */
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Outcome of {@link CredentialsRepository.recordFailure}. */
export interface FailureOutcome {
  readonly failedLogins: number;
  readonly lockedUntil: Date | null;
}

/** Input of {@link CredentialsRepository.upsertPassword}. */
export interface PasswordUpsert {
  /** The scrypt hash to store. */
  readonly passwordHash: string;
  /** Fingerprint of the legacy hash the scrypt hash was derived from, or `null`. */
  readonly legacyHashFingerprint: string | null;
  /** `true` for a real password change (sets `passwordChangedAt`), `false` for a rehash at login. */
  readonly passwordChanged: boolean;
  readonly now: Date;
}

/** Credentials of the users, one document per user keyed by the user id. */
export interface CredentialsRepository {
  /**
   * Reads the credentials of a user.
   *
   * @param userId Id of the user.
   * @returns The credentials, or `null` when the user has none yet.
   */
  find(userId: ObjectId): Promise<UserCredentials | null>;
  /**
   * Stores a password hash, creating the document if needed. Failure counters are left alone.
   *
   * @param userId Id of the user.
   * @param input The hash and what it derives from.
   */
  upsertPassword(userId: ObjectId, input: PasswordUpsert): Promise<void>;
  /**
   * Records a failed login atomically: increments the counter and, from the fifth consecutive
   * failure, locks the account for 2^(n-5) minutes (1, 2, 4, 8, then at most 15).
   *
   * @param userId Id of the user.
   * @param now Current time.
   * @returns The counter and the end of the lock after this failure.
   */
  recordFailure(userId: ObjectId, now: Date): Promise<FailureOutcome>;
  /**
   * Records a successful login: clears the counter and the lock and sets `lastLoginAt`.
   *
   * @param userId Id of the user.
   * @param now Current time.
   */
  recordSuccess(userId: ObjectId, now: Date): Promise<void>;
}

interface CredentialsDocument {
  _id: ObjectId;
  passwordHash?: string;
  legacyHashFingerprint?: string | null;
  passwordChangedAt?: Date;
  failedLogins: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Builds the credentials repository over `common.userCredentials`. The collection is only ever
 * addressed by `_id`, so it needs no index of its own.
 *
 * @param databases Database accessor.
 */
export function createCredentialsRepository(databases: Databases): CredentialsRepository {
  const credentials = (): Collection<CredentialsDocument> => databases.common().collection<CredentialsDocument>('userCredentials');

  return {
    find: async (userId) => {
      const document = await credentials().findOne({ _id: userId });
      return document === null
        ? null
        : {
            userId: document._id,
            passwordHash: document.passwordHash ?? null,
            legacyHashFingerprint: document.legacyHashFingerprint ?? null,
            passwordChangedAt: document.passwordChangedAt ?? null,
            failedLogins: document.failedLogins,
            lockedUntil: document.lockedUntil ?? null,
            lastLoginAt: document.lastLoginAt ?? null,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
          };
    },

    upsertPassword: async (userId, { passwordHash, legacyHashFingerprint, passwordChanged, now }) => {
      await credentials().updateOne(
        { _id: userId },
        {
          $set: { passwordHash, legacyHashFingerprint, updatedAt: now, ...(passwordChanged ? { passwordChangedAt: now } : {}) },
          $setOnInsert: { createdAt: now, failedLogins: 0 },
        },
        { upsert: true },
      );
    },

    recordFailure: async (userId, now) => {
      // One pipeline update: the increment and the lock computed from the new value cannot interleave
      // with a concurrent failure.
      const updated = await credentials().findOneAndUpdate(
        { _id: userId },
        [
          { $set: { failedLogins: { $add: [{ $ifNull: ['$failedLogins', 0] }, 1] }, createdAt: { $ifNull: ['$createdAt', now] }, updatedAt: now } },
          {
            $set: {
              lockedUntil: {
                $cond: [
                  { $gte: ['$failedLogins', LOCK_THRESHOLD] },
                  {
                    $add: [
                      now,
                      { $toLong: { $multiply: [MINUTE_MS, { $min: [MAX_LOCK_MINUTES, { $pow: [2, { $subtract: ['$failedLogins', LOCK_THRESHOLD] }] }] }] } },
                    ],
                  },
                  null,
                ],
              },
            },
          },
        ],
        { upsert: true, returnDocument: 'after', projection: { failedLogins: 1, lockedUntil: 1 } },
      );
      // The upsert guarantees a document.
      return { failedLogins: updated!.failedLogins, lockedUntil: updated!.lockedUntil ?? null };
    },

    recordSuccess: async (userId, now) => {
      await credentials().updateOne(
        { _id: userId },
        { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    },
  };
}
