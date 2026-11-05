import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { MAX_PREVIOUS_REFRESH_HASHES } from '../../src/db/sessions-schema.ts';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { MAX_LISTED_SESSIONS, createSessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import type { NewSession, SessionsRepository } from '../../src/modules/sessions/sessions.repository.ts';
import { hashSecret } from '../../src/shared/security/secrets.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let repository: SessionsRepository;
const sessions = () => ctx.databases.common().collection('sessions');
// Anchored at the real time: sessions have a TTL index and must never be born expired.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
let counter = 0;
const hash = (): string => hashSecret(`token-${String(counter++)}`);

before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases);
  repository = createSessionsRepository(ctx.databases);
});
after(() => ctx.cleanup());

const newSession = (overrides: Partial<NewSession> = {}): NewSession => ({
  userId: new ObjectId(),
  accessTokenHash: hash(),
  accessExpiresAt: at(900_000),
  refreshTokenHash: hash(),
  refreshExpiresAt: at(7 * 86_400_000),
  familyExpiresAt: at(30 * 86_400_000),
  userAgent: 'Fixture/1.0',
  ip: '127.0.0.1',
  now: NOW,
  ...overrides,
});

describe('create and find', () => {
  it('stores the session and finds it by either current hash', async () => {
    const input = newSession();
    const created = await repository.create(input);
    assert.deepEqual(
      [created.userId, created.revokedAt, created.revokeReason, created.lastUsedAt, created.createdAt],
      [input.userId, null, null, NOW, NOW],
    );
    const stored = await sessions().findOne({ _id: created.id });
    assert.deepEqual(stored?.['previousRefreshHashes'], []);
    assert.equal((stored?.['expiresAt'] as Date).getTime(), at(31 * 86_400_000).getTime());
    assert.deepEqual(await repository.findByAccessHash(input.accessTokenHash), created);
    assert.deepEqual(await repository.findByRefreshHash(input.refreshTokenHash), { kind: 'current', session: created });
    assert.equal(await repository.findByAccessHash(hash()), null);
    assert.equal(await repository.findByRefreshHash(hash()), null);
    assert.equal('previousRefreshHashes' in (await repository.findByAccessHash(input.accessTokenHash))!, false);
  });

  it('keeps token hashes unique and validates the document', async () => {
    const first = newSession();
    await repository.create(first);
    await assert.rejects(repository.create(newSession({ accessTokenHash: first.accessTokenHash })), { code: 11000 });
    await assert.rejects(repository.create(newSession({ refreshTokenHash: first.refreshTokenHash })), { code: 11000 });
    await assert.rejects(repository.create(newSession({ accessTokenHash: 'not-a-sha256' })), { code: 121 });
    await assert.rejects(sessions().insertOne({ ...newSession(), extra: true } as never), { code: 121 });
  });

  it('stores a missing user agent and address as null', async () => {
    const created = await repository.create(newSession({ userAgent: null, ip: null }));
    assert.deepEqual([created.userAgent, created.ip], [null, null]);
  });
});

describe('rotate', () => {
  it('moves the current refresh hash into the previous ones and recognizes it afterwards', async () => {
    const created = await repository.create(newSession());
    const next = { accessTokenHash: hash(), accessExpiresAt: at(2_000_000), refreshTokenHash: hash(), refreshExpiresAt: at(9_000_000), now: at(1_000_000) };
    const rotated = await repository.rotate(created.id, created.refreshTokenHash, next);
    assert.deepEqual([rotated?.accessTokenHash, rotated?.refreshTokenHash, rotated?.lastUsedAt, rotated?.refreshExpiresAt], [next.accessTokenHash, next.refreshTokenHash, next.now, next.refreshExpiresAt]);
    assert.equal(rotated !== null && 'previousRefreshHashes' in rotated, false);
    assert.equal(await repository.findByAccessHash(created.accessTokenHash), null);
    const old = await repository.findByRefreshHash(created.refreshTokenHash);
    assert.deepEqual([old?.kind, old?.session.id], ['rotated', created.id]);
    assert.equal((await repository.findByRefreshHash(next.refreshTokenHash))?.kind, 'current');
  });

  it('fails when the presented hash is no longer the current one or the session is revoked', async () => {
    const created = await repository.create(newSession());
    const next = () => ({ accessTokenHash: hash(), accessExpiresAt: at(1), refreshTokenHash: hash(), refreshExpiresAt: at(2), now: at(3) });
    assert.equal(await repository.rotate(created.id, hash(), next()), null);
    assert.ok(await repository.rotate(created.id, created.refreshTokenHash, next()));
    assert.equal(await repository.rotate(created.id, created.refreshTokenHash, next()), null);
    const other = await repository.create(newSession());
    await repository.revoke(other.id, 'test', NOW);
    assert.equal(await repository.rotate(other.id, other.refreshTokenHash, next()), null);
  });

  it('keeps only the last previous hashes', async () => {
    const created = await repository.create(newSession());
    const used: string[] = [];
    let current = created.refreshTokenHash;
    for (let step = 0; step < MAX_PREVIOUS_REFRESH_HASHES + 5; step += 1) {
      const nextRefresh = hash();
      used.push(current);
      assert.ok(await repository.rotate(created.id, current, { accessTokenHash: hash(), accessExpiresAt: at(1), refreshTokenHash: nextRefresh, refreshExpiresAt: at(2), now: at(3) }));
      current = nextRefresh;
    }
    const stored = await sessions().findOne({ _id: created.id });
    assert.deepEqual(stored?.['previousRefreshHashes'], used.slice(-MAX_PREVIOUS_REFRESH_HASHES));
    assert.equal(await repository.findByRefreshHash(used[0]!), null);
    assert.equal((await repository.findByRefreshHash(used.at(-1)!))?.kind, 'rotated');
  });
});

