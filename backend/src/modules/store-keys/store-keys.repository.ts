import type { ClientSession, Collection, ObjectId } from 'mongodb';
import { REVOKED_STORE_KEY_RETENTION_DAYS } from '../../db/store-keys-schema.ts';
import type { Databases } from '../../db/databases.ts';
import type {
  ConsumedActivation,
  Installation,
  KeyIssuer,
  NewActivationCode,
  NewStoreKey,
  PendingActivation,
  Revocation,
  Revoker,
  RevokeReason,
  RevokedSummary,
  StoreKey,
} from './store-keys.types.ts';

/** Minimum interval between two updates of `lastSeenAt`, in milliseconds. */
export const LAST_SEEN_RESOLUTION_MS = 60_000;

const DAY_MS = 86_400_000;

/** The stored store key: the hash is kept, and never leaves the repository. */
interface StoreKeyDocument {
  _id: ObjectId;
  groupId: ObjectId;
  placeId: ObjectId;
  keyHash: string;
  keyHint: string;
  status: 'active' | 'revoked';
  activatedAt: Date;
  activatedBy: KeyIssuer;
  installation: Installation;
  activationIp: string | null;
  lastSeenAt: Date;
  lastSeenIp: string | null;
  lastSeenUserAgent: string | null;
  revokedAt: Date | null;
  revokedBy: Revoker | null;
  revokeReason: RevokeReason | null;
  purgeAt?: Date;
}

/** The stored activation code: the hash of the code, never the code. */
interface ActivationCodeDocument {
  _id: ObjectId;
  groupId: ObjectId;
  companyId: ObjectId;
  placeId: ObjectId;
  codeHash: string;
  createdBy: KeyIssuer;
  createdAt: Date;
  expiresAt: Date;
}

const toStoreKey = (document: StoreKeyDocument): StoreKey => ({
  id: document._id,
  groupId: document.groupId,
  placeId: document.placeId,
  hint: document.keyHint,
  status: document.status,
  activatedAt: document.activatedAt,
  activatedBy: document.activatedBy,
  installation: document.installation,
  activationIp: document.activationIp,
  lastSeenAt: document.lastSeenAt,
  lastSeenIp: document.lastSeenIp,
  lastSeenUserAgent: document.lastSeenUserAgent,
  revokedAt: document.revokedAt,
  revokedBy: document.revokedBy,
  revokeReason: document.revokeReason,
});

/** The store keys and the activation codes of the points of sale (`common.storeKeys`, `common.storeActivationCodes`). The only code that reads or writes them. */
export interface StoreKeysRepository {
  /**
   * Replaces the pending activation code of a place with a new one (at most one per place).
   *
   * @param code The new code (its hash).
   */
  replaceActivationCode(code: NewActivationCode): Promise<void>;
  /**
   * The activation code of a place that can still be exchanged.
   *
   * @param groupId Id of the group.
   * @param placeId Id of the place.
   * @param now Current time: an expired code that the TTL has not removed yet is not pending.
   * @returns Who made it and when it expires, or `null`.
   */
  findPendingActivation(groupId: ObjectId, placeId: ObjectId, now: Date): Promise<PendingActivation | null>;
  /**
   * Deletes the pending activation code of a place.
   *
   * @param groupId Id of the group.
   * @param placeId Id of the place.
   * @returns `false` when there was none.
   */
  deleteActivationCode(groupId: ObjectId, placeId: ObjectId): Promise<boolean>;
  /**
   * Consumes an activation code: finds it by its hash while it has not expired, and deletes it, in one atomic operation (of two concurrent exchanges, one wins).
   *
   * @param codeHash SHA-256 of the normalized code.
   * @param now Current time.
   * @param session The transaction of the exchange.
   * @returns The place it was for and who made it, or `null`.
   */
  consumeActivationCode(codeHash: string, now: Date, session: ClientSession): Promise<ConsumedActivation | null>;
  /**
   * Stores a new active key.
   *
   * @param key The key (its hash).
   * @param session The transaction of the exchange.
   * @returns The stored key.
   * @throws {Error} With code 11000 if the place already has an active key (the exchange revokes the old one first).
   */
  createKey(key: NewStoreKey, session: ClientSession): Promise<StoreKey>;
  /**
   * @param keyHash SHA-256 of a presented key.
   * @returns The key, active or revoked, or `null` when no key has this hash.
   */
  findByHash(keyHash: string): Promise<StoreKey | null>;
  /**
   * @param groupId Id of the group.
   * @param placeId Id of the place.
   * @returns Its active key, or `null`.
   */
  findActiveOfPlace(groupId: ObjectId, placeId: ObjectId): Promise<StoreKey | null>;
  /**
   * @param groupId Id of the group.
   * @param placeId Id of the place.
   * @returns When and why its most recently activated key that is revoked ended, or `null`.
   */
  findLastRevokedOfPlace(groupId: ObjectId, placeId: ObjectId): Promise<RevokedSummary | null>;
  /**
   * Revokes the active key of a place, in one conditional update: a key that is not active is left alone, so a revocation is never recorded twice.
   *
   * @param groupId Id of the group.
   * @param placeId Id of the place.
   * @param revocation When, by whom and why.
   * @param session The transaction, if the revocation belongs to one.
   * @returns The key as it was, or `null` when the place had no active key.
   */
  revokeActiveOfPlace(groupId: ObjectId, placeId: ObjectId, revocation: Revocation, session?: ClientSession): Promise<StoreKey | null>;
  /**
   * Revokes one key (the one a request presented), if it is still active.
   *
   * @param id Id of the key.
   * @param revocation When, by whom and why.
   * @returns The key as it was, or `null` when it was not active.
   */
  revokeKey(id: ObjectId, revocation: Revocation): Promise<StoreKey | null>;
  /**
   * Records that a key was seen, but only if the stored time is at least {@link LAST_SEEN_RESOLUTION_MS} old (the condition is in the database, so concurrent requests write once).
   *
   * @param id Id of the key.
   * @param seen Time, address and user agent of the request.
   */
  touch(id: ObjectId, seen: { readonly at: Date; readonly ip: string | null; readonly userAgent: string | null }): Promise<void>;
}

