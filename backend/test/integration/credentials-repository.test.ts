import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { ensureIndexes } from '../../src/db/indexes.ts';
import { LOCK_THRESHOLD, createCredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import type { CredentialsRepository } from '../../src/modules/users/credentials.repository.ts';
import { openTestDatabases } from '../helpers/mongo.ts';
import type { TestDatabases } from '../helpers/mongo.ts';

let ctx: TestDatabases;
let repository: CredentialsRepository;
const T0 = new Date('2026-11-02T10:00:00.000Z');
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000);

before(async () => {
  ctx = await openTestDatabases();
  await ensureIndexes(ctx.databases);
  repository = createCredentialsRepository(ctx.databases);
});
after(() => ctx.cleanup());

describe('credentials: password', () => {
  it('has nothing for a user who never had credentials', async () => {
    assert.equal(await repository.find(new ObjectId()), null);
  });

  it('stores a rehash without marking a password change, then a change', async () => {
    const userId = new ObjectId();
    await repository.upsertPassword(userId, { passwordHash: 'scrypt$1', legacyHashFingerprint: 'fp-1', passwordChanged: false, now: T0 });
    assert.deepEqual(await repository.find(userId), {
      userId, passwordHash: 'scrypt$1', legacyHashFingerprint: 'fp-1', passwordChangedAt: null, failedLogins: 0, lockedUntil: null, lastLoginAt: null, createdAt: T0, updatedAt: T0,
    });
    await repository.upsertPassword(userId, { passwordHash: 'scrypt$2', legacyHashFingerprint: null, passwordChanged: true, now: minutes(5) });
    const changed = (await repository.find(userId))!;
    assert.equal(changed.passwordHash, 'scrypt$2');
    assert.equal(changed.legacyHashFingerprint, null);
    assert.deepEqual(changed.passwordChangedAt, minutes(5));
    assert.deepEqual(changed.createdAt, T0);
    assert.deepEqual(changed.updatedAt, minutes(5));
  });

  it('keeps the failure counters when the hash is stored', async () => {
    const userId = new ObjectId();
    await repository.recordFailure(userId, T0);
    await repository.upsertPassword(userId, { passwordHash: 'h', legacyHashFingerprint: null, passwordChanged: false, now: minutes(1) });
    assert.equal((await repository.find(userId))!.failedLogins, 1);
  });
});

describe('credentials: progressive lock', () => {
  it('does not lock before the fifth consecutive failure, then 1, 2, 4, 8 and at most 15 minutes', async () => {
    const userId = new ObjectId();
    for (let n = 1; n < LOCK_THRESHOLD; n += 1) {
      assert.deepEqual(await repository.recordFailure(userId, T0), { failedLogins: n, lockedUntil: null });
    }
    const expected = [1, 2, 4, 8, 15, 15, 15];
    for (const [index, lock] of expected.entries()) {
      const now = minutes(index * 100);
      assert.deepEqual(await repository.recordFailure(userId, now), { failedLogins: LOCK_THRESHOLD + index, lockedUntil: new Date(now.getTime() + lock * 60_000) });
    }
    const stored = (await repository.find(userId))!;
    assert.equal(stored.passwordHash, null);
    assert.equal(stored.failedLogins, LOCK_THRESHOLD + expected.length - 1);
    assert.deepEqual(stored.createdAt, T0);
  });

  it('stays capped for a huge number of failures', async () => {
    const userId = new ObjectId();
    await ctx.databases.common().collection('userCredentials').insertOne({ _id: userId, failedLogins: 5000, createdAt: T0, updatedAt: T0 });
    assert.deepEqual(await repository.recordFailure(userId, T0), { failedLogins: 5001, lockedUntil: minutes(15) });
  });

  it('counts concurrent failures exactly', async () => {
    const userId = new ObjectId();
    await Promise.all(Array.from({ length: 12 }, () => repository.recordFailure(userId, T0)));
    const stored = (await repository.find(userId))!;
    assert.equal(stored.failedLogins, 12);
    assert.deepEqual(stored.lockedUntil, minutes(15));
  });

  it('clears the counter and the lock on success, creating the document when needed', async () => {
    const userId = new ObjectId();
    for (let n = 0; n < 6; n += 1) {
      await repository.recordFailure(userId, T0);
    }
    await repository.recordSuccess(userId, minutes(30));
    const stored = (await repository.find(userId))!;
    assert.equal(stored.failedLogins, 0);
    assert.equal(stored.lockedUntil, null);
    assert.deepEqual(stored.lastLoginAt, minutes(30));
    assert.deepEqual(stored.updatedAt, minutes(30));
    assert.deepEqual((await repository.recordFailure(userId, minutes(31))), { failedLogins: 1, lockedUntil: null });
    const fresh = new ObjectId();
    await repository.recordSuccess(fresh, T0);
    assert.deepEqual(await repository.find(fresh), { userId: fresh, passwordHash: null, legacyHashFingerprint: null, passwordChangedAt: null, failedLogins: 0, lockedUntil: null, lastLoginAt: T0, createdAt: T0, updatedAt: T0 });
  });
});

describe('userCredentials validator and indexes', () => {
  it('rejects documents of the wrong shape and has no index besides _id', async () => {
    const collection = ctx.databases.common().collection('userCredentials');
    const base = { failedLogins: 0, createdAt: T0, updatedAt: T0 };
    for (const bad of [{ ...base, failedLogins: -1 }, { ...base, extra: 1 }, { ...base, passwordHash: '' }, { ...base, lockedUntil: 'x' }, { failedLogins: 0 }]) {
      await assert.rejects(collection.insertOne({ _id: new ObjectId(), ...bad }), /validation/i);
    }
    assert.deepEqual((await collection.indexes()).map((index) => index.name), ['_id_']);
  });
});