describe('revocation', () => {
  it('revokes a session once', async () => {
    const created = await repository.create(newSession());
    assert.equal(await repository.revoke(created.id, 'logout', at(5)), true);
    assert.equal(await repository.revoke(created.id, 'again', at(6)), false);
    const stored = await repository.findByAccessHash(created.accessTokenHash);
    assert.deepEqual([stored?.revokedAt, stored?.revokeReason], [at(5), 'logout']);
    assert.equal(await repository.revoke(new ObjectId(), 'x', NOW), false);
  });

  it('revokes an owned session only for its owner', async () => {
    const created = await repository.create(newSession());
    assert.equal(await repository.revokeOwned(new ObjectId(), created.id, 'x', NOW), false);
    assert.equal((await repository.findByAccessHash(created.accessTokenHash))?.revokedAt, null);
    assert.equal(await repository.revokeOwned(created.userId, created.id, 'x', NOW), true);
    assert.equal(await repository.revokeOwned(created.userId, created.id, 'x', NOW), false);
  });

  it('revokes every active session of a user, optionally keeping one, and no other user', async () => {
    const userId = new ObjectId();
    const a = await repository.create(newSession({ userId }));
    const b = await repository.create(newSession({ userId }));
    const c = await repository.create(newSession({ userId }));
    const stranger = await repository.create(newSession());
    await repository.revoke(c.id, 'earlier', NOW);
    assert.equal(await repository.revokeAllOfUser(userId, 'passwordChanged', at(9), a.id), 1);
    assert.equal((await repository.findByAccessHash(a.accessTokenHash))?.revokedAt, null);
    assert.deepEqual([(await repository.findByAccessHash(b.accessTokenHash))?.revokeReason, (await repository.findByAccessHash(c.accessTokenHash))?.revokeReason], ['passwordChanged', 'earlier']);
    assert.equal(await repository.revokeAllOfUser(userId, 'logoutAll', at(10)), 1);
    assert.equal(await repository.revokeAllOfUser(userId, 'logoutAll', at(11)), 0);
    assert.equal((await repository.findByAccessHash(stranger.accessTokenHash))?.revokedAt, null);
  });
});

describe('listActive', () => {
  it('lists the active sessions of the user, most recently used first', async () => {
    const userId = new ObjectId();
    const older = await repository.create(newSession({ userId, now: at(1000) }));
    const newer = await repository.create(newSession({ userId, now: at(2000) }));
    const revoked = await repository.create(newSession({ userId }));
    await repository.revoke(revoked.id, 'x', NOW);
    await repository.create(newSession({ userId, refreshExpiresAt: at(500) }));
    await repository.create(newSession({ userId, familyExpiresAt: at(500) }));
    await repository.create(newSession());
    assert.deepEqual((await repository.listActive(userId, at(1000))).map((session) => session.id), [newer.id, older.id]);
  });

  it('lists at most the cap', async () => {
    const userId = new ObjectId();
    for (let index = 0; index < MAX_LISTED_SESSIONS + 3; index += 1) {
      await repository.create(newSession({ userId, now: at(index) }));
    }
    const listed = await repository.listActive(userId, NOW);
    assert.equal(listed.length, MAX_LISTED_SESSIONS);
    assert.equal(listed[0]!.lastUsedAt.getTime(), at(MAX_LISTED_SESSIONS + 2).getTime());
  });
});

describe('touch', () => {
  it('updates the last use only when the stored value is at least a minute old', async () => {
    const created = await repository.create(newSession());
    await repository.touch(created.id, at(30_000));
    assert.equal((await repository.findByAccessHash(created.accessTokenHash))?.lastUsedAt.getTime(), NOW.getTime());
    await repository.touch(created.id, at(60_000));
    assert.equal((await repository.findByAccessHash(created.accessTokenHash))?.lastUsedAt.getTime(), at(60_000).getTime());
    await repository.touch(created.id, at(90_000));
    assert.equal((await repository.findByAccessHash(created.accessTokenHash))?.lastUsedAt.getTime(), at(60_000).getTime());
  });
});

describe('deleteAllOfUser', () => {
  it('deletes every session of the user, revoked or not, with or without a transaction, and no other', async () => {
    const userId = new ObjectId();
    const other = new ObjectId();
    const kept = await repository.create(newSession({ userId: other }));
    const first = await repository.create(newSession({ userId }));
    await repository.create(newSession({ userId }));
    await repository.revoke(first.id, 'test', NOW);
    assert.equal(await repository.deleteAllOfUser(userId), 2);
    assert.equal(await sessions().countDocuments({ userId }), 0);
    await repository.create(newSession({ userId }));
    assert.equal(await ctx.databases.transaction((session) => repository.deleteAllOfUser(userId, session)), 1);
    assert.equal(await repository.deleteAllOfUser(userId), 0);
    assert.equal(await sessions().countDocuments({ _id: kept.id }), 1);
  });

  it('revokes inside a transaction together with other writes', async () => {
    const userId = new ObjectId();
    await repository.create(newSession({ userId }));
    await assert.rejects(
      ctx.databases.transaction(async (session) => {
        assert.equal(await repository.revokeAllOfUser(userId, 'test', NOW, undefined, session), 1);
        throw new Error('abort');
      }),
      /abort/,
    );
    assert.equal(await sessions().countDocuments({ userId, revokedAt: null }), 1);
    assert.equal(await ctx.databases.transaction((session) => repository.revokeAllOfUser(userId, 'test', NOW, undefined, session)), 1);
  });
});
