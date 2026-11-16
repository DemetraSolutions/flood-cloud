import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '../../src/db/collections.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { LAST_SEEN_RESOLUTION_MS, createStoreKeysRepository } from '../../src/modules/store-keys/store-keys.repository.ts';
import type { StoreKeysRepository } from '../../src/modules/store-keys/store-keys.repository.ts';
import type { NewStoreKey } from '../../src/modules/store-keys/store-keys.types.ts';
import { hashSecret } from '../../src/shared/security/secrets.ts';
import { quietLogger } from '../helpers/indexes.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let repository: StoreKeysRepository;
// Anchored at the real time: documents with a TTL must never be born expired.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const issuer = { userId: new ObjectId(), role: 'PSA' } as const;
let counter = 0;

before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases, COLLECTIONS, quietLogger);
  repository = createStoreKeysRepository(ctx.databases);
});
after(() => ctx.cleanup());

const newKey = (overrides: Partial<NewStoreKey> = {}): NewStoreKey => ({
  groupId: new ObjectId(),
  placeId: new ObjectId(),
  keyHash: hashSecret(`key-${String(counter++)}`),
  hint: 'AbC1',
  activatedAt: NOW,
  activatedBy: issuer,
  installation: { userAgent: 'UA', appVersion: '1', platform: 'p' },
  activationIp: '203.0.113.7',
  ...overrides,
});
const inTransaction = <T>(work: Parameters<typeof ctx.databases.transaction<T>>[0]): Promise<T> => ctx.databases.transaction(work);

