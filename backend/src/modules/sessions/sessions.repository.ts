import type { ClientSession, Collection, ObjectId } from 'mongodb';
import { MAX_PREVIOUS_REFRESH_HASHES } from '../../db/sessions-schema.ts';
import type { Databases } from '../../db/databases.ts';

/** Most sessions listed for one user. */
export const MAX_LISTED_SESSIONS = 50;

/** Milliseconds a revoked or expired session document is kept after the end of its family, so recent revocations stay visible. */
const RETENTION_AFTER_FAMILY_MS = 86_400_000;

/** Minimum interval between two updates of `lastUsedAt`, in milliseconds. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** A session family: the current token pair of one login and its lifetime. Hashes only, never tokens. */
export interface Session {
  /** Id of the session, the one exposed to clients. */
  readonly id: ObjectId;
  readonly userId: ObjectId;
  readonly accessTokenHash: string;
  readonly accessExpiresAt: Date;
  readonly refreshTokenHash: string;
  /** End of the refresh token validity for inactivity. */
  readonly refreshExpiresAt: Date;
  /** End of the family: the maximum duration of a session. */
  readonly familyExpiresAt: Date;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  /** When the token pair was last rotated, `null` for a session never refreshed. */
  readonly rotatedAt: Date | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
}

/** Input of {@link SessionsRepository.create}. */
export interface NewSession {
  readonly userId: ObjectId;
  readonly accessTokenHash: string;
  readonly accessExpiresAt: Date;
  readonly refreshTokenHash: string;
  readonly refreshExpiresAt: Date;
  readonly familyExpiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly now: Date;
}

/** The new token pair of a rotation. */
export interface Rotation {
  readonly accessTokenHash: string;
  readonly accessExpiresAt: Date;
  readonly refreshTokenHash: string;
  readonly refreshExpiresAt: Date;
  readonly now: Date;
}

/** What {@link SessionsRepository.findByRefreshHash} found. */
export type RefreshLookup =
  | { readonly kind: 'current'; readonly session: Session }
  /** The hash is one that was already rotated: the token was used before. */
  | {
      readonly kind: 'rotated';
      readonly session: Session;
      /** True when the hash is the most recently rotated one: the previous token of the current pair. */
      readonly latest: boolean;
    };

/** The sessions of the backoffice users (`common.sessions`). */
export interface SessionsRepository {
  /**
   * Stores a new session family.
   *
   * @param input Token hashes, lifetimes and client data.
   * @returns The stored session.
   */
  create(input: NewSession): Promise<Session>;
  /**
   * @param hash SHA-256 of an access token.
   * @returns The session whose current access token it is, or `null`.
   */
  findByAccessHash(hash: string): Promise<Session | null>;
  /**
   * @param hash SHA-256 of a refresh token.
   * @returns The session it belongs to, told apart as current or already rotated (and, for a rotated one, whether it is the latest); `null` if unknown.
   */
  findByRefreshHash(hash: string): Promise<RefreshLookup | null>;
  /**
   * Rotates the token pair atomically: it succeeds only if the session is not revoked and
   * `currentRefreshHash` is still its current refresh hash, which moves into `previousRefreshHashes`
   * (the last {@link MAX_PREVIOUS_REFRESH_HASHES} are kept).
   *
   * @param id Session id.
   * @param currentRefreshHash Hash the caller presented.
   * @param next The new pair.
   * @returns The updated session, or `null` when the condition did not hold (the token was just used by another request).
   */
  rotate(id: ObjectId, currentRefreshHash: string, next: Rotation): Promise<Session | null>;
  /**
   * Revokes one session family.
   *
   * @param id Session id.
   * @param reason Short reason code, kept with the revocation.
   * @param now Revocation time.
   * @returns `false` when it did not exist or was already revoked.
   */
  revoke(id: ObjectId, reason: string, now: Date): Promise<boolean>;
  /**
   * Revokes one session of a user, only if it is his.
   *
   * @param userId Owner.
   * @param id Session id.
   * @param reason Reason code.
   * @param now Revocation time.
   * @returns `false` when it does not exist, is not the user's or was already revoked.
   */
  revokeOwned(userId: ObjectId, id: ObjectId, reason: string, now: Date): Promise<boolean>;
  /**
   * Revokes every active session of a user.
   *
   * @param userId Owner.
   * @param reason Reason code.
   * @param now Revocation time.
   * @param except A session to keep (the current one when the password changes).
   * @param session Transaction the write belongs to, if any.
   * @returns How many sessions were revoked.
   */
  revokeAllOfUser(userId: ObjectId, reason: string, now: Date, except?: ObjectId, session?: ClientSession): Promise<number>;
  /**
   * Deletes every session document of a user, revoked or not (permanent deletion of the user).
   *
   * @param userId Owner.
   * @param session Transaction the write belongs to, if any.
   * @returns How many documents were deleted.
   */
  deleteAllOfUser(userId: ObjectId, session?: ClientSession): Promise<number>;
  /**
   * The active sessions of a user (not revoked, not over), most recently used first.
   *
   * @param userId Owner.
   * @param now Current time.
   * @returns At most {@link MAX_LISTED_SESSIONS} sessions.
   */
  listActive(userId: ObjectId, now: Date): Promise<readonly Session[]>;
  /**
   * Sets `lastUsedAt`, but only if the stored value is at least {@link LAST_USED_RESOLUTION_MS} old
   * (the condition is in the database, so concurrent requests write once).
   *
   * @param id Session id.
   * @param now Current time.
   */
  touch(id: ObjectId, now: Date): Promise<void>;
}