/**
 * Builds the repository of the store keys.
 *
 * @param databases Database accessor.
 */
export function createStoreKeysRepository(databases: Databases): StoreKeysRepository {
  const keys = (): Collection<StoreKeyDocument> => databases.common().collection<StoreKeyDocument>('storeKeys');
  const codes = (): Collection<ActivationCodeDocument> => databases.common().collection<ActivationCodeDocument>('storeActivationCodes');
  const revoked = (revocation: Revocation) => ({
    $set: {
      status: 'revoked' as const,
      revokedAt: revocation.at,
      revokedBy: revocation.by,
      revokeReason: revocation.reason,
      purgeAt: new Date(revocation.at.getTime() + REVOKED_STORE_KEY_RETENTION_DAYS * DAY_MS),
    },
  });

  return {
    replaceActivationCode: async (code) => {
      await codes().replaceOne({ placeId: code.placeId }, { ...code }, { upsert: true });
    },

    findPendingActivation: async (groupId, placeId, now) => {
      const code = await codes().findOne({ groupId, placeId, expiresAt: { $gt: now } }, { projection: { createdAt: 1, expiresAt: 1, createdBy: 1 } });
      return code === null ? null : { createdAt: code.createdAt, expiresAt: code.expiresAt, createdBy: code.createdBy };
    },

    deleteActivationCode: async (groupId, placeId) => (await codes().deleteOne({ groupId, placeId })).deletedCount === 1,

    consumeActivationCode: async (codeHash, now, session) => {
      const code = await codes().findOneAndDelete({ codeHash, expiresAt: { $gt: now } }, { session, projection: { groupId: 1, placeId: 1, createdBy: 1 } });
      return code === null ? null : { groupId: code.groupId, placeId: code.placeId, createdBy: code.createdBy };
    },

    createKey: async (key, session) => {
      const document: Omit<StoreKeyDocument, '_id'> = {
        groupId: key.groupId,
        placeId: key.placeId,
        keyHash: key.keyHash,
        keyHint: key.hint,
        status: 'active',
        activatedAt: key.activatedAt,
        activatedBy: key.activatedBy,
        installation: key.installation,
        activationIp: key.activationIp,
        lastSeenAt: key.activatedAt,
        lastSeenIp: key.activationIp,
        lastSeenUserAgent: key.installation.userAgent,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      };
      const { insertedId } = await keys().insertOne(document as StoreKeyDocument, { session });
      return toStoreKey({ ...document, _id: insertedId });
    },

    findByHash: async (keyHash) => {
      const document = await keys().findOne({ keyHash });
      return document === null ? null : toStoreKey(document);
    },

    findActiveOfPlace: async (groupId, placeId) => {
      const document = await keys().findOne({ groupId, placeId, status: 'active' });
      return document === null ? null : toStoreKey(document);
    },

    findLastRevokedOfPlace: async (groupId, placeId) => {
      const document = await keys().findOne({ groupId, placeId, status: 'revoked' }, { sort: { activatedAt: -1 }, projection: { revokedAt: 1, revokeReason: 1 } });
      return document === null ? null : { revokedAt: document.revokedAt!, reason: document.revokeReason! };
    },

    revokeActiveOfPlace: async (groupId, placeId, revocation, session) => {
      const before = await keys().findOneAndUpdate({ groupId, placeId, status: 'active' }, revoked(revocation), { returnDocument: 'before', ...(session === undefined ? {} : { session }) });
      return before === null ? null : toStoreKey(before);
    },

    revokeKey: async (id, revocation) => {
      const before = await keys().findOneAndUpdate({ _id: id, status: 'active' }, revoked(revocation), { returnDocument: 'before' });
      return before === null ? null : toStoreKey(before);
    },

    touch: async (id, seen) => {
      await keys().updateOne(
        { _id: id, status: 'active', lastSeenAt: { $lte: new Date(seen.at.getTime() - LAST_SEEN_RESOLUTION_MS) } },
        { $set: { lastSeenAt: seen.at, lastSeenIp: seen.ip, lastSeenUserAgent: seen.userAgent } },
      );
    },
  };
}