describe('the store keys repository (real MongoDB)', () => {
  it('stores a key by its hash, finds it by the hash, and never hands the hash back', async () => {
    const input = newKey();
    const stored = await inTransaction((session) => repository.createKey(input, session));
    assert.equal(stored.status, 'active');
    assert.equal('keyHash' in stored, false);
    const found = (await repository.findByHash(input.keyHash))!;
    assert.deepEqual([found.id, found.placeId, found.hint, found.lastSeenAt, found.lastSeenIp, found.lastSeenUserAgent], [stored.id, input.placeId, 'AbC1', NOW, '203.0.113.7', 'UA']);
    assert.equal(await repository.findByHash(hashSecret('another')), null);
    assert.deepEqual((await repository.findActiveOfPlace(input.groupId, input.placeId))!.id, stored.id);
    assert.equal(await repository.findActiveOfPlace(new ObjectId(), input.placeId), null, 'the group is part of the lookup');
  });

  it('allows one active key per place, in the database, and many revoked ones', async () => {
    const first = newKey();
    await inTransaction((session) => repository.createKey(first, session));
    await assert.rejects(
      () => inTransaction((session) => repository.createKey(newKey({ groupId: first.groupId, placeId: first.placeId }), session)),
      (error: { code?: number }) => error.code === 11000,
    );
    assert.ok(await repository.revokeActiveOfPlace(first.groupId, first.placeId, { at: NOW, by: { kind: 'system' }, reason: 'replaced' }));
    await inTransaction((session) => repository.createKey(newKey({ groupId: first.groupId, placeId: first.placeId }), session));
    assert.equal(await ctx.databases.common().collection('storeKeys').countDocuments({ placeId: first.placeId }), 2);
  });

  it('revokes once: the second revocation of the same key, or of the place, finds nothing to revoke', async () => {
    const input = newKey();
    const { id } = await inTransaction((session) => repository.createKey(input, session));
    const revocation = { at: NOW, by: { kind: 'user', userId: issuer.userId, role: 'SA' }, reason: 'revoked' } as const;
    const before = (await repository.revokeKey(id, revocation))!;
    assert.equal(before.status, 'active', 'the key as it was');
    assert.equal(await repository.revokeKey(id, revocation), null);
    assert.equal(await repository.revokeKey(new ObjectId(), revocation), null);
    assert.equal(await repository.revokeActiveOfPlace(input.groupId, input.placeId, revocation), null);
    const stored = (await repository.findByHash(input.keyHash))!;
    assert.deepEqual([stored.status, stored.revokedAt, stored.revokedBy, stored.revokeReason], ['revoked', NOW, { kind: 'user', userId: issuer.userId, role: 'SA' }, 'revoked']);
    assert.deepEqual(await repository.findLastRevokedOfPlace(input.groupId, input.placeId), { revokedAt: NOW, reason: 'revoked' });
    assert.equal(await repository.findLastRevokedOfPlace(new ObjectId(), input.placeId), null);
    const raw = (await ctx.databases.common().collection('storeKeys').findOne({ _id: id }))!;
    assert.equal(raw['purgeAt'].getTime(), NOW.getTime() + 365 * 86_400_000);
  });

  it('revokes inside the transaction it is given, and a rollback undoes it', async () => {
    const input = newKey();
    await inTransaction((session) => repository.createKey(input, session));
    await assert.rejects(
      () =>
        inTransaction(async (session) => {
          await repository.revokeActiveOfPlace(input.groupId, input.placeId, { at: NOW, by: { kind: 'system' }, reason: 'replaced' }, session);
          throw new Error('abort');
        }),
      /abort/,
    );
    assert.ok(await repository.findActiveOfPlace(input.groupId, input.placeId));
  });

  it('keeps the activation code of a place unique, consumes it once, and does not consume an expired one', async () => {
    const groupId = new ObjectId();
    const placeId = new ObjectId();
    const code = (codeHash: string, expiresIn: number) => ({ groupId, companyId: new ObjectId(), placeId, codeHash, createdBy: issuer, createdAt: NOW, expiresAt: at(expiresIn) });
    await repository.replaceActivationCode(code('a'.repeat(64), 60_000));
    await repository.replaceActivationCode(code('b'.repeat(64), 60_000));
    assert.equal(await ctx.databases.common().collection('storeActivationCodes').countDocuments({ placeId }), 1);
    assert.equal(await inTransaction((session) => repository.consumeActivationCode('a'.repeat(64), NOW, session)), null, 'the replaced code is gone');
    assert.deepEqual((await repository.findPendingActivation(groupId, placeId, NOW))!.expiresAt, at(60_000));
    assert.equal(await repository.findPendingActivation(groupId, placeId, at(60_001)), null, 'expired, though the TTL has not removed it');
    assert.equal(await repository.findPendingActivation(new ObjectId(), placeId, NOW), null);
    assert.equal(await inTransaction((session) => repository.consumeActivationCode('b'.repeat(64), at(60_001), session)), null, 'an expired code is not consumed');
    assert.deepEqual(await inTransaction((session) => repository.consumeActivationCode('b'.repeat(64), NOW, session)), { groupId, placeId, createdBy: issuer });
    assert.equal(await repository.deleteActivationCode(groupId, placeId), false);
  });

  it('records the last contact only when the stored one is a minute old, in the database', async () => {
    const input = newKey();
    const { id } = await inTransaction((session) => repository.createKey(input, session));
    await repository.touch(id, { at: at(LAST_SEEN_RESOLUTION_MS - 1), ip: '198.51.100.1', userAgent: 'New' });
    assert.equal((await repository.findByHash(input.keyHash))!.lastSeenAt.getTime(), NOW.getTime());
    await repository.touch(id, { at: at(LAST_SEEN_RESOLUTION_MS), ip: '198.51.100.1', userAgent: 'New' });
    const seen = (await repository.findByHash(input.keyHash))!;
    assert.deepEqual([seen.lastSeenAt, seen.lastSeenIp, seen.lastSeenUserAgent], [at(LAST_SEEN_RESOLUTION_MS), '198.51.100.1', 'New']);
    await repository.revokeKey(id, { at: NOW, by: { kind: 'system' }, reason: 'revoked' });
    await repository.touch(id, { at: at(10 * LAST_SEEN_RESOLUTION_MS), ip: null, userAgent: null });
    assert.deepEqual((await repository.findByHash(input.keyHash))!.lastSeenAt, at(LAST_SEEN_RESOLUTION_MS), 'a revoked key is not touched');
  });
});