interface SessionDocument {
  _id: ObjectId;
  userId: ObjectId;
  accessTokenHash: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  previousRefreshHashes: string[];
  refreshExpiresAt: Date;
  familyExpiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date;
  rotatedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  expiresAt: Date;
}

const toSession = (document: SessionDocument): Session => ({
  id: document._id,
  userId: document.userId,
  accessTokenHash: document.accessTokenHash,
  accessExpiresAt: document.accessExpiresAt,
  refreshTokenHash: document.refreshTokenHash,
  refreshExpiresAt: document.refreshExpiresAt,
  familyExpiresAt: document.familyExpiresAt,
  createdAt: document.createdAt,
  lastUsedAt: document.lastUsedAt,
  rotatedAt: document.rotatedAt,
  userAgent: document.userAgent,
  ip: document.ip,
  revokedAt: document.revokedAt,
  revokeReason: document.revokeReason,
});

/**
 * Builds the sessions repository over `common.sessions`. The previous refresh hashes never leave it.
 *
 * @param databases Database accessor.
 */
export function createSessionsRepository(databases: Databases): SessionsRepository {
  const sessions = (): Collection<SessionDocument> => databases.common().collection<SessionDocument>('sessions');
  const active = { revokedAt: null } as const;

  return {
    create: async (input) => {
      const document: Omit<SessionDocument, '_id'> = {
        userId: input.userId,
        accessTokenHash: input.accessTokenHash,
        accessExpiresAt: input.accessExpiresAt,
        refreshTokenHash: input.refreshTokenHash,
        previousRefreshHashes: [],
        refreshExpiresAt: input.refreshExpiresAt,
        familyExpiresAt: input.familyExpiresAt,
        createdAt: input.now,
        lastUsedAt: input.now,
        rotatedAt: null,
        userAgent: input.userAgent,
        ip: input.ip,
        revokedAt: null,
        revokeReason: null,
        expiresAt: new Date(input.familyExpiresAt.getTime() + RETENTION_AFTER_FAMILY_MS),
      };
      const { insertedId } = await sessions().insertOne(document as SessionDocument);
      return toSession({ ...document, _id: insertedId });
    },

    findByAccessHash: async (hash) => {
      const document = await sessions().findOne({ accessTokenHash: hash }, { projection: { previousRefreshHashes: 0 } });
      return document === null ? null : toSession(document);
    },

    findByRefreshHash: async (hash) => {
      const document = await sessions().findOne({ $or: [{ refreshTokenHash: hash }, { previousRefreshHashes: hash }] });
      if (document === null) {
        return null;
      }
      return document.refreshTokenHash === hash
        ? { kind: 'current', session: toSession(document) }
        : { kind: 'rotated', session: toSession(document), latest: document.previousRefreshHashes.at(-1) === hash };
    },

    rotate: async (id, currentRefreshHash, next) => {
      const updated = await sessions().findOneAndUpdate(
        { _id: id, refreshTokenHash: currentRefreshHash, ...active },
        {
          $set: {
            accessTokenHash: next.accessTokenHash,
            accessExpiresAt: next.accessExpiresAt,
            refreshTokenHash: next.refreshTokenHash,
            refreshExpiresAt: next.refreshExpiresAt,
            lastUsedAt: next.now,
            rotatedAt: next.now,
          },
          $push: { previousRefreshHashes: { $each: [currentRefreshHash], $slice: -MAX_PREVIOUS_REFRESH_HASHES } },
        },
        { returnDocument: 'after', projection: { previousRefreshHashes: 0 } },
      );
      return updated === null ? null : toSession(updated);
    },

    revoke: async (id, reason, now) => {
      const result = await sessions().updateOne({ _id: id, ...active }, { $set: { revokedAt: now, revokeReason: reason } });
      return result.modifiedCount === 1;
    },

    revokeOwned: async (userId, id, reason, now) => {
      const result = await sessions().updateOne({ _id: id, userId, ...active }, { $set: { revokedAt: now, revokeReason: reason } });
      return result.modifiedCount === 1;
    },

    revokeAllOfUser: async (userId, reason, now, except, session) => {
      const result = await sessions().updateMany(
        { userId, ...active, ...(except === undefined ? {} : { _id: { $ne: except } }) },
        { $set: { revokedAt: now, revokeReason: reason } },
        session === undefined ? {} : { session },
      );
      return result.modifiedCount;
    },

    deleteAllOfUser: async (userId, session) => {
      const result = await sessions().deleteMany({ userId }, session === undefined ? {} : { session });
      return result.deletedCount;
    },

    listActive: async (userId, now) => {
      const documents = await sessions()
        .find({ userId, ...active, familyExpiresAt: { $gt: now }, refreshExpiresAt: { $gt: now } }, { projection: { previousRefreshHashes: 0 }, sort: { lastUsedAt: -1 }, limit: MAX_LISTED_SESSIONS })
        .toArray();
      return documents.map(toSession);
    },

    touch: async (id, now) => {
      await sessions().updateOne({ _id: id, lastUsedAt: { $lte: new Date(now.getTime() - LAST_USED_RESOLUTION_MS) } }, { $set: { lastUsedAt: now } });
    },
  };
}
